import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { createSolution, updateSolution } from "@/server/solution-admin";
import { generateSolutionContent } from "@/server/solution-generation";
import { StubProvider } from "@/server/model-router";

/**
 * 集成测试：§33 流水线 → 方案正文生成落库（Phase 8 M3），真连 Neon。
 *
 * 关键：**注入 StubProvider + 逐角色 fixtures**，使整条「流水线 → 映射 → 落库」闭环在无网络、无 API Key
 * 下也完全确定性（不受 .env 里是否配了真实 DeepSeek key 影响），与 research-pipeline 离线测法同构。
 * 锁死：只写 body 分节、保留人工已填节、version++ + ChangeLog(ai:pipeline)、**永不自动发布**、
 * 已发布方案拒绝改写、失败流水线只落已完成部分、无可写内容时不改库。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[solution-generation] DATABASE_URL not set — skipping. Run: npm run test:integration");
}

const runId = `it-solgen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const slugFor = (label: string) => `${label}-${runId.slice(-8)}`.toLowerCase();

const createdSolutionIds: string[] = [];
const createdCaseIds: string[] = [];

async function warmup() {
  for (let i = 0; i < 4; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function newCase(title: string): Promise<string> {
  const c = await prisma.case.create({
    data: { title, industry: "OTHER", stage: "DEEP_CASE" },
    select: { id: true },
  });
  createdCaseIds.push(c.id);
  return c.id;
}

async function newDraftSolution(caseId: string, label: string, body?: Record<string, unknown>): Promise<string> {
  const res = await createSolution(
    { title: `方案 ${label} ${runId}`, slug: slugFor(label), caseId, price: "1999.00", body },
    `human:${runId}`,
  );
  expect(res.status).toBe("ok");
  createdSolutionIds.push(res.solutionId!);
  return res.solutionId!;
}

// 完整放行用的逐角色 fixtures（qa 高分 → complete）。
const PASS_FIXTURES = {
  research: {
    summary: "综述",
    findings: [
      { statement: "市场规模 10 亿", evidenceKind: "FACT", confidence: 90 },
      { statement: "假设良率 80%", evidenceKind: "ASSUMPTION", confidence: 60 },
    ],
  },
  bull: { points: [{ claim: "需求旺盛", evidence: "行业报告", strength: 80 }] },
  bear: { points: [{ claim: "政策不确定", evidence: "草案", severity: 70 }] },
  judge: { verdict: "mixed", rationale: "利弊兼有", confidence: 65 },
  qa: { approved: true, qualityScore: 85, needsHumanReview: false, issues: [] },
};

describeDb("solution content generation (Neon, StubProvider fixtures)", () => {
  beforeAll(async () => {
    await warmup();
  });

  afterAll(async () => {
    await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution
      .deleteMany({ where: { slug: { contains: runId.slice(-8).toLowerCase() } } })
      .catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    if (createdSolutionIds.length) {
      await prisma.changeLog
        .deleteMany({ where: { entityType: "Solution", entityId: { in: createdSolutionIds } } })
        .catch(() => undefined);
    }
    await disconnectPrisma().catch(() => undefined);
  });

  it("generates a DRAFT solution body from the pipeline, preserving human sections + auditing", async () => {
    const caseId = await newCase(`case ${runId}`);
    const id = await newDraftSolution(caseId, "gen-ok", { name: "人工已填的项目名" });

    const res = await generateSolutionContent(id, { provider: new StubProvider(), fixtures: PASS_FIXTURES });
    expect(res.status).toBe("ok");
    expect(res.generation?.pipelineStatus).toBe("complete");
    expect(res.generation?.needsHumanReview).toBe(false);
    expect(res.generation?.wroteSections).toBeGreaterThan(0);
    expect(res.generation?.cost.totalCostUsd).toBeGreaterThanOrEqual(0);

    const row = await prisma.solution.findUnique({ where: { id } });
    const body = row!.body as Record<string, unknown>;
    // 本次映射的分节已落库
    expect(body.bullCase).toBeDefined();
    expect(body.bearCase).toBeDefined();
    expect(body.riskAnalysis).toBeDefined();
    expect(body.unknowns).toBeDefined();
    expect(body.aiAnnotations).toBeDefined();
    // 诚实：绝不臆造财务/来源
    expect(body.costModel).toBeUndefined();
    expect(body.sources).toBeUndefined();
    // 保留人工已填分节（合并而非整体覆盖）
    expect(body.name).toBe("人工已填的项目名");

    // 永不自动发布
    expect(row!.status).toBe("DRAFT");
    expect(row!.publishedAt).toBeNull();
    // version 自增（create=1 → 生成 update=2）
    expect(row!.version).toBe(2);
    // 审计：ChangeLog 由 ai:pipeline 写入
    const aiAudit = await prisma.changeLog.count({
      where: { entityType: "Solution", entityId: id, changedBy: "ai:pipeline" },
    });
    expect(aiAudit).toBeGreaterThanOrEqual(1);
  });

  it("refuses to auto-rewrite an already-PUBLISHED solution (409-blocked)", async () => {
    const caseId = await newCase(`case-pub ${runId}`);
    const id = await newDraftSolution(caseId, "gen-pub");
    const pub = await updateSolution(id, { status: "PUBLISHED" }, `human:${runId}`);
    expect(pub.status).toBe("ok");
    const versionAfterPublish = (await prisma.solution.findUnique({ where: { id } }))!.version;

    const res = await generateSolutionContent(id, { provider: new StubProvider(), fixtures: PASS_FIXTURES });
    expect(res.status).toBe("blocked");
    expect(res.generation).toBeUndefined();
    // 线上正文未被改动：被拒的生成既不改状态、也不自增 version、也不写分节
    const row = (await prisma.solution.findUnique({ where: { id } }))!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.version).toBe(versionAfterPublish);
    expect(((row.body ?? {}) as Record<string, unknown>).bullCase).toBeUndefined();
  });

  it("keeps only the completed portion when the pipeline fails midway (still no publish)", async () => {
    const caseId = await newCase(`case-fail ${runId}`);
    const id = await newDraftSolution(caseId, "gen-fail");

    // bull 产出非法（points 非数组）→ 流水线在 bull 早退 failed；research 已完成部分仍应落库
    const fixtures = {
      ...PASS_FIXTURES,
      bull: { points: "not-an-array" },
    };
    const res = await generateSolutionContent(id, { provider: new StubProvider(), fixtures });
    expect(res.status).toBe("ok");
    expect(res.generation?.pipelineStatus).toBe("failed");
    expect(res.generation?.needsHumanReview).toBe(true);
    expect(res.generation?.reviewReason).toContain("bull");

    const body = (await prisma.solution.findUnique({ where: { id } }))!.body as Record<string, unknown>;
    expect(body.bullCase).toBeUndefined();
    expect(body.unknowns).toBeDefined(); // research 已完成部分保留
    expect(body.aiAnnotations).toBeDefined();
  });

  it("does not touch the row when there is nothing honestly writable (research-stage failure)", async () => {
    const caseId = await newCase(`case-noop ${runId}`);
    const id = await newDraftSolution(caseId, "gen-noop", { name: "只此一节" });

    // research 即非法（summary 空）→ 无任何输出 → 无分节可写 → 不改库
    const fixtures = { ...PASS_FIXTURES, research: { summary: "", findings: [] } };
    const res = await generateSolutionContent(id, { provider: new StubProvider(), fixtures });
    expect(res.status).toBe("ok");
    expect(res.generation?.pipelineStatus).toBe("failed");
    expect(res.generation?.wroteSections).toBe(0);

    const row = await prisma.solution.findUnique({ where: { id } });
    expect(row!.version).toBe(1); // 未自增：确证未写库
    expect((row!.body as Record<string, unknown>).name).toBe("只此一节");
  });

  it("returns not_found for an unknown solution id", async () => {
    const res = await generateSolutionContent("cuid-does-not-exist-000000", {
      provider: new StubProvider(),
      fixtures: PASS_FIXTURES,
    });
    expect(res.status).toBe("not_found");
  });
});
