import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { getAdminDashboardData } from "@/server/admin";
import type { UserRole } from "@/lib/validation";

/**
 * 集成测试：后台数据聚合 getAdminDashboardData（Phase 6 M2），真连 Neon，不 mock。
 *
 * 核心不变式（比绝对值更有意义，因为库里含 6 个 DEMO 案例等既有数据）：
 *   「分维度 groupBy 之和 === 该实体 total」——机会/方案/用户/证据四个维度都要自洽。
 * 并验证真实写入能被概览反映：提权一个账号为 ADMIN（复刻 user:promote 的核心 update）后
 *   byRole.ADMIN ≥ 1；写入一条 Case 审计（ChangeLog）后，recentChanges 里能查到该 entityId。
 * 一次性夹具 afterAll 全量清理，不污染真库。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn("[admin] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const adminEmail = `admin-${runId}@example.com`;

const ids = { caseId: "", solutionId: "", userId: "" };

function sumValues(map: Record<string, number>): number {
  return Object.values(map).reduce((s, n) => s + n, 0);
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

describeDb("admin dashboard aggregation (Neon)", () => {
  beforeAll(async () => {
    await warmup();

    // 用户：先建成普通用户，再提权为 ADMIN（复刻 scripts/promote-user.ts 的核心动作）
    const user = await prisma.user.create({
      data: { email: adminEmail, passwordHash: "scrypt$placeholder", role: "USER" as UserRole },
    });
    ids.userId = user.id;
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });

    // 案例 + 一条已发布方案（供 byStatus.PUBLISHED 至少命中）+ 一条 Case 审计流水
    const c = await prisma.case.create({
      data: { title: `后台概览夹具-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE" },
    });
    ids.caseId = c.id;

    const sol = await prisma.solution.create({
      data: { title: `后台概览方案-${runId}`, slug: `admin-fixture-${runId}`, caseId: c.id, status: "PUBLISHED" },
    });
    ids.solutionId = sol.id;

    await prisma.changeLog.create({
      data: {
        entityType: "Case",
        entityId: c.id,
        action: "CREATE",
        changedBy: `human:${user.id}`,
        reason: "集成测试夹具",
        after: { title: `后台概览夹具-${runId}` },
      },
    });
  });

  afterAll(async () => {
    if (ids.solutionId) await prisma.solution.delete({ where: { id: ids.solutionId } }).catch(() => undefined);
    if (ids.caseId) {
      await prisma.changeLog.deleteMany({ where: { entityId: ids.caseId } }).catch(() => undefined);
      await prisma.case.delete({ where: { id: ids.caseId } }).catch(() => undefined);
    }
    if (ids.userId) await prisma.user.delete({ where: { id: ids.userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { contains: runId } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("四个维度的 groupBy 之和 === 各自 total（分维度分布自洽）", async () => {
    const data = await getAdminDashboardData(50);

    expect(sumValues(data.cases.byStage)).toBe(data.cases.total);
    expect(sumValues(data.solutions.byStatus)).toBe(data.solutions.total);
    expect(sumValues(data.users.byRole)).toBe(data.users.total);
    // 证据 grade 可空 → 归入 "NONE"，含 NONE 后之和应等于总数
    expect(sumValues(data.evidences.byGrade)).toBe(data.evidences.total);

    expect(data.cases.total).toBeGreaterThanOrEqual(1);
    expect(data.users.total).toBeGreaterThanOrEqual(1);
    expect(data.orders.total).toBeGreaterThanOrEqual(0);
    expect(data.generatedAt).toBeInstanceOf(Date);
  });

  it("提权账号在概览中体现：byRole.ADMIN ≥ 1", async () => {
    const data = await getAdminDashboardData(50);
    expect(data.users.byRole.ADMIN ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("已发布方案体现于 byStatus.PUBLISHED；夹具审计流水可被 recentChanges 查到", async () => {
    const data = await getAdminDashboardData(100);
    expect(data.solutions.byStatus.PUBLISHED ?? 0).toBeGreaterThanOrEqual(1);

    const found = data.recentChanges.find((c) => c.entityId === ids.caseId && c.action === "CREATE");
    expect(found).toBeDefined();
    expect(found?.entityType).toBe("Case");
    expect(found?.reason).toBe("集成测试夹具");
  });

  it("recentLimit 截断生效：take=min(limit,100) 且返回条数 ≤ 请求上限", async () => {
    const data = await getAdminDashboardData(1);
    expect(data.recentChanges.length).toBeLessThanOrEqual(1);
  });
});
