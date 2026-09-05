import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { runSandboxModel } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { buildSandboxSolutionDraft } from "@/lib/sandbox-solution";
import { persistSandboxSolutionDraft } from "@/server/sandbox-solution-store";

/**
 * 集成测试（真连 Neon，中途重构 R8.2）：证「沙盘结果 → 产业方案 DRAFT」这条**商业闭环第一块**在真库里落地。
 *
 * 刻意走**完整引擎链**造一份真草案（而非手搓对象）：这样落库的 Decimal 串就是 App 真正会上行的那批，
 * 能捕获单测抓不到的**列精度 / JSONB / 外键 / 级联 / unknownVariableCount 同步 / ChangeLog** 问题。
 * 断言：① 成功草案 + 真案例 → 建成 DRAFT Solution（强制 status=DRAFT、body 落 JSONB、财务 + 关键未知挂上、
 *   计数与审计齐）；② 结构良好但不存在的 caseId → invalid.caseId，绝不 500、绝不留半脏 Solution。
 * 隔离：runId 唯一前缀；afterAll 按外键序清理（order→solution→case + changeLog 兜底）。无 DATABASE_URL 自动 skip。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[sandbox-solution-store] DATABASE_URL not set — integration tests will be skipped.");
}

const runId = `it-sbxsol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
const actor = `human:${runId}`;

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** 造一份真草案（引擎链：resolve→run→tech→tornado→view→draft）。返回 calc/vm/draft 便于断言逐字一致。 */
function buildRealDraft(price: string | undefined) {
  const layers = {};
  const resolved = resolveSandbox(layers);
  const calc = runSandboxModel(layers);
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({ layers });
  const discountRate = (resolved.numeric["finance.discountRate"] ?? 8) / 100;
  const vm = buildSandboxViewModel({
    calc,
    tech: tech && tech.ok ? tech.firstYear : null,
    tornado,
    discountRate,
  });
  const draft = buildSandboxSolutionDraft({ calc, vm, regionName: "山西", price, currency: "CNY" });
  return { calc, vm, draft };
}

