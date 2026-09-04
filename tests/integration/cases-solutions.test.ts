import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { listPublicCases, getPublicCaseById } from "@/server/cases";
import { listPublishedSolutions, getPublishedSolutionById } from "@/server/solutions";
import { DEMO_SOURCE_TYPE } from "@/server/demo";

/**
 * 集成测试：案例 / 方案数据层（真连 Neon，不 mock）。
 *
 * 用一次性临时数据验证公开可见性、DEMO 过滤、分页、详情判别联合，afterAll 全量清理，
 * 不污染真库（与 db-smoke 同策略）。断言以"我创建的行是否在结果中"为准，
 * 对库里其它行（如 seed 的 DEMO）保持鲁棒。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn("[cases-solutions] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const ids = {
  region: "",
  capability: "",
  businessModel: "",
  realCase: "",
  demoCase: "",
  candidateCase: "",
  publishedSolution: "",
  draftSolution: "",
};

/** 预热：Neon 冷启动首连可能超时。 */
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

describeDb("cases / solutions data layer (Neon)", () => {
  beforeAll(async () => {
    await warmup();
    const region = await prisma.region.create({ data: { name: `测试地区-${runId}`, country: "CN" } });
    ids.region = region.id;
    const cap = await prisma.techCapability.create({ data: { name: `测试能力-${runId}`, category: "测试" } });
    ids.capability = cap.id;
    const bm = await prisma.businessModel.create({
      data: { name: `测试商业模式-${runId}`, revenueStreams: ["a"], costStructure: ["b"] },
    });
    ids.businessModel = bm.id;

    // 公开的真实深度案例
    const real = await prisma.case.create({
      data: {
        title: `真实深度案例-${runId}`,
        industry: "NEW_ENERGY",
        regionId: region.id,
        businessModelId: bm.id,
        sourceType: "新闻",
        summary: "集成测试用真实案例",
        stage: "DEEP_CASE",
        opportunityScore: 70,
        evidenceConfidence: 55,
      },
    });
    ids.realCase = real.id;
    await prisma.evidence.create({ data: { caseId: real.id, type: "FACT", statement: "事实A", confidence: 60 } });
    await prisma.evidence.create({ data: { caseId: real.id, type: "PREDICTION", statement: "预测B", confidence: 20 } });
    await prisma.caseCapability.create({ data: { caseId: real.id, capabilityId: cap.id, relevance: 80 } });

    // DEMO 深度案例
    const demo = await prisma.case.create({
      data: {
        title: `【DEMO】演示案例-${runId}`,
        industry: "INDUSTRIAL_MANUFACTURING",
        regionId: region.id,
        sourceType: DEMO_SOURCE_TYPE,
        stage: "DEEP_CASE",
      },
    });
    ids.demoCase = demo.id;

    // 内部阶段案例（不应公开）
    const cand = await prisma.case.create({
      data: { title: `候选案例-${runId}`, industry: "NEW_ENERGY", sourceType: "新闻", stage: "CANDIDATE" },
    });
    ids.candidateCase = cand.id;

    // 已发布方案（挂在真实案例下）
    const pub = await prisma.solution.create({
      data: {
        title: `已发布方案-${runId}`,
        slug: `it-sol-${runId}`,
        caseId: real.id,
        status: "PUBLISHED",
        summary: "集成测试方案",
        price: "1999.00",
        currency: "CNY",
        publishedAt: new Date(),
        opportunityScore: 68,
        evidenceConfidence: 50,
        riskDomains: ["能源", "投资"],
        needsProfessionalReview: true,
      },
    });
    ids.publishedSolution = pub.id;
    await prisma.solutionFinancial.create({
      data: { solutionId: pub.id, capex: "1000000", roiPct: "12.5", paybackYears: "4.2", currency: "CNY", calcRef: "it-calc" },
    });
    await prisma.unknownVariable.create({
      data: { solutionId: pub.id, name: "电价政策", impact: "影响回收期", severity: 70 },
    });

    // 草稿方案（不应公开）
    const draft = await prisma.solution.create({
      data: { title: `草稿方案-${runId}`, slug: `it-draft-${runId}`, caseId: real.id, status: "DRAFT" },
    });
    ids.draftSolution = draft.id;
  }, 120_000);

  afterAll(async () => {
    // 先删方案（Solution.caseId 为必需关系，默认 Restrict），再删案例（级联证据/能力），最后删引用数据
    await prisma.solution.deleteMany({ where: { id: { in: [ids.publishedSolution, ids.draftSolution].filter(Boolean) } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: [ids.realCase, ids.demoCase, ids.candidateCase].filter(Boolean) } } }).catch(() => undefined);
    await prisma.techCapability.deleteMany({ where: { id: ids.capability || "__none__" } }).catch(() => undefined);
    await prisma.businessModel.deleteMany({ where: { id: ids.businessModel || "__none__" } }).catch(() => undefined);
    await prisma.region.deleteMany({ where: { id: ids.region || "__none__" } }).catch(() => undefined);
    // 兜底：按标题/slug 前缀再清一次
    await prisma.solution.deleteMany({ where: { slug: { contains: runId } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("listPublicCases 默认排除 DEMO 与内部阶段，包含真实公开案例", async () => {
    const res = await listPublicCases({
      offset: 0, limit: 100, page: 1, pageSize: 100,
      sortBy: "discoveredAt", sortOrder: "desc", includeDemo: false,
    });
    expect(res.ok).toBe(true);
    const foundIds = res.items.map((i) => i.id);
    expect(foundIds).toContain(ids.realCase);
    expect(foundIds).not.toContain(ids.demoCase); // DEMO 被排除
    expect(foundIds).not.toContain(ids.candidateCase); // CANDIDATE 阶段被排除
    const real = res.items.find((i) => i.id === ids.realCase)!;
    expect(real.isDemo).toBe(false);
    expect(real.industrySlug).toBe("new-energy");
    expect(real.opportunityScore).toBe(70);
  }, 60_000);

  it("listPublicCases includeDemo=true 时纳入 DEMO，且标记 isDemo", async () => {
    const res = await listPublicCases({
      offset: 0, limit: 100, page: 1, pageSize: 100,
      sortBy: "discoveredAt", sortOrder: "desc", includeDemo: true,
    });
    expect(res.ok).toBe(true);
    const demo = res.items.find((i) => i.id === ids.demoCase);
    expect(demo).toBeDefined();
    expect(demo!.isDemo).toBe(true);
  }, 60_000);

  it("listPublicCases 行业筛选生效", async () => {
    const res = await listPublicCases({
      offset: 0, limit: 100, page: 1, pageSize: 100,
      industry: "INDUSTRIAL_MANUFACTURING", sortBy: "discoveredAt", sortOrder: "desc", includeDemo: true,
    });
    expect(res.ok).toBe(true);
    expect(res.items.every((i) => i.industry === "INDUSTRIAL_MANUFACTURING")).toBe(true);
    expect(res.items.map((i) => i.id)).toContain(ids.demoCase);
  }, 60_000);

  it("getPublicCaseById 返回完整详情（证据分层 + 能力关联 + 商业模式）", async () => {
    const res = await getPublicCaseById(ids.realCase, false);
    expect(res.status).toBe("found");
    if (res.status !== "found") return;
    expect(res.data.evidences).toHaveLength(2);
    expect(res.data.evidences.map((e) => e.type).sort()).toEqual(["FACT", "PREDICTION"]);
    expect(res.data.capabilities).toHaveLength(1);
    expect(res.data.capabilities[0].relevance).toBe(80);
    expect(res.data.businessModel?.name).toContain(runId);
    expect(res.data.publishedSolutionCount).toBe(1); // 仅 PUBLISHED 计数
    expect(res.data.isDemo).toBe(false);
  }, 60_000);

  it("getPublicCaseById 对 DEMO 案例：默认 not_found，includeDemo 时 found", async () => {
    expect((await getPublicCaseById(ids.demoCase, false)).status).toBe("not_found");
    const res = await getPublicCaseById(ids.demoCase, true);
    expect(res.status).toBe("found");
    if (res.status === "found") expect(res.data.isDemo).toBe(true);
  }, 60_000);

  it("getPublicCaseById 对内部阶段案例与不存在 id 均 not_found", async () => {
    expect((await getPublicCaseById(ids.candidateCase, true)).status).toBe("not_found");
    expect((await getPublicCaseById("nonexistent_cuid_0000000000", true)).status).toBe("not_found");
  }, 60_000);

  it("listPublishedSolutions 只含 PUBLISHED，排除 DRAFT", async () => {
    const res = await listPublishedSolutions({
      offset: 0, limit: 100, page: 1, pageSize: 100,
      sortBy: "publishedAt", sortOrder: "desc", includeDemo: false,
    });
    expect(res.ok).toBe(true);
    const foundIds = res.items.map((i) => i.id);
    expect(foundIds).toContain(ids.publishedSolution);
    expect(foundIds).not.toContain(ids.draftSolution);
    const pub = res.items.find((i) => i.id === ids.publishedSolution)!;
    expect(pub.priceDisplay).toBe("¥1999.00");
    expect(pub.needsProfessionalReview).toBe(true);
    expect(pub.riskDomains).toEqual(["能源", "投资"]);
  }, 60_000);

  it("getPublishedSolutionById 返回财务与未知变量；DRAFT 与不存在 id → not_found", async () => {
    const res = await getPublishedSolutionById(ids.publishedSolution, false);
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.data.financials).toHaveLength(1);
      expect(res.data.financials[0].roiPct).toBe("12.5");
      expect(res.data.financials[0].calcRef).toBe("it-calc");
      expect(res.data.unknowns).toHaveLength(1);
      expect(res.data.unknowns[0].severity).toBe(70);
      expect(res.data.caseTitle).toContain(runId);
      expect(res.data.hasBody).toBe(false);
    }
    expect((await getPublishedSolutionById(ids.draftSolution, false)).status).toBe("not_found");
    expect((await getPublishedSolutionById("nonexistent_cuid_0000000000", false)).status).toBe("not_found");
  }, 60_000);
});
