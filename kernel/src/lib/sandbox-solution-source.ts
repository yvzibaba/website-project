/**
 * 沙盘「已保存情景 → 产业方案」的**来源关联指针**（中途重构 R8.6 · 总控最高优先级「商业闭环」的
 * 「反查关联」拼图，宪法 §12「关键数字来源可追溯」在「方案 ↔ 沙盘」这条边上的兑现）。
 *
 * 背景：R8.1~R8.5 已把「沙盘结果 → 草案 → DRAFT 方案 → 溯源升级 FACT」整条竖切打通，但有一条边始终缺失——
 *   一份**由某个已保存沙盘情景导出**的方案，与它**源自哪个沙盘情景 / 项目**之间没有可导航的关联。
 *   R8.3 的 lineage 只回答「这套数字是不是沙盘推演出来的」（沙盘 vs 手工），R8.4 的 provenance 只回答
 *   「这些数字可否复算、可否升级为事实」；二者都**不记录**「导出它的那个具体情景 id」。于是买家/研究者看一份
 *   方案时无法回溯「它当初是基于哪一版沙盘参数跑出来的」，看一个沙盘项目时也无从知道「它导出过哪些方案」。
 *
 * 本模块补的就是这条边的**数据契约**（写侧把指针钉进 `SolutionFinancial.assumptions.sandboxSource`，
 *   读侧把它原样取回并诚实描述），全程**只搬运、绝不重算、绝不新增列 / 表**（零 schema 迁移，沿用既有 JSONB）：
 *   - **写侧 `attachSandboxSource`**：对每条财务的 `assumptions` 做**不可变浅合并**（`{...existing, sandboxSource}`），
 *     ★绝不覆盖 `solutionCalcRef`/`roiRatio`/`engineVersions` 等既有溯源键——否则 R8.3 识别 / R8.4 复算会失效。
 *     指针对象缺失（用户从未保存情景 → 无 id 可挂）时**原样返回、绝不虚构**（§20 诚实）。
 *   - **读侧 `readSandboxSourceFromFinancials`**：与 lineage 同构，取**首条**带合法 `sandboxSource` 的财务，
 *     逐字段原值读出、非串/脏值诚实降 `null`，无来源 → `null`（不猜）。既供方案详情页正向展示，也供服务端反查回读。
 *
 * 边界（勿越权）：**client-safe 纯函数**（与 `sandbox-solution-lineage.ts`/`sandbox-solution.ts` 同层），
 *   零 DB、零网络、零时钟、零随机、零 `import`（仅 `import type`），入参取结构最小面、不与 Prisma 类型耦合。
 *   「情景 / 项目 id 是否真实存在」的校验属服务端职责（见 `src/server/sandbox-solution-source.ts`），
 *   本层只保证「形状合法 + 不破坏既有脊柱」，绝不冒充已验存在性。本仓刻意不 import "server-only"。
 */

/** 来源关联指针口径版本（字段名 / 形状变化须升版记因，宪法第 13 条）。 */
export const SANDBOX_SOLUTION_SOURCE_VERSION = "1.0.0";

/** V1 唯一的来源类型：方案派生自一个「已保存的沙盘情景」。留判别位以备未来其它来源，不硬编码字符串散落。 */
export const SANDBOX_SOURCE_KIND = "sandbox-scenario" as const;

/** 指针落在 `SolutionFinancial.assumptions` 里的键名（写侧 / 读侧 / 服务端反查共享，防拼写漂移，§16）。 */
export const SANDBOX_SOURCE_FIELD = "sandboxSource" as const;

/** 归一后的来源关联指针（只含可确证字段；缺省即整字段省略而非塞空串/塞 null）。 */
export interface SandboxSourceRef {
  kind: typeof SANDBOX_SOURCE_KIND;
  /** 派生自哪个已保存情景（cuid 串）；缺失即不出现该键。 */
  scenarioId?: string;
  /** 情景所属项目（cuid 串）；缺失即不出现该键。 */
  projectId?: string;
  /** 打戳本指针的口径版本（供日后审计「这条关联是哪个版本写的」）。 */
  sourceVersion: string;
}

/** 写侧可提供的来源输入（两个 id 均可选，皆缺 → 视为无来源、不落指针）。 */
export interface SandboxSourceInput {
  scenarioId?: string | null;
  projectId?: string | null;
}

