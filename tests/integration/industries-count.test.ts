import { describe, it, expect, afterAll } from "vitest";
import { disconnectPrisma } from "@/lib/prisma";
import { getIndustryCaseCounts, INDUSTRIES } from "@/server/industries";

/**
 * 集成测试：getIndustryCaseCounts() 真连 Neon Postgres（不 mock）。
 *
 * 验证点（宪法第 5 条可验证）：
 *   - DB 可达时返回 ok:true，counts 覆盖全部 7 个行业 slug，值为非负整数；
 *   - 数据库当前为空，计数应全为 0（诚实空态，不预置假数据）。
 *
 * Neon 免费库冷启动首连可能超时（见 MEMORY 冒烟坑），故加预热重试：
 *   首次可能 ok:false，唤醒后重试应恢复 ok:true。
 *
 * 无 DATABASE_URL 时整体 skip（与 db-smoke 一致）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn(
    "[industries-count] DATABASE_URL not set — skipping. Run with: npm run test:integration",
  );
}

/** 预热重试：Neon 冷启动首连失败时最多重试 3 次。 */
async function getCountsWithWarmup() {
  let last = await getIndustryCaseCounts();
  for (let attempt = 0; attempt < 3 && !last.ok; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    last = await getIndustryCaseCounts();
  }
  return last;
}

describeDb("getIndustryCaseCounts (Neon Postgres)", () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("returns ok with a non-negative count for every industry slug", async () => {
    const result = await getCountsWithWarmup();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    for (const industry of INDUSTRIES) {
      const count = result.counts[industry.slug];
      expect(typeof count).toBe("number");
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it("counts keys exactly match the 7 industry slugs", async () => {
    const result = await getCountsWithWarmup();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.counts).sort()).toEqual(
      INDUSTRIES.map((i) => i.slug).sort(),
    );
  }, 60_000);
});
