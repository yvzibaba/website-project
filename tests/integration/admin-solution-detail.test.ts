import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { getAdminSolutionDetail } from "@/server/admin-solutions";
import { DEMO_SOURCE_TYPE } from "@/server/demo";

/**
 * 集成测试：方案「后台详情」读层 getAdminSolutionDetail（Phase 13 M4），真连 Neon，不 mock。
 *
 * 覆盖 M4 编辑台所依赖、而公开 getPublishedSolutionById 刻意不给的读能力：
 *   ① 任意状态（含 DRAFT）都可读到，透出**原始 body**（供 34 分节编辑器取初值 + 合并保留 extras）；
 *   ② financials / unknowns 明细来自关联表，Decimal 一律归一为**两位小数字符串**（"2999.00" 而非 "2999"）、
 *      null 字段保留 null（宪法第 7 条数字精确可追溯）；
 *   ③ unknownVariableCount 取实时条数（可计算事实），非陈旧缓存；
 *   ④ isDemo 由**关联案例**判定；行业 enum→中文名映射；
 *   ⑤ notFound 与「读失败」可区分：合法 cuid 但库无行 → notFound；非法形状 id → notFound（不抛裸异常）。
 * 夹具 afterAll 按外键序 order→solution→case + entityId 清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[admin-solution-detail] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-admnsoldetail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdSolutionIds: string[] = [];
const createdCaseIds: string[] = [];
function trackSolution(id?: string) {
  if (id) createdSolutionIds.push(id);
}
function trackCase(id?: string) {
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

const BODY = {
  // canonical key 命中
  name: `${runId}-方案名称`,
  coreProblem: "解决沼气并网难",
  // 中文 title 命中（应被归一器识别为该节内容）
  目标行业: "新能源",
  // 结构化内容（数组）
  roadmap: ["POC", "试点", "推广"],
  // 契约外键 → extras（应原样保留）
  someLegacyKey: { legacy: true },
};

describeDb("admin solution detail read-layer (Neon)", () => {
  let realSolutionId = "";
  let demoSolutionId = "";

  beforeAll(async () => {
    await warmup();

    // 真实案例（DEEP_CASE）+ DEMO 案例
    const realCase = await prisma.case.create({
      data: { title: `详情-真实案例-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
    });
    trackCase(realCase.id);
    const demoCase = await prisma.case.create({
      data: { title: `【DEMO】详情-夹具-${runId}`, industry: "OTHER", stage: "KEY_RESEARCH", sourceType: DEMO_SOURCE_TYPE },
    });
    trackCase(demoCase.id);

    // 真实案例上的 DRAFT 方案：带价、带 body、2 财务（一全一缺）、2 未知
    const sol = await prisma.solution.create({
      data: {
        title: `详情-草稿方案-${runId}`,
        slug: `it-admnsoldetail-${runId}`,
        caseId: realCase.id,
        status: "DRAFT",
        price: "2999.00",
        currency: "CNY",
        body: BODY as object,
        riskDomains: ["法律", "环保"],
        needsProfessionalReview: true,
      },
      select: { id: true },
    });
    realSolutionId = sol.id;
    trackSolution(sol.id);

    await prisma.solutionFinancial.create({
      data: { solutionId: sol.id, capex: "1200000.00", opexAnnual: "300000", revenueAnnual: "800000", roiPct: "42.5", currency: "CNY", calcRef: "简单年化", note: "首年" },
    });
    await prisma.solutionFinancial.create({
      data: { solutionId: sol.id, paybackYears: "3.5", currency: "CNY" }, // 其余字段留 null
    });
    await prisma.unknownVariable.create({
      data: { solutionId: sol.id, name: "补贴是否延续", impact: "影响 IRR ~5pct", howToResolve: "查最新政策", severity: 70 },
    });
    await prisma.unknownVariable.create({
      data: { solutionId: sol.id, name: "设备国产化率" }, // impact/howToResolve/severity 留 null
    });

    // DEMO 案例上的方案（用于断言 isDemo 由关联案例判定）
    const demoSol = await prisma.solution.create({
      data: { title: `详情-DEMO方案-${runId}`, slug: `it-admnsoldetail-demo-${runId}`, caseId: demoCase.id, status: "DRAFT" },
      select: { id: true },
    });
    demoSolutionId = demoSol.id;
    trackSolution(demoSol.id);
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { solutionId: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { slug: { contains: runId } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog.deleteMany({ where: { entityId: { in: [...createdSolutionIds, ...createdCaseIds] } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("DRAFT 方案可全量读到 + 原始 body 透出 + 关联案例映射 + Decimal 两位小数字符串", async () => {
    const res = await getAdminSolutionDetail(realSolutionId);
    expect(res.ok).toBe(true);
    const s = res.data;
    expect(s).not.toBeNull();
    expect(s!.status).toBe("DRAFT"); // 后台不受公开橱窗的 PUBLISHED 门控
    expect(s!.price).toBe("2999.00");
    expect(s!.priceDisplay).toBe("¥2999.00");
    expect(s!.riskDomains).toEqual(expect.arrayContaining(["法律", "环保"]));
    expect(s!.needsProfessionalReview).toBe(true);
    expect(s!.caseTitle).toContain(`真实案例-${runId}`);
    expect(s!.industry).toBe("NEW_ENERGY");
    expect(s!.industryName).toBeTruthy();
    expect(s!.industryName).not.toBe("NEW_ENERGY"); // 中文名而非枚举字面量
    expect(s!.isDemo).toBe(false);
    // 原始 body 原样透出（编辑器据此取初值 + 保留 extras）
    expect(s!.body).toMatchObject({ name: `${runId}-方案名称`, someLegacyKey: { legacy: true } });
  });

  it("financials 明细：Decimal→两位字符串、缺省字段保留 null，按 createdAt 倒序", async () => {
    const res = await getAdminSolutionDetail(realSolutionId);
    const fins = res.data!.financials;
    expect(fins.length).toBe(2);
    // 倒序：最后建的（paybackYears=3.5）排在前
    expect(fins[0].paybackYears).toBe("3.50"); // Decimal(14,2)→toFixed(2) 补零
    expect(fins[0].capex).toBeNull();
    // 全量那条：Decimal 精确、无浮点、保留尾零
    const full = fins.find((f) => f.capex !== null);
    expect(full).toBeTruthy();
    expect(full!.capex).toBe("1200000.00");
    expect(full!.roiPct).toBe("42.50");
    expect(full!.irrPct).toBeNull();
    expect(full!.currency).toBe("CNY");
    expect(full!.calcRef).toBe("简单年化");
    expect(res.data!.financialCount).toBe(2);
  });

  it("unknowns 明细透传 + unknownVariableCount = 实时条数（可计算事实）", async () => {
    const res = await getAdminSolutionDetail(realSolutionId);
    const unks = res.data!.unknowns;
    expect(unks.length).toBe(2);
    expect(res.data!.unknownVariableCount).toBe(2);
    const withSev = unks.find((u) => u.name.includes("补贴"));
    expect(withSev?.severity).toBe(70);
    expect(withSev?.impact).toContain("IRR");
    const bare = unks.find((u) => u.name.includes("国产化率"));
    expect(bare?.impact).toBeNull();
    expect(bare?.severity).toBeNull();
  });

  it("isDemo 由关联案例判定：挂在 DEMO 案例上的方案 → true", async () => {
    const res = await getAdminSolutionDetail(demoSolutionId);
    expect(res.ok).toBe(true);
    expect(res.data!.isDemo).toBe(true);
  });

  it("notFound 与读失败可区分：库无行 / 非法形状 id 均 notFound、不抛", async () => {
    const missing = await getAdminSolutionDetail("c" + "a".repeat(24)); // 合法长度但库无行
    expect(missing.notFound).toBe(true);
    expect(missing.ok).toBe(false);
    expect(missing.data).toBeNull();
    const badShape = await getAdminSolutionDetail("nope"); // 太短/非法形状
    expect(badShape.notFound).toBe(true);
    expect(badShape.error).toBeUndefined();
  });
});
