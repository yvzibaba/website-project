import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import { seedBenchmarkRows, allBenchmarkRowSeeds } from "@app/kernel/server/benchmark-repo";
import { disconnectPrisma } from "@app/kernel/lib/prisma";

/**
 * 基准镜像灌库脚本（R4 · M9）。
 *
 * 干的事只有一件：把内核 `BENCHMARK_ENTRIES` 当前版本的**无损镜像** upsert 进
 * `BenchmarkEntry` 表（见 benchmark-repo.ts 的"投影不是源头"设计）。
 *
 * 幂等：重复跑只按 `(benchmarkVersion, regionId, key)` 更新，不新增、不删除历史版本行。
 * 换 BENCHMARK_VERSION 后重跑 = 灌一份新版本镜像，旧版本行原样保留（可追溯"当时用的哪套基准"）。
 *
 * 运行：npm run db:seed:benchmark
 * 退出码：成功 0；异常非 0（并保证 disconnect，别把 Neon 连接吊住）。
 */
async function main(): Promise<void> {
  const expected = allBenchmarkRowSeeds().length;
  process.stdout.write(`内核当前基准：${expected} 条（版本 ${BENCHMARK_VERSION}）\n`);

  const written = await seedBenchmarkRows();
  if (written !== expected) {
    process.stderr.write(`镜像条数不一致：seed 期望 ${expected}，实际写入 ${written}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`✓ 已灌入基准镜像 ${written} 条（版本 ${BENCHMARK_VERSION}）。\n`);
  process.stdout.write("  注意：本表是投影不是计算真源——引擎仍从内核常量取基准，黄金基线不受影响。\n");
}

main()
  .catch((err) => {
    process.stderr.write(`基准镜像灌库失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