/** 只取本层真正需要的字段，避免与 Prisma `SolutionFinancial` 全类型耦合（也便于纯单测构造）。 */
export interface SourceFinancialLike {
  assumptions?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** cuid 形状（Prisma `cuid()`：c 开头 + 小写字母数字，放宽到 20–32 兼容历史）；非串/越界 → false。 */
function isCuidLike(v: unknown): v is string {
  return typeof v === "string" && /^c[a-z0-9]{19,31}$/.test(v);
}

/** 取合法 cuid 串，否则 undefined（用于「缺失即省略该键」，绝不留 null/空串冒充有来源）。 */
function cuidOr(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return isCuidLike(s) ? s : undefined;
}

/**
 * 归一来源输入为一个可信指针对象：只保留形状合法的 cuid，两个 id 都缺（或都脏）→ `null`（不落指针）。
 * 纯函数、确定性。注意：这里**只判形状**，不查库、不冒充「情景确实存在」。
 */
export function normalizeSandboxSource(input: SandboxSourceInput | null | undefined): SandboxSourceRef | null {
  if (!input || typeof input !== "object") return null;
  const scenarioId = cuidOr(input.scenarioId);
  const projectId = cuidOr(input.projectId);
  if (!scenarioId && !projectId) return null;
  const ref: SandboxSourceRef = { kind: SANDBOX_SOURCE_KIND, sourceVersion: SANDBOX_SOLUTION_SOURCE_VERSION };
  if (scenarioId) ref.scenarioId = scenarioId;
  if (projectId) ref.projectId = projectId;
  return ref;
}

/** 从任意 assumptions 值里安全读出 `sandboxSource` 子对象（脏 / 缺 → null）。 */
function readSourceField(assumptions: unknown): Record<string, unknown> | null {
  if (!isRecord(assumptions)) return null;
  const raw = assumptions[SANDBOX_SOURCE_FIELD];
  return isRecord(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * 把归一后的来源指针**不可变浅合并**进每条财务的 `assumptions`（`{...existing, sandboxSource}`）。
 *   - `src` 归一为 null（无有效 id）→ **原样返回入参数组（同一引用）**，绝不新增/改写任何财务；
 *   - 合并只**追加** `sandboxSource` 一键，`solutionCalcRef`/`roiRatio`/`engineVersions` 等既有键**逐一保留**
 *     （否则 R8.3 来源识别、R8.4 可复算审计会因指纹被覆盖而失效——这是本模块最关键的不破坏约束）；
 *   - 对无 `assumptions` 或 `assumptions` 非对象的财务，新建 `{ sandboxSource }`（不污染原值）。
 * 返回**新数组 / 新对象**，不就地修改入参（纯函数、可安全用于落库前的映射）。
 */
export function attachSandboxSource<T extends SourceFinancialLike>(
  financials: readonly T[],
  src: SandboxSourceInput | null | undefined,
): T[] {
  const list = Array.isArray(financials) ? financials : [];
  const ref = normalizeSandboxSource(src);
  if (!ref) return [...list];
  return list.map((f) => {
    const base = isRecord(f.assumptions) ? (f.assumptions as Record<string, unknown>) : {};
    const next: T = { ...f, assumptions: { ...base, [SANDBOX_SOURCE_FIELD]: ref } };
    return next;
  });
}

/**
 * 读回一份方案（其财务集）所记录的来源关联指针；**无来源 → null**（非沙盘情景导出、或导出时情景未保存）。
 * 取**首条**带合法 `sandboxSource` 的财务为准（沙盘草案只产一条财务；多条时择首，行为确定、可测）。
 * 逐字段用 `cuidOr` 再校验一遍：库里存的脏值不冒充合法 id；`kind`/`sourceVersion` 非串则降 null。
 */
export function readSandboxSourceFromFinancials(
  financials: readonly SourceFinancialLike[],
): SandboxSourceRef | null {
  if (!Array.isArray(financials)) return null;
  for (const f of financials) {
    const field = readSourceField(f.assumptions);
    if (!field) continue;
    const scenarioId = cuidOr(field.scenarioId);
    const projectId = cuidOr(field.projectId);
    if (!scenarioId && !projectId) continue; // 有键但两 id 皆脏 → 跳过、不冒充有来源
    const ref: SandboxSourceRef = { kind: SANDBOX_SOURCE_KIND, sourceVersion: SANDBOX_SOLUTION_SOURCE_VERSION };
    if (scenarioId) ref.scenarioId = scenarioId;
    if (projectId) ref.projectId = projectId;
    const sv = typeof field.sourceVersion === "string" ? field.sourceVersion : null;
    if (sv) ref.sourceVersion = sv; // 库里记的版本优先（保留「哪版写的」审计真相），缺则回落本层版本
    return ref;
  }
  return null;
}

/** 截断展示用的短 id（避免把整条 cuid 暴露在只读文本里；< 8 位则原样）。 */
function shortId(id: string | undefined): string | null {
  if (!id) return null;
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/**
 * 把来源指针翻成一句给人看的诚实描述（详情页正向展示用）；`null` → `null`（无来源不硬凑句子）。
 * 只陈述「派生自哪个情景 / 项目的指针」，不对方案质量或数据真实性下任何结论。
 */
export function describeSandboxSource(ref: SandboxSourceRef | null | undefined): string | null {
  if (!ref) return null;
  const scen = shortId(ref.scenarioId);
  const proj = shortId(ref.projectId);
  if (scen && proj) return `派生自已保存的沙盘情景 ${scen}（项目 ${proj}）`;
  if (scen) return `派生自已保存的沙盘情景 ${scen}`;
  if (proj) return `派生自已保存的沙盘项目 ${proj}`;
  return null;
}
