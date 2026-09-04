import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { recomputeCaseScores, recomputeAllCaseScores } from "@/server/case-scores";
import { getPublicCaseById } from "@/server/cases";
import { CaseScoresSchema, SCORING_RUBRIC_VERSION } from "@/server/scoring";

/**
 * 集成测试：评分持久化与复算（Phase 7 M2）+ 详情页数据层暴露拆解（M3），真连 Neon，不 mock。
 *
 * 验证 recomputeCaseScores 把 scoreInput + evidences 复算成 scoreBreakdown 并同步两个标量；
 * 无 scoreInput 诚实跳过、非法 scoreInput 不写库、复算幂等、recomputeAllCaseScores 汇总自洽；
 * 并验证 getPublicCaseById 把已复算的 scoreBreakdown 透传给详情页（无输入则诚实返回 null）。
 * 一次性夹具 afterAll 全量清理，不污染真库。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn("[case-scores] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-score-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// 工作样例：机会评分 → 88（与 SCORING_V1.md / scoring.test.ts 一致）
const VALID_INPUT = {
  commercialValue: 19,
  marketDemand: 14,
  techMaturity: 13,
  localizationSpace: 9,
  costAdvantage: 9,
  replicability: 9,
  supplyChainMaturity: 4,
  competitionIntensity: 1, // inverse → 贡献 4
  policyEnvironment: 3,
  implementationDifficulty: 1, // inverse → 贡献 4
};
// 证据集：可信度 → 69、关键未知变量 → 2（ASSUMPTION + PREDICTION）
const EVIDENCES = [
  { type: "FACT" as const, statement: "事实A", confidence: 90, sourceUrl: "https://a" },
  { type: "FACT" as const, statement: "事实B", confidence: 70, sourceUrl: "https://b" },
  { type: "ASSUMPTION" as const, statement: "假设C", confidence: 50, sourceUrl: "https://c" },
  { type: "PREDICTION" as const, statement: "预测D", confidence: 50, sourceUrl: null },
];

const ids = { validCase: "", noInputCase: "", invalidCase: "" };

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

describeDb("case scores persistence & recompute (Neon)", () => {
  beforeAll(async () => {
    await warmup();

    // 1) 合法 scoreInput + 证据
    const valid = await prisma.case.create({
      data: {
        title: `评分案例-有效-${runId}`,
        industry: "NEW_ENERGY",
        stage: "DEEP_CASE",
        scoreInput: VALID_INPUT,
      },
    });
    ids.validCase = valid.id;
    for (const e of EVIDENCES) {
      await prisma.evidence.create({ data: { caseId: valid.id, ...e } });
    }

    // 2) 无 scoreInput（应跳过）
    const noInput = await prisma.case.create({
      data: { title: `评分案例-无输入-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE" },
    });
    ids.noInputCase = noInput.id;

    // 3) 非法 scoreInput（commercialValue 越界 99 > max 20）
    const invalid = await prisma.case.create({
      data: {
        title: `评分案例-非法-${runId}`,
        industry: "NEW_ENERGY",
        stage: "DEEP_CASE",
        scoreInput: { ...VALID_INPUT, commercialValue: 99 },
      },
    });
    ids.invalidCase = invalid.id;
  });

  afterAll(async () => {
    await prisma.case
      .deleteMany({ where: { id: { in: [ids.validCase, ids.noInputCase, ids.invalidCase].filter(Boolean) } } })
      .catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("recomputeCaseScores：合法输入 → computed，scoreBreakdown 落库且标量同步", async () => {
    const res = await recomputeCaseScores(ids.validCase);
    expect(res.status).toBe("computed");
    if (res.status !== "computed") return;
    expect(res.scores.opportunityScore).toBe(88);
    expect(res.scores.evidenceConfidence).toBe(69);
    expect(res.scores.unknownVariableCount).toBe(2);
    expect(res.scores.rubricVersion).toBe(SCORING_RUBRIC_VERSION);

    // 从 DB 读回，确认确实持久化（而非只在内存返回）
    const row = await prisma.case.findUnique({
      where: { id: ids.validCase },
      select: { opportunityScore: true, evidenceConfidence: true, scoreBreakdown: true },
    });
    expect(row?.opportunityScore).toBe(88);
    expect(row?.evidenceConfidence).toBe(69);
    const parsed = CaseScoresSchema.safeParse(row?.scoreBreakdown);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.opportunityScore).toBe(88);
    expect(parsed.data.evidenceConfidence).toBe(69);
    expect(parsed.data.unknownVariableCount).toBe(2);
    expect(parsed.data.opportunityBreakdown).toHaveLength(10);
    // breakdown 各维度贡献之和 = 总分（可复算审计线索随库保存）
    const sum = (parsed.data.opportunityBreakdown ?? []).reduce((s, b) => s + b.contribution, 0);
    expect(sum).toBe(88);
  });

  it("recomputeCaseScores：无 scoreInput → skipped，不写库（标量与 breakdown 保持 null）", async () => {
    const res = await recomputeCaseScores(ids.noInputCase);
    expect(res.status).toBe("skipped");
    const row = await prisma.case.findUnique({
      where: { id: ids.noInputCase },
      select: { opportunityScore: true, evidenceConfidence: true, scoreBreakdown: true },
    });
    expect(row?.opportunityScore).toBeNull();
    expect(row?.evidenceConfidence).toBeNull();
    expect(row?.scoreBreakdown).toBeNull();
  });

  it("recomputeCaseScores：非法 scoreInput → invalid + issues，不写库", async () => {
    const res = await recomputeCaseScores(ids.invalidCase);
    expect(res.status).toBe("invalid");
    if (res.status !== "invalid") return;
    expect(res.issues.join(" ")).toContain("commercialValue");
    const row = await prisma.case.findUnique({
      where: { id: ids.invalidCase },
      select: { opportunityScore: true, scoreBreakdown: true },
    });
    expect(row?.scoreBreakdown).toBeNull();
    expect(row?.opportunityScore).toBeNull();
  });

  it("recomputeCaseScores：不存在 id → not_found", async () => {
    const res = await recomputeCaseScores("definitely-not-a-real-case-id");
    expect(res.status).toBe("not_found");
  });

  it("复算幂等：连跑两次得到完全相同的 scoreBreakdown", async () => {
    await recomputeCaseScores(ids.validCase);
    const a = await prisma.case.findUnique({ where: { id: ids.validCase }, select: { scoreBreakdown: true } });
    await recomputeCaseScores(ids.validCase);
    const b = await prisma.case.findUnique({ where: { id: ids.validCase }, select: { scoreBreakdown: true } });
    expect(a?.scoreBreakdown).toEqual(b?.scoreBreakdown);
  });

  it("M3 详情页数据层：getPublicCaseById 暴露已复算的 scoreBreakdown", async () => {
    await recomputeCaseScores(ids.validCase); // 确保库里已有拆解
    const res = await getPublicCaseById(ids.validCase, false); // DEEP_CASE 公开、非 DEMO
    expect(res.status).toBe("found");
    if (res.status !== "found") return;
    const sb = res.data.scoreBreakdown;
    expect(sb).not.toBeNull();
    expect(sb?.opportunityScore).toBe(88);
    expect(sb?.evidenceConfidence).toBe(69);
    expect(sb?.unknownVariableCount).toBe(2);
    expect(sb?.opportunityBreakdown).toHaveLength(10);
    const sum = (sb?.opportunityBreakdown ?? []).reduce((s, b) => s + b.contribution, 0);
    expect(sum).toBe(88);
    // 标量与拆解一致（都来自同一次复算）
    expect(res.data.opportunityScore).toBe(88);
  });

  it("M3 详情页数据层：无评分输入的公开案例 scoreBreakdown 诚实为 null", async () => {
    const res = await getPublicCaseById(ids.noInputCase, false);
    expect(res.status).toBe("found");
    if (res.status !== "found") return;
    expect(res.data.scoreBreakdown).toBeNull();
    expect(res.data.opportunityScore).toBeNull();
  });

  it("recomputeAllCaseScores：汇总自洽且覆盖各状态", async () => {
    const summary = await recomputeAllCaseScores();
    // 计数自洽：各状态之和 = 总数
    expect(
      summary.computed + summary.skipped + summary.invalid + summary.notFound + summary.error,
    ).toBe(summary.total);
    // 我们的三个夹具应分别落到 computed / skipped / invalid
    expect(summary.total).toBeGreaterThanOrEqual(3);
    const byId = Object.fromEntries(summary.results.map((r) => [r.caseId, r.status]));
    expect(byId[ids.validCase]).toBe("computed");
    expect(byId[ids.noInputCase]).toBe("skipped");
    expect(byId[ids.invalidCase]).toBe("invalid");
    expect(summary.error).toBe(0);
  });
});
