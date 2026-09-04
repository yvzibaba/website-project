import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { ChangeAction } from "@prisma/client";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  createCase,
  updateCase,
  deleteCase,
  addCaseEvidence,
  removeCaseEvidence,
} from "@/server/case-admin";
import { getPublicCaseById } from "@/server/cases";
import { SCORING_RUBRIC_VERSION } from "@/server/scoring";

/**
 * 集成测试：案例与证据的数据层 CRUD（Phase 7 M5），真连 Neon，不 mock。
 *
 * 覆盖：createCase（最小/带评分内联证据/非法/评分输入非法）、updateCase（version 自增 +
 * ChangeLog、空 patch 拒绝、不存在 not_found）、deleteCase（挂 PUBLISHED 方案时 blocked、
 * 否则级联删除）、addCaseEvidence / removeCaseEvidence（联动复算可信度），
 * 以及每个写操作都落 ChangeLog 审计（宪法第 13 条）。一次性夹具 afterAll 全量清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[case-admin] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// 与 SCORING_V1 / scoring.test / case-scores.test 一致的黄金工作样例：机会 88 / 可信度 69 / 未知 2
const VALID_INPUT = {
  commercialValue: 19,
  marketDemand: 14,
  techMaturity: 13,
  localizationSpace: 9,
  costAdvantage: 9,
  replicability: 9,
  supplyChainMaturity: 4,
  competitionIntensity: 1,
  policyEnvironment: 3,
  implementationDifficulty: 1,
};
const GOLD_EVIDENCES = [
  { type: "FACT" as const, statement: "事实A", confidence: 90, sourceUrl: "https://a" },
  { type: "FACT" as const, statement: "事实B", confidence: 70, sourceUrl: "https://b" },
  { type: "ASSUMPTION" as const, statement: "假设C", confidence: 50, sourceUrl: "https://c" },
  { type: "PREDICTION" as const, statement: "预测D", confidence: 50 },
];

const createdCaseIds: string[] = [];
function track(id?: string) {
  if (id) createdCaseIds.push(id);
}

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

function countChanges(caseId: string, action: ChangeAction) {
  return prisma.changeLog.count({ where: { entityType: "Case", entityId: caseId, action } });
}

describeDb("case & evidence admin CRUD (Neon)", () => {
  beforeAll(async () => {
    await warmup();
  });

  afterAll(async () => {
    // Solution.caseId 默认 Restrict：先删方案，再删案例（级联证据/能力），最后清审计
    await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog.deleteMany({ where: { entityId: { in: createdCaseIds } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("createCase 最小：建 CANDIDATE 案例 + 落 CREATE 审计，未带评分则 recompute=none", async () => {
    const res = await createCase({ title: `最小案例-${runId}`, industry: "NEW_ENERGY" }, "human:tester");
    expect(res.status).toBe("ok");
    expect(res.recompute).toBe("none");
    track(res.caseId);
    const row = await prisma.case.findUnique({ where: { id: res.caseId! } });
    expect(row?.stage).toBe("CANDIDATE");
    expect(row?.version).toBe(1);
    expect(row?.opportunityScore).toBeNull();
    expect(await countChanges(res.caseId!, "CREATE")).toBe(1);
  });

  it("createCase 带 scoreInput + 内联证据：computed 88/69/2，DEEP_CASE 详情页可见拆解", async () => {
    const res = await createCase(
      {
        title: `完整案例-${runId}`,
        industry: "NEW_ENERGY",
        stage: "DEEP_CASE",
        scoreInput: VALID_INPUT,
        evidences: GOLD_EVIDENCES,
      },
      "ai:decomposer",
    );
    expect(res.status).toBe("ok");
    expect(res.recompute).toBe("computed");
    track(res.caseId);

    const row = await prisma.case.findUnique({ where: { id: res.caseId! } });
    expect(row?.opportunityScore).toBe(88);
    expect(row?.evidenceConfidence).toBe(69);
    expect(await prisma.evidence.count({ where: { caseId: res.caseId! } })).toBe(4);

    const detail = await getPublicCaseById(res.caseId!, false);
    expect(detail.status).toBe("found");
    if (detail.status !== "found") return;
    expect(detail.data.scoreBreakdown?.opportunityScore).toBe(88);
    expect(detail.data.scoreBreakdown?.evidenceConfidence).toBe(69);
    expect(detail.data.scoreBreakdown?.rubricVersion).toBe(SCORING_RUBRIC_VERSION);
    expect(detail.data.evidences).toHaveLength(4);
  });

  it("createCase 非法入参（行业越界）→ invalid + fieldErrors，不落库", async () => {
    const res = await createCase({ title: `坏案例-${runId}`, industry: "NOT_A_REAL_INDUSTRY" });
    expect(res.status).toBe("invalid");
    expect(res.fieldErrors?.industry).toBeDefined();
    expect(await prisma.case.count({ where: { title: `坏案例-${runId}` } })).toBe(0);
  });

  it("createCase 评分输入越界：案例仍建成，但 recompute=invalid、无 breakdown（不编造）", async () => {
    const res = await createCase({
      title: `坏分案例-${runId}`,
      industry: "NEW_ENERGY",
      scoreInput: { ...VALID_INPUT, commercialValue: 99 },
    });
    expect(res.status).toBe("ok");
    expect(res.recompute).toBe("invalid");
    track(res.caseId);
    const row = await prisma.case.findUnique({ where: { id: res.caseId! } });
    expect(row?.scoreBreakdown).toBeNull();
    expect(row?.opportunityScore).toBeNull();
  });

  it("updateCase：改标题 version 自增 + UPDATE 审计；空 patch → invalid；不存在 → not_found", async () => {
    const made = await createCase({ title: `待改案例-${runId}`, industry: "NEW_ENERGY" });
    track(made.caseId);

    const upd = await updateCase(made.caseId!, { title: `已改标题-${runId}`, stage: "DEEP_CASE" }, "human:editor");
    expect(upd.status).toBe("ok");
    const row = await prisma.case.findUnique({ where: { id: made.caseId! } });
    expect(row?.title).toBe(`已改标题-${runId}`);
    expect(row?.stage).toBe("DEEP_CASE");
    expect(row?.version).toBe(2); // 自增
    expect(await countChanges(made.caseId!, "UPDATE")).toBe(1);

    const empty = await updateCase(made.caseId!, {});
    expect(empty.status).toBe("invalid");

    const missing = await updateCase("nope-not-a-cuid", { title: "x" });
    expect(missing.status).toBe("not_found");
  });

  it("addCaseEvidence / removeCaseEvidence：可信度随证据集联动复算变化", async () => {
    // 起点：3 条证据（两条 FACT 有源 + 一条 ASSUMPTION 有源），配 VALID_INPUT
    const made = await createCase({
      title: `证据联动-${runId}`,
      industry: "NEW_ENERGY",
      stage: "DEEP_CASE",
      scoreInput: VALID_INPUT,
      evidences: GOLD_EVIDENCES.slice(0, 3), // 3 条，全有源、无 PREDICTION
    });
    expect(made.recompute).toBe("computed");
    track(made.caseId);
    const before = await prisma.case.findUnique({ where: { id: made.caseId! }, select: { evidenceConfidence: true } });

    const added = await addCaseEvidence(made.caseId!, GOLD_EVIDENCES[3], "human:editor"); // 追加无源 PREDICTION
    expect(added.status).toBe("ok");
    expect(added.recompute).toBe("computed");
    const mid = await prisma.case.findUnique({ where: { id: made.caseId! }, select: { evidenceConfidence: true } });
    expect(await prisma.evidence.count({ where: { caseId: made.caseId! } })).toBe(4);
    expect(mid?.evidenceConfidence).not.toBe(before?.evidenceConfidence); // 无源证据应拉低可信度

    const removed = await removeCaseEvidence(added.evidenceId!, "human:editor");
    expect(removed.status).toBe("ok");
    expect(removed.recompute).toBe("computed");
    const after = await prisma.case.findUnique({ where: { id: made.caseId! }, select: { evidenceConfidence: true } });
    expect(after?.evidenceConfidence).toBe(before?.evidenceConfidence); // 回到起点
    expect(await prisma.evidence.count({ where: { caseId: made.caseId! } })).toBe(3);
    expect(await countChanges(made.caseId!, "UPDATE")).toBe(2); // add + remove 各一条
  });

  it("deleteCase：挂 PUBLISHED 方案时 blocked；撤方案后成功并级联删证据", async () => {
    const made = await createCase({
      title: `待删案例-${runId}`,
      industry: "NEW_ENERGY",
      stage: "DEEP_CASE",
      evidences: [{ type: "FACT", statement: "将被级联删除的证据" }],
    });
    track(made.caseId);
    const sol = await prisma.solution.create({
      data: { title: `挂案方案-${runId}`, slug: `it-adm-${runId}`, caseId: made.caseId!, status: "PUBLISHED" },
    });

    const blocked = await deleteCase(made.caseId!, "human:admin");
    expect(blocked.status).toBe("blocked");
    expect(blocked.fieldErrors?.solutions).toBeDefined();
    expect(await prisma.case.findUnique({ where: { id: made.caseId! } })).not.toBeNull();

    await prisma.solution.delete({ where: { id: sol.id } });
    const ok = await deleteCase(made.caseId!, "human:admin");
    expect(ok.status).toBe("ok");
    expect(await prisma.case.findUnique({ where: { id: made.caseId! } })).toBeNull();
    expect(await prisma.evidence.count({ where: { caseId: made.caseId! } })).toBe(0); // 级联
    expect(await countChanges(made.caseId!, "DELETE")).toBe(1);
  });

  it("deleteCase：不存在 id → not_found", async () => {
    const res = await deleteCase("nope-not-a-cuid");
    expect(res.status).toBe("not_found");
  });
});
