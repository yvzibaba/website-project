import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { listAdminSolutions, ADMIN_SOLUTION_LIST_LIMIT } from "@/server/admin-solutions";
import { DEMO_SOURCE_TYPE } from "@/server/demo";

/**
 * 集成测试：方案「后台」只读视图 listAdminSolutions（Phase 13 M3），真连 Neon，不 mock。
 *
 * 覆盖公开 listPublishedSolutions 刻意不覆盖的三件事，正是后台读层存在的理由：
 *   ① 内部态（DRAFT / UNDER_HUMAN_REVIEW）**必须可见**——运营刚建的草稿方案不能像商店橱窗那样被门控掉；
 *   ② 挂在 DEMO 案例上的方案**必须可见并标记 isDemo=true**（方案本身无 sourceType，DEMO 与否取决于关联案例）；
 *   ③ price / priceDisplay / _count（financials / unknowns / orders）与真实建表数一致，
 *      供「方案从录入到可售」后台据此判断能否发布（未定价可见）。
 * 外加 updatedAt 倒序、total 与 items 自洽（truncated 语义）。夹具 afterAll 按外键序清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[admin-solutions] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-admnsol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
function trackCase(id?: string) {
  if (id) createdCaseIds.push(id);
}
function trackSol(id?: string) {
  if (id) createdSolutionIds.push(id);
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

describeDb("admin solution list read-layer (Neon)", () => {
  beforeAll(async () => {
    await warmup();

    // ① 真实案例（NEW_ENERGY）→ 一条 DRAFT 方案（带价 + 1 财务 + 2 未知变量）
    const candCase = await prisma.case.create({
      data: { title: `方案后台-真实案例-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
    });
    trackCase(candCase.id);
    const draft = await prisma.solution.create({
      data: {
        title: `草稿方案-已定价-${runId}`,
        slug: `it-admnsol-draft-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        caseId: candCase.id,
        status: "DRAFT",
        price: "2999.00",
        currency: "CNY",
        riskDomains: ["法律", "环保"],
        needsProfessionalReview: true,
        financials: { create: [{ capex: "100.00", currency: "CNY" }] },
        unknowns: { create: [{ name: "u1" }, { name: "u2" }] },
      },
    });
    trackSol(draft.id);

    // ② 同案例 → 一条未定价 DRAFT（验证 priceDisplay=null 的「未定价」可见）
    const noPrice = await prisma.solution.create({
      data: {
        title: `草稿方案-未定价-${runId}`,
        slug: `it-admnsol-noprice-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        caseId: candCase.id,
        status: "DRAFT",
      },
    });
    trackSol(noPrice.id);

    // ③ 已发布方案（公开橱窗也可见，用于验证不遗漏真实行）
    const pub = await prisma.solution.create({
      data: {
        title: `已发布方案-${runId}`,
        slug: `it-admnsol-pub-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        caseId: candCase.id,
        status: "PUBLISHED",
        price: "199.00",
        currency: "CNY",
        publishedAt: new Date(),
      },
    });
    trackSol(pub.id);

    // ④ DEMO 案例 → 挂一条方案（应可见且 isDemo=true）
    const demoCase = await prisma.case.create({
      data: { title: `【DEMO】方案后台-夹具-${runId}`, industry: "OTHER", stage: "KEY_RESEARCH", sourceType: DEMO_SOURCE_TYPE },
    });
    trackCase(demoCase.id);
    const demoSol = await prisma.solution.create({
      data: {
        title: `DEMO关联方案-${runId}`,
        slug: `it-admnsol-demo-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        caseId: demoCase.id,
        status: "DRAFT",
      },
    });
    trackSol(demoSol.id);
  });

  afterAll(async () => {
    // 外键序：order（若有）→ solution → case；再 changeLog + runId 兜底。
    await prisma.order.deleteMany({ where: { solutionId: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog.deleteMany({ where: { entityId: { in: [...createdSolutionIds, ...createdCaseIds] } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("内部态（DRAFT / UNDER_HUMAN_REVIEW）+ DEMO 关联方案均可见（后台读层区别于公开橱窗的意义）", async () => {
    const res = await listAdminSolutions();
    expect(res.ok).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);

    const mine = res.items.filter((s) => s.title.includes(runId));
    const byTitle = (kw: string) => mine.find((s) => s.title.includes(kw));

    // DRAFT 草稿不因公开门控（listPublishedSolutions 只含 PUBLISHED）而消失
    expect(byTitle("草稿方案-已定价")?.status).toBe("DRAFT");
    expect(byTitle("已发布方案")?.status).toBe("PUBLISHED");

    // DEMO 关联：方案 isDemo 由关联案例的 sourceType 决定
    expect(byTitle("DEMO关联方案")?.isDemo).toBe(true);
    expect(byTitle("草稿方案-已定价")?.isDemo).toBe(false);
  });

  it("price / priceDisplay / 关联计数与真实建表数一致（未定价如实为 null）", async () => {
    const res = await listAdminSolutions();
    const priced = res.items.find((s) => s.title.includes(`草稿方案-已定价-${runId}`));
    expect(priced?.price).toBe("2999.00");
    expect(priced?.priceDisplay).toBe("¥2999.00");
    expect(priced?.financialCount).toBe(1);
    expect(priced?.unknownVariableCount).toBe(2);
    expect(priced?.orderCount).toBe(0);
    expect(priced?.riskDomains).toEqual(expect.arrayContaining(["法律", "环保"]));
    expect(priced?.needsProfessionalReview).toBe(true);

    // 未定价草稿：price/priceDisplay 均为 null（发布守卫据此拦「未定价」，后台据此显「未定价」徽章）
    const nop = res.items.find((s) => s.title.includes(`草稿方案-未定价-${runId}`));
    expect(nop?.price).toBeNull();
    expect(nop?.priceDisplay).toBeNull();

    const pub = res.items.find((s) => s.title.includes(`已发布方案-${runId}`));
    expect(pub?.priceDisplay).toBe("¥199.00");
    expect(pub?.financialCount).toBe(0);
    expect(pub?.unknownVariableCount).toBe(0);
  });

  it("挂靠案例信息透传 + 行业映射为可读名（非枚举字面量）", async () => {
    const res = await listAdminSolutions();
    const priced = res.items.find((s) => s.title.includes(`草稿方案-已定价-${runId}`));
    expect(priced?.caseTitle).toContain(`真实案例-${runId}`);
    expect(priced?.industry).toBe("NEW_ENERGY");
    expect(priced?.industryName).toBeTruthy();
    expect(priced?.industryName).not.toBe("NEW_ENERGY"); // 中文名而非枚举字面量
    expect(priced?.industrySlug).toBeTruthy();
  });

  it("按 updatedAt 倒序 + total/items/truncated 自洽", async () => {
    const res = await listAdminSolutions();
    // 全局排序不变式：任意相邻两项 updatedAt 非递增
    for (let i = 1; i < res.items.length; i++) {
      expect(res.items[i - 1].updatedAt.getTime()).toBeGreaterThanOrEqual(res.items[i].updatedAt.getTime());
    }
    expect(res.total).toBeGreaterThanOrEqual(res.items.length);
    expect(res.items.length).toBeLessThanOrEqual(ADMIN_SOLUTION_LIST_LIMIT);
    expect(res.truncated).toBe(res.total > res.items.length);
  });
});
