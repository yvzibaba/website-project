/**
 * 功能开关（V1.1 P4 · 免费/Pro 边界的「计费留桩」）。
 *
 * 原则（宪法：简单 > 自动化 > 功能数）：V1.1 **不建计费系统**——Pro 层级对全体登录用户开放，
 * 只把未来的 entitlement 判定收敛成**单一开关函数**，接线点即此文件；将来接支付/订阅时
 * 只改本文件实现（换成真 entitlement 查询），调用方零改动、不改语义。
 * 开关经环境变量控制（默认开）；非 Next 运行时（vitest/node 直跑）下同样可读。
 */

export type SandboxEntitlement = "export" | "multiProject" | "versionRollback";

/** 缺省（未配置环境变量）= 全开：V1.1 先全开、计费开关留桩（方案 §3.3）。 */
const DEFAULT_ON: Record<SandboxEntitlement, boolean> = {
  export: true,
  multiProject: true,
  versionRollback: true,
};

function envKey(e: SandboxEntitlement): string {
  return `SANDBOX_ENTITLEMENT_${e.toUpperCase()}`;
}

/** 某项沙盘 Pro 能力是否放行。环境变量显式置 "0"/"false" 才关，其余（含缺省）为开。 */
export function hasEntitlement(
  entitlement: SandboxEntitlement,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[envKey(entitlement)];
  if (raw === undefined || raw === "") return DEFAULT_ON[entitlement];
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