describeDb("sandbox-solution-store · 草案→DRAFT Solution（Neon Postgres）", () => {
  beforeAll(async () => {
    for (let i = 0; i < 4; i++) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  });

  afterAll(async () => {
    await prisma.order
      .deleteMany({ where: { solutionId: { in: createdSolutionIds } } })
      .catch(() => undefined);
    await prisma.solution
      .deleteMany({ where: { id: { in: createdSolutionIds } } })
      .catch(() => undefined);
    await prisma.solution
      .deleteMany({ where: { caseId: { in: createdCaseIds } } })
      .catch(() => undefined);
    await prisma.case
      .deleteMany({ where: { id: { in: createdCaseIds } } })
      .catch(() => undefined);
    await prisma.case
      .deleteMany({ where: { title: { contains: runId } } })
      .catch(() => undefined);
    await prisma.changeLog
      .deleteMany({ where: { entityId: { in: [...createdSolutionIds, ...createdCaseIds] } } })
      .catch(() => undefined);
    await disconnectPrisma();
  });

  it("真草案 + 真案例 → 建成 DRAFT Solution：强制草稿态、body 落 JSONB、财务/未知挂上、计数与审计齐", async () => {
    const { draft } = buildRealDraft("18000.00");
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const c = await prisma.case.create({
      data: { title: `导出桥-真案例-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
    });
    createdCaseIds.push(c.id);

    const res = await persistSandboxSolutionDraft(
      {
        caseId: c.id,
        title: draft.title,
        slug: sanitizeSlug(`it-sbxsol-${runId}`),
        summary: draft.summary,
        body: draft.body,
        riskDomains: draft.riskDomains,
        needsProfessionalReview: draft.needsProfessionalReview,
        price: draft.price,
        currency: draft.currency,
        financials: draft.financials,
        unknowns: draft.unknowns,
        publishBlockers: draft.publishBlockers,
      },
      actor,
    );

    expect(res.status).toBe("ok");
    expect(res.solutionId).toBeTruthy();
    createdSolutionIds.push(res.solutionId!);
    expect(res.financialCount).toBeGreaterThanOrEqual(1);
    expect(res.unknownCount).toBeGreaterThanOrEqual(1);
    expect(res.publishBlockers?.length).toBeGreaterThan(0); // 原样回显给人

    const sol = await prisma.solution.findUnique({
      where: { id: res.solutionId! },
      include: { financials: true, unknowns: true },
    });
    expect(sol).not.toBeNull();
    expect(sol!.status).toBe("DRAFT"); // createSolution 强制，绝不因导出即上架
    expect(sol!.caseId).toBe(c.id);
    expect(sol!.needsProfessionalReview).toBe(true);
    expect(Number(sol!.price)).toBeCloseTo(18000, 2);
    expect(sol!.currency).toBe("CNY");
    expect(sol!.riskDomains).toEqual(expect.arrayContaining(["投资", "能源", "政策"]));
    // body 逐字落到 JSONB（不重算）：搬运的 roi 节存在
    const body = sol!.body as Record<string, unknown> | null;
    expect(body).toBeTruthy();
    expect(typeof body!.roi).toBe("string");

    // 财务 Decimal 与草案逐字对齐（capex→Decimal(14,2)、roiPct/irrPct→Decimal(8,4)、payback→(8,2)）
    expect(sol!.financials.length).toBe(draft.financials.length);
    const fin = sol!.financials[0];
    expect(Number(fin.capex)).toBeCloseTo(3524500, 0);
    expect(fin.calcRef).toBe("model@1.0.0");

    // 关键未知落库 + unknownVariableCount 实时同步（addSolutionUnknown 内部）
    expect(sol!.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(sol!.unknownVariableCount).toBe(sol!.unknowns.length);

    // CREATE 审计（ChangeLog）由 createSolution 写入
    const logs = await prisma.changeLog.findMany({
      where: { entityType: "Solution", entityId: sol!.id, action: "CREATE" },
    });
    expect(logs.length).toBe(1);
    expect(logs[0].changedBy).toBe(actor);
  });

  it("结构良好但不存在的 caseId → invalid.caseId（外键预检兜住），绝不 500、绝不建半脏 Solution", async () => {
    const { draft } = buildRealDraft(undefined);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    // 合法 cuid 形状但不存在
    const fakeCaseId = "c" + Math.random().toString(36).slice(2, 26);
    const before = await prisma.solution.count();

    const res = await persistSandboxSolutionDraft(
      {
        caseId: fakeCaseId,
        title: draft.title,
        slug: sanitizeSlug(`it-sbxsol-bogus-${runId}`),
        financials: draft.financials,
        unknowns: draft.unknowns,
        publishBlockers: draft.publishBlockers,
      },
      actor,
    );

    expect(res.status).toBe("invalid");
    expect(res.fieldErrors?.caseId?.length).toBeGreaterThan(0);
    expect(res.solutionId).toBeUndefined();

    const after = await prisma.solution.count();
    expect(after).toBe(before); // 未落任何 Solution 行
  });

  it("未定价草案 → 仍存 DRAFT（price null），但发布阻塞清单点名『尚未定价』交人工", async () => {
    const { draft } = buildRealDraft(undefined);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const c = await prisma.case.create({
      data: { title: `导出桥-未定价-${runId}`, industry: "OTHER", stage: "DEEP_CASE", sourceType: "MANUAL" },
    });
    createdCaseIds.push(c.id);

    const res = await persistSandboxSolutionDraft(
      {
        caseId: c.id,
        title: draft.title,
        slug: sanitizeSlug(`it-sbxsol-noprice-${runId}`),
        body: draft.body,
        riskDomains: draft.riskDomains,
        needsProfessionalReview: draft.needsProfessionalReview,
        // price 省略 → 未定价
        currency: draft.currency,
        financials: draft.financials,
        unknowns: draft.unknowns,
        publishBlockers: draft.publishBlockers,
      },
      actor,
    );
    expect(res.status).toBe("ok");
    createdSolutionIds.push(res.solutionId!);

    const sol = await prisma.solution.findUnique({ where: { id: res.solutionId! } });
    expect(sol!.price).toBeNull();
    expect(sol!.status).toBe("DRAFT");
    // 阻塞清单里确有价格相关项（R8.1 draft 生成，编排层原样回显）
    expect(
      (res.publishBlockers ?? []).some((b) => b.includes("价格")),
    ).toBe(true);
  });
});
