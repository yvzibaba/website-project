import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { listAdminCases, ADMIN_CASE_LIST_LIMIT } from "@/server/admin-cases";
import { DEMO_SOURCE_TYPE } from "@/server/demo";

/**
 * 集成测试：案例「后台」只读视图 listAdminCases（Phase 13 M2），真连 Neon，不 mock。
 *
 * 覆盖公开 listPublicCases 刻意不覆盖的三件事，正是后台读层存在的理由：
 *   ① 内部阶段（CANDIDATE / KEY_RESEARCH）**必须可见**——运营刚录的候选案例不能像商店橱窗那样被门控掉；
 *   ② DEMO 夹具**必须可见并标记 isDemo=true**——便于人眼区分测试数据与真实数据；
 *   ③ evidenceCount / solutionCount 来自 _count 关联，与真实建表数一致。
 * 外加 updatedAt 倒序、total 与 items 自洽（truncated 语义）。夹具 afterAll 按外键序清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[admin-cases] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-admncases-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

describeDb("admin case list read-layer (Neon)", () => {
  beforeAll(async () => {
    await warmup();

    // ① 候选态 + 2 证据 + 1 方案
    const candidate = await prisma.case.create({
      data: {
        title: `后台可见-候选-${runId}`,
        industry: "NEW_ENERGY",
        stage: "CANDIDATE",
        sourceType: "MANUAL",
        evidences: { create: [{ type: "FACT", statement: "e1" }, { type: "FACT", statement: "e2" }] },
      },
    });
    track(candidate.id);
    await prisma.solution.create({
      data: { title: `挂案方案-${runId}`, slug: `it-admncases-${runId}`, caseId: candidate.id, status: "DRAFT" },
    });

    // ② DEMO 夹具（应在后台可见且标 isDemo）
    const demo = await prisma.case.create({
      data: {
        title: `【DEMO】后台可见-夹具-${runId}`,
        industry: "OTHER",
        stage: "KEY_RESEARCH",
        sourceType: DEMO_SOURCE_TYPE,
      },
    });
    track(demo.id);

    // ③ 深度案例（公开橱窗也可见，用于验证不遗漏真实行）
    const deep = await prisma.case.create({
      data: {
        title: `后台可见-深度-${runId}`,
        industry: "INDUSTRIAL_MANUFACTURING",
        stage: "DEEP_CASE",
        sourceType: "MANUAL",
        opportunityScore: 88,
        evidenceConfidence: 69,
      },
    });
    track(deep.id);
  });

  afterAll(async () => {
    await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog.deleteMany({ where: { entityId: { in: createdCaseIds } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("内部阶段 + DEMO 夹具均可见（这正是后台读层区别于公开橱窗的意义）", async () => {
    const res = await listAdminCases();
    expect(res.ok).toBe(true);
    expect(res.items.length).toBeGreaterThan(0);

    const mine = res.items.filter((c) => c.title.includes(runId));
    const byTitle = (kw: string) => mine.find((c) => c.title.includes(kw));

    const candidate = byTitle("候选");
    const demo = byTitle("夹具");
    const deep = byTitle("深度");

    // CANDIDATE / KEY_RESEARCH 内部阶段不因公开门控消失
    expect(candidate?.stage).toBe("CANDIDATE");
    expect(demo?.stage).toBe("KEY_RESEARCH");
    expect(deep?.stage).toBe("DEEP_CASE");

    // DEMO 标记
    expect(candidate?.isDemo).toBe(false);
    expect(demo?.isDemo).toBe(true);
    expect(deep?.isDemo).toBe(false);
  });

  it("evidenceCount / solutionCount 来自 _count 关联，与真实建表数一致", async () => {
    const res = await listAdminCases();
    const candidate = res.items.find((c) => c.title.includes(`候选-${runId}`));
    expect(candidate?.evidenceCount).toBe(2);
    expect(candidate?.solutionCount).toBe(1);
    // 深度案例：0 证据 / 0 方案；评分透传
    const deep = res.items.find((c) => c.title.includes(`深度-${runId}`));
    expect(deep?.evidenceCount).toBe(0);
    expect(deep?.solutionCount).toBe(0);
    expect(deep?.opportunityScore).toBe(88);
    expect(deep?.evidenceConfidence).toBe(69);
  });

  it("按 updatedAt 倒序 + total/items/truncated 自洽", async () => {
    const res = await listAdminCases();
    // 全局排序不变式：任意相邻两项 updatedAt 非递增
    for (let i = 1; i < res.items.length; i++) {
      expect(res.items[i - 1].updatedAt.getTime()).toBeGreaterThanOrEqual(res.items[i].updatedAt.getTime());
    }
    // total 是全表计数，items 至多 ADMIN_CASE_LIST_LIMIT；truncated 当且仅当 total > items.length
    expect(res.total).toBeGreaterThanOrEqual(res.items.length);
    expect(res.items.length).toBeLessThanOrEqual(ADMIN_CASE_LIST_LIMIT);
    expect(res.truncated).toBe(res.total > res.items.length);
  });

  it("行业映射为可读名（enum→name/slug），非原始枚举字符串", async () => {
    const res = await listAdminCases();
    const deep = res.items.find((c) => c.title.includes(`深度-${runId}`));
    expect(deep?.industry).toBe("INDUSTRIAL_MANUFACTURING");
    expect(deep?.industryName).toBeTruthy();
    expect(deep?.industryName).not.toBe("INDUSTRIAL_MANUFACTURING"); // 是中文名而非枚举字面量
    expect(deep?.industrySlug).toBeTruthy();
  });
});
