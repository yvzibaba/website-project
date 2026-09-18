/**
 * 沙盘「来源方案」溯源识别与诚实描述（中途重构 R8.3 · 总控最高优先级「商业闭环」的第三块拼图）。
 *
 * 背景：R8.1 产出沙盘 → 产业方案草案的纯映射桥，R8.2 把草案落成一条真实 `Solution` DRAFT 并接进既有
 * 「发布 → 查看 → 购买」闭环。闭环虽已技术可达，但一条**由沙盘推演生成**的方案一旦被人工发布、出现在
 * 公开详情页并可供购买时，买家必须清楚知道：它的全部关键数字来自**确定性沙盘模型的示例占位假设**
 * （ASSUMPTION）、而非经核实的真实项目数据——这正是宪法第 16 条（区分事实/假设/推断/预测）、第 20 条
 * （占位假设诚实）、第 21 条（高风险须人工确认）对「对外售卖」这一环的要求。
 *
 * 本模块就是那个「读得懂来源、说得清诚实」的识别层：
 *   - **只读、绝不重算**（§8 单一真源）：从**已落库**的 `SolutionFinancial.assumptions` JSON 里读出
 *     R8.1 草案写入的溯源指纹（`solutionCalcRef` / `engineVersions` / `evidenceKind` / `regionName` /
 *     `profileName` / `npv`），不碰任何引擎、不换算任何指标。发布与否由服务端 `publishGuard` 决定，
 *     本层既不授权也不拦截，纯粹为「如实呈现」服务。
 *   - **稳健的来源判据**：仅当某条财务的 `assumptions.solutionCalcRef` 是以 `SANDBOX_SOLUTION_ORIGIN_PREFIX`
 *     （"sandbox-solution@"）起头的字符串时才判定为沙盘来源——该串由 `sandbox-solution.ts` 的
 *     `sandboxSolutionCalcRef()` 唯一产出，是人工后台录入方案不会自带的确凿指纹（非启发式猜电价/猜负号）。
 *
 * 边界（勿越权）：**client-safe 纯函数**（与 `sandbox-solution.ts`/`sandbox-view.ts`/`sandbox-report.ts` 同层），
 *   零 DB、零网络、零时钟、零随机、零 `import`；入参取**结构最小面**（`{calcRef, assumptions}`），既便于单测、
 *   又不与 Prisma Decimal 类型耦合。本仓刻意不 import "server-only"（vitest/node 会抛错），仅注释标注。
 */

/** 溯源识别口径版本（判据 / 提取字段变化须升版记因，宪法第 13 条）。 */
export const SANDBOX_SOLUTION_LINEAGE_VERSION = "1.0.0";

/**
 * 沙盘来源指纹前缀。`sandbox-solution.ts` 的 `sandboxSolutionCalcRef()` 产出 `sandbox-solution@<semver>`，
 * 落到每条财务的 `assumptions.solutionCalcRef`——本层据此确凿判定来源。两模块共享此契约，
 * 由单测「真实草案 → 本层识别」用例钉住防漂移（宪法第 8/16 条单一真源）。
 */
export const SANDBOX_SOLUTION_ORIGIN_PREFIX = "sandbox-solution@";

/** 只取本层真正需要的两个字段，避免与 Prisma `SolutionFinancial` 全类型耦合（也便于纯单测构造）。 */
export interface LineageFinancialLike {
  calcRef?: string | null;
  assumptions?: unknown;
}

/** 沙盘来源方案的诚实溯源画像（全部字段来自已落库 assumptions 的原样读取，无一重算）。 */
export interface SandboxLineage {
  generatedBySandbox: true;
  /** 命中的 `solutionCalcRef` 原串（如 `sandbox-solution@1.0.0`）。 */
  solutionCalcRef: string;
  /** 从前缀后剥出的草案口径版本（如 `1.0.0`）；异常时回落到空串。 */
  draftVersion: string;
  /** 承载来源指纹那条财务的 `calcRef`（引擎结果引用，如 `model@1.0.0`）；无则 null。 */
  engineCalcRef: string | null;
  /** 引擎内核版本快照（`assumptions.engineVersions`）；缺省/非对象则 null。 */
  engineVersions: Record<string, unknown> | null;
  /** 地区名（`assumptions.regionName`）；非字符串则 null。 */
  regionName: string | null;
  /** 企业画像名（`assumptions.profileName`）；缺省（通用=无画像）时为 null。 */
  profileName: string | null;
  /** 证据等级（`assumptions.evidenceKind`，沙盘恒为 `ASSUMPTION`）；非字符串则 null。 */
  evidenceKind: string | null;
  /**
   * 当前参数的 NPV 是否为非正（`assumptions.npv` 为有限数且 < 0）。
   * 仅从已落库值**读取判断**、绝不重算；npv 缺失/非数（省略即算不出）时保守记 false（不臆断为负）。
   */
  npvNonPositive: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取字符串字段，非字符串/空串一律回 null（宁缺毋滥，绝不把 undefined 当事实呈现）。 */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 从 `sandbox-solution@1.2.3` 剥出 `1.2.3`；无 @ 或空则回空串（不抛）。 */
function versionAfterPrefix(ref: string): string {
  const at = ref.indexOf("@");
  return at >= 0 ? ref.slice(at + 1) : "";
}

/** 判断单条财务的 assumptions 是否带沙盘指纹（确凿前缀匹配，非启发式）。 */
function sandboxRefOf(financial: LineageFinancialLike): string | null {
  const a = financial.assumptions;
  if (!isRecord(a)) return null;
  const ref = a.solutionCalcRef;
  return typeof ref === "string" && ref.startsWith(SANDBOX_SOLUTION_ORIGIN_PREFIX) ? ref : null;
}

/**
 * 是否沙盘来源方案：任一财务条带沙盘指纹即为真。空数组 / 全人工录入 → false。
 * 纯函数、确定性；不做任何重算或权限判断。
 */
export function isSandboxSourcedSolution(financials: readonly LineageFinancialLike[]): boolean {
  return financials.some((f) => sandboxRefOf(f) !== null);
}

/**
 * 描述沙盘来源方案的诚实溯源画像；**非沙盘来源 → null**（详情页据此决定是否显示声明，互不干扰）。
 * 取**第一条**命中指纹的财务为准（沙盘草案只产一条财务；多条时择首，行为确定、可测）。
 */
export function describeSandboxLineage(
  financials: readonly LineageFinancialLike[],
): SandboxLineage | null {
  if (!Array.isArray(financials)) return null;
  const hit = financials.find((f) => sandboxRefOf(f) !== null);
  if (!hit) return null;
  const ref = sandboxRefOf(hit) as string;
  const a = isRecord(hit.assumptions) ? (hit.assumptions as Record<string, unknown>) : {};
  const npv = a.npv;
  const npvNonPositive = typeof npv === "number" && Number.isFinite(npv) && npv < 0;
  return {
    generatedBySandbox: true,
    solutionCalcRef: ref,
    draftVersion: versionAfterPrefix(ref),
    engineCalcRef: str(hit.calcRef),
    engineVersions: isRecord(a.engineVersions) ? (a.engineVersions as Record<string, unknown>) : null,
    regionName: str(a.regionName),
    profileName: str(a.profileName),
    evidenceKind: str(a.evidenceKind),
    npvNonPositive,
  };
}
