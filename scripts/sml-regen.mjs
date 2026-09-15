/**
 * SML 黄金重录入口（跨平台）。用法：
 *   npm run regen:sml
 *   SML_REGEN_REASON="口径变更原因（宪法13条）" npm run regen:sml   ← Windows cmd 下先 set 再跑
 * 实际重算与写盘逻辑在 tests/unit/sml-regen.test.ts（平时该文件整文件跳过，零副作用）。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = resolve(repoRoot, "node_modules", "vitest", "vitest.mjs");

const r = spawnSync(
  process.execPath,
  [vitestCli, "run", "tests/unit/sml-regen.test.ts"],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, SML_REGEN: "1", VITEST_MIN_THREADS: "1" } },
);
process.exit(r.status ?? 1);
