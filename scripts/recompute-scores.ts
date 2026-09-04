import { prisma } from "@/lib/prisma";
import { recomputeAllCaseScores } from "@/server/case-scores";

/**
 * 评分复算脚本（Phase 7 M2）。
 *
 * 用途：迁移后校准 / 评分公式（rubricVersion）升级后重跑 / 每日流水线批量复算。
 *   对每个案例：读 scoreInput + evidences → computeCaseScores → 写 scoreBreakdown + opportunityScore + evidenceConfidence。
 *
 * 诚实约束（宪法第 20 条）：没有 scoreInput 的案例**跳过**（skipped），绝不反推/编造输入分；
 *   scoreInput 非法 → invalid（不写库）。脚本只如实汇报各类计数，不粉饰。
 *
 * 幂等：纯函数复算，重复运行结果一致（同 scoreInput + 同 rubricVersion → 同 breakdown）。
 *
 * 运行：npm run db:recompute-scores  （= node --env-file=.env --import tsx scripts/recompute-scores.ts）
 * 退出码：有 error 计数则 1，否则 0（便于 CI/流水线判断）。
 */

async function main(): Promise<void> {
  const summary = await recomputeAllCaseScores();
  const { total, computed, skipped, invalid, notFound, error } = summary;

  process.stdout.write(
    [
      "评分复算完成（recomputeAllCaseScores）",
      `  案例总数 total    : ${total}`,
      `  已复算 computed   : ${computed}`,
      `  跳过(无输入) skip : ${skipped}`,
      `  非法(未写库) inv  : ${invalid}`,
      `  不存在 notFound   : ${notFound}`,
      `  错误 error        : ${error}`,
      "",
    ].join("\n"),
  );

  // 逐条列出非 computed 的案例，便于定位（最多 50 条，防刷屏）
  const abnormal = summary.results.filter((r) => r.status !== "computed").slice(0, 50);
  for (const r of abnormal) {
    if (r.status === "invalid") {
      process.stdout.write(`  [invalid] ${r.caseId}: ${r.issues.join("; ")}\n`);
    } else if (r.status === "error") {
      process.stdout.write(`  [error]   ${r.caseId}: ${r.error}\n`);
    } else if (r.status === "skipped") {
      process.stdout.write(`  [skipped] ${r.caseId} (no scoreInput)\n`);
    } else {
      process.stdout.write(`  [${r.status}] ${r.caseId}\n`);
    }
  }
  if (invalid > 0 || error > 0) {
    process.stdout.write(`\n注意：${invalid} 个非法输入、${error} 个错误，请检查 scoreInput 是否与 OPPORTUNITY_DIMENSIONS 对齐。\n`);
  }

  process.exitCode = error > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    process.stderr.write(`recompute-scores failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
