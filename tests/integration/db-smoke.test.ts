import { describe, it, expect, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";

/**
 * 集成测试：直接连 Neon Postgres，验证 Prisma Client ↔ 真实 DB 的读写通路。
 *
 * 宪法第 5 条（可验证）+ 第 20 条（诚实）：
 *   - 不 mock 数据库，用真库跑，才能证明"网站 ↔ Neon"链路真的通；
 *   - 如果 DATABASE_URL 缺失，测试自动 skip 而非失败，让 CI 可以在无 DB 环境跑单元测试。
 *
 * 运行方式：
 *   npm run test:integration  （脚本会用 --env-file=.env 加载 DATABASE_URL）
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    "[db-smoke] DATABASE_URL not set — integration tests will be skipped. " +
      `Run with: npm run test:integration`,
  );
}

describeDb("db smoke (Neon Postgres)", () => {
  const uniqueName = `smoke-region-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let createdId: string | null = null;

  afterAll(async () => {
    // 清理：即使中途断言失败也要把测试数据删掉，避免污染真库。
    if (createdId) {
      await prisma.region
        .deleteMany({ where: { id: createdId } })
        .catch(() => undefined);
    }
    // 兜底：按 name 前缀再清一次（防止 create 成功但 createdId 未赋值的极端情况）
    await prisma.region
      .deleteMany({ where: { name: { startsWith: "smoke-region-" } } })
      .catch(() => undefined);
    await disconnectPrisma();
  });

  it("SELECT 1 round-trips", async () => {
    const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].one)).toBe(1);
  });

  it("creates, reads, updates and deletes a Region row (full CRUD)", async () => {
    // CREATE
    const created = await prisma.region.create({
      data: {
        name: uniqueName,
        nameEn: "Smoke Test Region",
        country: "CN",
      },
    });
    createdId = created.id;
    expect(created.id).toMatch(/^[a-z0-9]+$/); // cuid
    expect(created.name).toBe(uniqueName);
    expect(created.createdAt).toBeInstanceOf(Date);

    // READ (unique by id)
    const read = await prisma.region.findUnique({ where: { id: created.id } });
    expect(read).not.toBeNull();
    expect(read?.name).toBe(uniqueName);
    expect(read?.nameEn).toBe("Smoke Test Region");
    expect(read?.country).toBe("CN");

    // UPDATE
    const updated = await prisma.region.update({
      where: { id: created.id },
      data: { nameEn: "Smoke Test Region (updated)" },
    });
    expect(updated.nameEn).toBe("Smoke Test Region (updated)");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.updatedAt.getTime(),
    );

    // DELETE
    await prisma.region.delete({ where: { id: created.id } });
    const afterDelete = await prisma.region.findUnique({
      where: { id: created.id },
    });
    expect(afterDelete).toBeNull();
    createdId = null; // 已删除，afterAll 无需再清
  });

  it("exposes all 11 enum types in public schema", async () => {
    const rows = await prisma.$queryRaw<Array<{ enum_name: string }>>`
      SELECT t.typname AS enum_name
      FROM pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'
      ORDER BY t.typname
    `;
    const names = rows.map((r) => r.enum_name);
    expect(names).toEqual([
      "BuyerType",
      "CaseStage",
      "ChangeAction",
      "Currency",
      "EvidenceType",
      "Industry",
      "LicenseReviewStatus",
      "LicenseType",
      "Maturity",
      "OrderStatus",
      "SolutionStatus",
    ]);
  });

  it("has all 17 V1 business tables present", async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const names = rows.map((r) => r.table_name);
    const EXPECTED = [
      "BusinessModel",
      "CapabilityProject",
      "Case",
      "CaseCapability",
      "ChangeLog",
      "Evidence",
      "Localization",
      "LocalizationSupplier",
      "Market",
      "OpenSourceProject",
      "Order",
      "Region",
      "Solution",
      "SolutionFinancial",
      "Supplier",
      "TechCapability",
      "UnknownVariable",
      "_prisma_migrations",
    ].sort();
    expect(names).toEqual(EXPECTED);
  });

  it("prisma_migrations table records 0_init as applied and not rolled back", async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        migration_name: string;
        applied_steps_count: number;
        rolled_back_at: Date | null;
        finished_at: Date | null;
      }>
    >`
      SELECT migration_name, applied_steps_count, rolled_back_at, finished_at
      FROM _prisma_migrations
      WHERE migration_name = '0_init'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].applied_steps_count).toBe(1);
    expect(rows[0].rolled_back_at).toBeNull();
    expect(rows[0].finished_at).toBeInstanceOf(Date);
  });
});
