import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  getReviewQueue,
  PENDING_CASE_STAGES,
  PENDING_SOLUTION_STATUS,
} from "@/server/admin-review";
import { DEMO_SOURCE_TYPE } from "@/server/demo";

/**
 * 集成测试：后台「审核发布队列」只读聚合 getReviewQueue（Phase 13 M6），真连 Neon，不 mock。
 *
 * 队列存在的意义 = 把散落在两张长列表里的"等人拍板"项汇成一处，且发布缺口口径与真实发布守卫一致。
 * 故本测试锁：
 *   ① 只收 UNDER_HUMAN_REVIEW 方案（PUBLISHED / DRAFT 不入）；每条就地给出 publishBlockers（复用守卫）。
 *   ② 只收内部阶段（CANDIDATE / KEY_RESEARCH）案例（DEEP_CASE+ 已公开，不入）；带证据数/评分标量。
 *   ③ 方案 isDemo 由挂靠案例 sourceType 判定；行业枚举映射为中文名（非字面量）。
 *   ④ updatedAt 倒序不变式 + total≥items + truncated 自洽。
 * 夹具 afterAll 按外键序清理（order→solution→case + changeLog + runId 兜底）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[admin-review] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-admrev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
function trackCase(id?: string) {
  if (id) createdCaseIds.push(id);
}
function trackSol(id?: string) {
  if (id) createdSolutionIds.push(id);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100);

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

describeDb("admin review queue read-layer (Neon)", () => {
  beforeAll(async () => {
    await warmup();

    // A：真实案例 + UNDER_HUMAN_REVIEW 方案（未定价 → 有发布缺口）
    const caseA = await prisma.case.create({
      data: { title: `队列-审核A-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
    });
    trackCase(caseA.id);
    const solA = await prisma.solution.create({
      data: { title: `待审-未定价-${runId}`, slug: slug(`it-admrev-solA-${runId}`), caseId: caseA.id, status: PENDING_SOLUTION_STATUS, currency: "CNY", riskDomains: [], needsProfessionalReview: false },
    });
    trackSol(solA.id);

    // B：真实案例 + UNDER_HUMAN_REVIEW 方案（已定价、无高风险 → 就绪）
    const caseB = await prisma.case.create({
      data: { title: `队列-审核B-${runId}`, industry: "OTHER", stage: "DEEP_CASE", sourceType: "MANUAL" },
    });
    trackCase(caseB.id);
    const solB = await prisma.solution.create({
      data: { title: `待审-就绪-${runId}`, slug: slug(`it-admrev-solB-${runId}`), caseId: caseB.id, status: PENDING_SOLUTION_STATUS, price: "1999.00", currency: "CNY", riskDomains: [], needsProfessionalReview: false, unknowns: { create: [{ name: `u-${runId}` }] } },
    });
    trackSol(solB.id);

    // C：DEMO 案例 + UNDER_HUMAN_REVIEW 方案（验证 isDemo 由关联案例判定 + 涉高风险未确认 → 缺口点名领域）
    const caseC = await prisma.case.create({
      data: { title: `队列-审核C-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: DEMO_SOURCE_TYPE },
    });
    trackCase(caseC.id);
    const solC = await prisma.solution.create({
      data: { title: `待审-DEMO高风险-${runId}`, slug: slug(`it-admrev-solC-${runId}`), caseId: caseC.id, status: PENDING_SOLUTION_STATUS, price: "88.00", currency: "CNY", riskDomains: ["法律"], needsProfessionalReview: false },
    });
    trackSol(solC.id);

    // 干扰项：同案例下一张 DRAFT 与一张 PUBLISHED 方案，均不应入队。
    const solDraft = await prisma.solution.create({
      data: { title: `干扰-草稿-${runId}`, slug: slug(`it-admrev-draft-${runId}`), caseId: caseA.id, status: "DRAFT", currency: "CNY" },
    });
    trackSol(solDraft.id);
    const solPub = await prisma.solution.create({
      data: { title: `干扰-已发布-${runId}`, slug: slug(`it-admrev-pub-${runId}`), caseId: caseB.id, status: "PUBLISHED", price: "10.00", currency: "CNY", publishedAt: new Date() },
    });
    trackSol(solPub.id);

    // D：内部阶段 CANDIDATE 案例 + 2 条证据（入队）
    const caseD = await prisma.case.create({
      data: { title: `队列-候选D-${runId}`, industry: "OTHER", stage: "CANDIDATE", sourceType: "MANUAL", evidences: { create: [{ type: "FACT", statement: `e1-${runId}` }, { type: "ASSUMPTION", statement: `e2-${runId}` }] } },
    });
    trackCase(caseD.id);

    // E：内部阶段 KEY_RESEARCH 案例、DEMO 夹具（入队且 isDemo=true）
    const caseE = await prisma.case.create({
      data: { title: `队列-重点研究E-${runId}`, industry: "NEW_ENERGY", stage: "KEY_RESEARCH", sourceType: DEMO_SOURCE_TYPE },
    });
    trackCase(caseE.id);

    // 干扰项：已公开阶段案例，不应入队。
    const casePub = await prisma.case.create({
      data: { title: `干扰-已公开案例-${runId}`, industry: "OTHER", stage: "DEEP_CASE", sourceType: "MANUAL" },
    });
    trackCase(casePub.id);
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { solutionId: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.evidence.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog.deleteMany({ where: { entityId: { in: [...createdSolutionIds, ...createdCaseIds] } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("① 只收 UNDER_HUMAN_REVIEW 方案，且就地给出与守卫一致的发布缺口", async () => {
    const data = await getReviewQueue();
    const byTitle = (frag: string) => data.solutions.find((s) => s.title.includes(frag));

    const a = byTitle("待审-未定价");
    const b = byTitle("待审-就绪");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // 未定价方案 → 命中价格缺口；就绪方案 → 无缺口。
    expect(a!.publishBlockers.join("；")).toContain("价格");
    expect(b!.publishBlockers).toEqual([]);
    expect(b!.unknownVariableCount).toBe(1);
    expect(b!.priceDisplay).toBe("¥1999.00");

    // DRAFT / PUBLISHED 干扰项绝不入队。
    expect(byTitle("干扰-草稿")).toBeUndefined();
    expect(byTitle("干扰-已发布")).toBeUndefined();

    // 所有入队方案状态必为待审核态。
    expect(data.solutions.every((s) => s.status === PENDING_SOLUTION_STATUS)).toBe(true);
  });

  it("② 只收内部阶段案例，带证据数/评分标量；已公开阶段不入队", async () => {
    const data = await getReviewQueue();
    const byTitle = (frag: string) => data.cases.find((c) => c.title.includes(frag));

    const d = byTitle("队列-候选D");
    expect(d).toBeTruthy();
    expect(PENDING_CASE_STAGES as readonly string[]).toContain(d!.stage);
    expect(d!.evidenceCount).toBe(2);
    expect(byTitle("队列-重点研究E")).toBeTruthy();
    // 已公开阶段（DEEP_CASE 干扰项）不入队。
    expect(byTitle("干扰-已公开案例")).toBeUndefined();
    expect(data.cases.every((c) => (PENDING_CASE_STAGES as readonly string[]).includes(c.stage))).toBe(true);
  });

  it("③ 方案 isDemo 由挂靠案例判定；行业枚举映射为中文名（非字面量）", async () => {
    const data = await getReviewQueue();
    const c = data.solutions.find((s) => s.title.includes("待审-DEMO高风险"));
    expect(c).toBeTruthy();
    expect(c!.isDemo).toBe(true);
    expect(c!.industryName).not.toBe("NEW_ENERGY");
    expect(c!.industryName.length).toBeGreaterThan(0);
    // 涉高风险但未勾专业确认 → 缺口点名领域数量与名称。
    expect(c!.publishBlockers.join("；")).toContain("1 个高风险领域");
    expect(c!.publishBlockers.join("；")).toContain("法律");
    // 真实（非 DEMO）案例上的待审方案 isDemo=false。
    const a = data.solutions.find((s) => s.title.includes("待审-未定价"));
    expect(a!.isDemo).toBe(false);
  });

  it("④ updatedAt 倒序不变式 + total≥items + truncated 自洽", async () => {
    const data = await getReviewQueue();
    for (const [rows, total, truncated] of [
      [data.solutions, data.solutionTotal, data.solutionsTruncated],
      [data.cases, data.caseTotal, data.casesTruncated],
    ] as const) {
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].updatedAt.getTime()).toBeGreaterThanOrEqual(rows[i].updatedAt.getTime());
      }
      expect(total).toBeGreaterThanOrEqual(rows.length);
      expect(truncated).toBe(total > rows.length);
    }
    // 至少建了 3 待审方案 + 2 内部阶段案例。
    expect(data.solutionTotal).toBeGreaterThanOrEqual(3);
    expect(data.caseTotal).toBeGreaterThanOrEqual(2);
  });
});
