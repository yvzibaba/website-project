/**
 * 沙盘「来源方案」溯源审计与升级契约（中途重构 R8.4 · 总控最高优先级「商业闭环」的第四块拼图）。
 *
 * 承接：R8.1 沙盘→方案草案（数字只搬运不重算）、R8.2 草案落库转 DRAFT、R8.3 识别「这是沙盘来源」并给买家
 * 挂诚实声明。但**识别 ≠ 可追溯**——宪法第 12 条要求「关键数字须来源可追溯 + 公式可复算」，第 16 条要求区分
 * 事实/假设/推断/预测。沙盘方案当前全部是 **ASSUMPTION（示例占位假设）**，要走向「可售的真实方案」，中间缺
 * 的正是一条**可机器审计、可受控升级**的数据治理脊柱：
 *   1. **可复算校验（公式可复算）**：方案里存的每一个 `SolutionFinancial` 十进制数（roiPct/irrPct/paybackYears）
 *      都应当能由**同一行 `assumptions` 里携带的源值**（roiRatio/irrFraction/discountedPaybackYears）经确定的
 *      换算 + 定点舍入**复算出来**。若对不上，说明落库途中数字被篡改/串位——这是对 §8 单一真源的**事后取证**，
 *      不重跑引擎、不依赖外部，仅凭已落库那一行即可判定。
 *   2. **可追溯摘要（来源可追溯）**：逐条财务读 `assumptions.evidenceKind` 与 `sourceUrl`，把「是否 FACT + 是否
 *      带真实来源链接」聚合成一句话画像——让买家/审计一眼看清「这套数字到底可不可追溯」，而非笼统一句「是假设」。
 *   3. **升级契约（ASSUMPTION→FACT 受控闸门）**：给出一个**纯函数式的升级预案**——只有当有人提交了**合法
 *      http(s) 来源链接 + 数值型置信度**时，才允许把某条财务从 ASSUMPTION 提升为 FACT；否则 `willUpgrade:false`
 *      并保留 ASSUMPTION。**本模块绝不擅自把占位假设粉饰成事实**（§16/§20），真正的写库路径留 R8.5。
 *
 * 边界（勿越权）：
 *   - **client-safe 纯函数**（与 `sandbox-solution.ts`/`sandbox-solution-lineage.ts`/`sandbox-view.ts` 同层）：
 *     零 DB、零网络、零时钟、零随机、零 `import`；入参取**结构最小面** `FinancialLike`，既便于单测、又不与
 *     Prisma Decimal 类型耦合。本仓刻意不 import "server-only"（vitest/node 会抛错），仅注释标注。
 *   - **只读、绝不重算引擎指标**（§8）：可复算校验比的是「已落库 Decimal 串」与「同行已落库 assumptions 源值」
 *     两个**存量**之间的一致性，不调用 `runSandboxModel`、不换算 NPV。这是审计，不是再算一遍。
 *   - **不写库、不改状态**：`planProvenanceUpgrade` 只产出「若满足条件则应升级」的**结构化预案**，由调用方（R8.5
 *     的受 staff 门禁写路径）决定是否真正落库。识别与授权分离（§「AI 做劳动、人做关键决策」）。
 */

/** 溯源审计与升级口径版本（判据 / 复算公式 / 升级门槛变化须升版记因，宪法第 13 条）。 */
export const SANDBOX_SOLUTION_PROVENANCE_VERSION = "1.0.0";

/** 溯源引用：把一次审计钉到「本口径版本」，供页面与审计日志展示（与 lineage 的 solutionCalcRef 并列不冲突）。 */
export function provenanceCalcRef(): string {
  return `sandbox-solution-provenance@${SANDBOX_SOLUTION_PROVENANCE_VERSION}`;
}

/**
 * 可复算校验的容差：`SolutionFinancial` 的百分数/年数在落库前经 `.toFixed()` 定点化，且列本身为
 * Decimal(8,4)/(8,2)，读回串与原值之间只剩「末位舍入」差异。故对每个量纲取「半个最小舍入位」为容差，
 * 既能容忍真实的两次舍入（toFixed + 列定点），又能揪出被明显篡改的数字（如把 400.35 改 999.99）。
 */
const TOL_ROI_PCT = 0.006; // roiPct=(roiRatio×100) 保留 2 位 → 半个 0.01
const TOL_IRR_PCT = 0.0001; // irrPct=(irrFraction×100) 保留 4 位 → 半个 0.0001 放宽一档
const TOL_PAYBACK_YEARS = 0.006; // paybackYears=discountedPaybackYears 保留 2 位 → 半个 0.01

/** 结构最小面：只取审计真正要读的字段，避免与 Prisma `SolutionFinancial` 全类型耦合。 */
export interface FinancialLike {
  /** Decimal(14,2) 读回串，如 "3524500.00"；无则 null/undefined。 */
  capex?: string | number | null;
  opexAnnual?: string | number | null;
  revenueAnnual?: string | number | null;
  /** Decimal(8,4) 读回串，如 "400.3500"。 */
  roiPct?: string | number | null;
  /** Decimal(8,4) 读回串，如 "23.7553"。 */
  irrPct?: string | number | null;
  /** Decimal(8,2) 读回串，如 "5.28"。 */
  paybackYears?: string | number | null;
  sourceUrl?: string | null;
  calcRef?: string | null;
  /** 已落库的溯源 JSON（含 roiRatio/irrFraction/discountedPaybackYears/evidenceKind 等）。 */
  assumptions?: unknown;
}

/** 单条可复算比对结论。 */
export interface ReproducibilityCheck {
  /** 被核验的量纲键，如 "roiPct"。 */
  metric: string;
  /** 落库十进制串解析出的实际值。 */
  stored: number;
  /** 由同行 assumptions 源值换算出的期望值。 */
  expected: number;
  /** 绝对偏差。 */
  delta: number;
  /** 是否在容差内视为「可复算」。 */
  ok: boolean;
}

/** 单条财务的可复算审计产物。 */
export interface ReproducibilityReport {
  /** 所有「可比」的核验都通过 → true（无缺失可比项或全部命中容差）；出现偏差 → false。 */
  reproducible: boolean;
  /** 实际做了比对的条目（源值与落库串同时存在才计入）。 */
  checks: ReproducibilityCheck[];
  /** 因缺源值或缺落库串而跳过的量纲名（诚实标注「无从复算」，不算失败）。 */
  skipped: string[];
  /** 偏差超容差的条目点名（复算不通过的具体证据）。 */
  issues: string[];
}

/** 逐条可追溯性画像。 */
export interface TraceabilityRow {
  index: number;
  /** 读自 `assumptions.evidenceKind`（沙盘恒 "ASSUMPTION"）。 */
  evidenceKind: string | null;
  /** 是否存在**合法 http(s)** 来源链接。 */
  hasSourceUrl: boolean;
  sourceUrl: string | null;
  /** 综合判定：evidenceKind==="FACT" 且带真实来源链接 → 可追溯。 */
  traceable: boolean;
}

/** 方案级可追溯性摘要。 */
export interface TraceabilitySummary {
  total: number;
  /** 判定为「可追溯（FACT + 来源）」的条数。 */
  traceableCount: number;
  /** 仍为 ASSUMPTION 的条数。 */
  assumptionCount: number;
  /** 其它证据等级（INFERENCE/PREDICTION/未知）条数。 */
  otherCount: number;
  /** 带合法来源链接的条数（无论证据等级）。 */
  withSourceUrlCount: number;
  /** 全部可追溯 → true（空数组按「无可主张可追溯者」记 false，不臆断为真）。 */
  fullyTraceable: boolean;
  rows: TraceabilityRow[];
}

/** 方案级溯源综合评估（页面只读呈现 + R8.5 写路径决策共用的一份「体检报告」）。 */
export interface SandboxSolutionProvenance {
  auditVersion: string;
  /** 溯源引用（provenanceCalcRef()）。 */
  auditRef: string;
  financialCount: number;
  /** 逐条复算审计的合并视图。 */
  reproducibility: {
    /** 所有财务都可复算（或无可比项）→ true。 */
    allReproducible: boolean;
    perFinancial: ReproducibilityReport[];
    /** 展平后的全部问题点名（跨财务），空表示无复算异常。 */
    issues: string[];
  };
  traceability: TraceabilitySummary;
  /**
   * 一句话买家摘要：把「能不能信、还差什么」讲清楚。
   * 沙盘全新导出典型形态 = 「全部 N 项关键数字均可由引擎源值复算，但目前 0/N 具备真实来源、
   * 证据等级 ASSUMPTION，尚不可作投资依据」。
   */
  buyerSummary: string;
}

/** 升级预案入参（由 R8.5 的人工录入/数据接入路径提供）。 */
export interface ProvenanceUpgradeIntent {
  /** 真实来源链接（须 http(s)）。 */
  sourceUrl?: string | null;
  /** 置信度 0–100（数值型）。 */
  confidence?: number | null;
  /** 备注（可空）。 */
  note?: string | null;
}

/** 升级预案产物：只主张「应否升级」，绝不落库。 */
export interface ProvenanceUpgradePlan {
  /** 满足门槛（合法 http(s) 链接 + [0,100] 数值置信度）→ true。 */
  willUpgrade: boolean;
  /** 目标证据等级：willUpgrade 时为 "FACT"，否则维持原值（缺省 "ASSUMPTION"）。 */
  targetEvidenceKind: "FACT" | "ASSUMPTION";
  /** 规范化后的来源链接（trim）；不合法则 null。 */
  sourceUrl: string | null;
  /** 规范化后的置信度；不合法则 null。 */
  confidence: number | null;
  /** 拒绝升级的原因（willUpgrade=false 时给出，供界面提示，绝不静默）。 */
  reason: string | null;
}

/* ────────────────────────────── 内部工具 ────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 把 Decimal 读回串（或 number）安全解析为有限数；无法解析 → null（绝不把脏值当 0 蒙混）。 */
function num(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 从 assumptions 里安全取有限数（非数/非有限一律 null）。 */
function assumptionNum(a: Record<string, unknown>, key: string): number | null {
  const raw = a[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** 合法来源链接判定：http(s) 开头、去空白后非空、不含空格。宁可误拒不可误收。 */
export function isUsableSourceUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const t = url.trim();
  if (t === "" || /\s/.test(t)) return false;
  return /^https?:\/\//i.test(t);
}

/**
 * 对一条财务做可复算校验：把「落库十进制串」与「同行 assumptions 源值经确定换算」逐一比对。
 * 仅比可比项；缺源值或缺落库串记入 skipped（诚实「无从复算」，不判失败）。
 * 纯函数、确定性；不重跑引擎、不换算 NPV（那是 §8 禁止的「再算一遍」）。
 */
export function verifyReproducibility(financial: FinancialLike): ReproducibilityReport {
  const a = isRecord(financial.assumptions) ? (financial.assumptions as Record<string, unknown>) : {};
  const checks: ReproducibilityCheck[] = [];
  const skipped: string[] = [];
  const issues: string[] = [];

  const consider = (metric: string, storedRaw: string | number | null | undefined, expected: number | null, tol: number) => {
    const stored = num(storedRaw);
    if (stored === null || expected === null) {
      skipped.push(metric); // 沙盘对负/算不出的指标会省略落库或源值，诚实跳过
      return;
    }
    const delta = Math.abs(stored - expected);
    const ok = delta <= tol;
    checks.push({ metric, stored, expected, delta, ok });
    if (!ok) issues.push(`${metric} 落库 ${stored} 与源值复算期望 ${expected.toFixed(4)} 不符（偏差 ${delta.toFixed(4)} > 容差 ${tol}）`);
  };

  // roiPct = roiRatio × 100（草案 toFixed(2)）。
  const roiRatio = assumptionNum(a, "roiRatio");
  consider("roiPct", financial.roiPct, roiRatio === null ? null : roiRatio * 100, TOL_ROI_PCT);
  // irrPct = irrFraction × 100（草案 toFixed(4)）。
  const irrFraction = assumptionNum(a, "irrFraction");
  consider("irrPct", financial.irrPct, irrFraction === null ? null : irrFraction * 100, TOL_IRR_PCT);
  // paybackYears = discountedPaybackYears（草案 toFixed(2)）。
  const payback = assumptionNum(a, "discountedPaybackYears");
  consider("paybackYears", financial.paybackYears, payback, TOL_PAYBACK_YEARS);

  const reproducible = issues.length === 0;
  return { reproducible, checks, skipped, issues };
}

/** 对多条财务逐条做可追溯性摘要（读 evidenceKind + sourceUrl，判定 FACT 且带真实来源才「可追溯」）。 */
export function summarizeTraceability(financials: readonly FinancialLike[]): TraceabilitySummary {
  const rows: TraceabilityRow[] = [];
  let traceableCount = 0;
  let assumptionCount = 0;
  let otherCount = 0;
  let withSourceUrlCount = 0;

  financials.forEach((f, index) => {
    const a = isRecord(f.assumptions) ? (f.assumptions as Record<string, unknown>) : {};
    const kind = typeof a.evidenceKind === "string" && a.evidenceKind.length > 0 ? a.evidenceKind : null;
    const usable = isUsableSourceUrl(f.sourceUrl);
    const sourceUrl = usable ? (f.sourceUrl as string).trim() : null;
    const traceable = kind === "FACT" && usable;
    if (traceable) traceableCount += 1;
    if (kind === "ASSUMPTION") assumptionCount += 1;
    else otherCount += 1;
    if (usable) withSourceUrlCount += 1;
    rows.push({ index, evidenceKind: kind, hasSourceUrl: usable, sourceUrl, traceable });
  });

  const total = financials.length;
  return {
    total,
    traceableCount,
    assumptionCount,
    otherCount,
    withSourceUrlCount,
    fullyTraceable: total > 0 && traceableCount === total,
    rows,
  };
}

/**
 * 方案级溯源综合评估：合并「可复算」与「可追溯」两条轴，产出一份可直接给页面/审计消费的体检报告。
 * 纯函数、确定性；对空数组回一份「无可审计财务」的诚实报告（各项计数 0、buyerSummary 说明为空态）。
 */
export function evaluateSandboxSolutionProvenance(
  financials: readonly FinancialLike[],
): SandboxSolutionProvenance {
  const list = Array.isArray(financials) ? financials : [];
  const perFinancial = list.map((f) => verifyReproducibility(f));
  const issues = perFinancial.flatMap((r) => r.issues);
  const allReproducible = issues.length === 0;
  const traceability = summarizeTraceability(list);

  const buyerSummary = buildBuyerSummary(list.length, allReproducible, issues.length, traceability);

  return {
    auditVersion: SANDBOX_SOLUTION_PROVENANCE_VERSION,
    auditRef: provenanceCalcRef(),
    financialCount: list.length,
    reproducibility: { allReproducible, perFinancial, issues },
    traceability,
    buyerSummary,
  };
}

/** 组装一句（至两句）买家可懂的诚实摘要；只依据已审计出的存量事实，不臆断。 */
function buildBuyerSummary(
  total: number,
  allReproducible: boolean,
  issueCount: number,
  tr: TraceabilitySummary,
): string {
  if (total === 0) return "本方案未携带结构化财务条目，无可复算/可追溯的审计对象。";
  const reproPart = allReproducible
    ? `全部 ${total} 项财务的关键数字均可由同行引擎源值复算一致（公式可复算）`
    : `有 ${issueCount} 处关键数字与源值复算对不上（公式复算异常，须核查落库）`;
  const tracePart =
    tr.traceableCount === 0
      ? `但 0/${total} 具备来源可追溯的真实数据链接、证据等级多为 ${tr.assumptionCount === total ? "ASSUMPTION（示例占位假设）" : "混合"}，尚不可作投资依据`
      : `其中 ${tr.traceableCount}/${total} 已升级为 FACT 且带真实来源链接${tr.fullyTraceable ? "（全部可追溯）" : "，其余仍待补来源"}`;
  return `${reproPart}，${tracePart}。`;
}

/**
 * ASSUMPTION→FACT 升级预案（纯函数闸门）：
 *   仅当同时满足「合法 http(s) 来源链接」+「[0,100] 数值置信度」时 `willUpgrade:true`、目标 FACT；
 *   任一缺失即 `willUpgrade:false` 并保留 ASSUMPTION，附**明确原因**。本函数**不落库、不改状态**，
 *   真正的写入由 R8.5 的受 staff 门禁路径执行——把「是否升级为事实」的裁决权焊死在合法证据上（§12/§16/§20）。
 */
export function planProvenanceUpgrade(
  current: FinancialLike | null | undefined,
  intent: ProvenanceUpgradeIntent,
): ProvenanceUpgradePlan {
  // 保留当前证据等级（缺省 ASSUMPTION），以便拒绝时如实回落到原状。
  const curKind =
    isRecord(current?.assumptions) && typeof (current!.assumptions as Record<string, unknown>).evidenceKind === "string"
      ? ((current!.assumptions as Record<string, unknown>).evidenceKind as string)
      : "ASSUMPTION";
  const keep = (): ProvenanceUpgradePlan => ({
    willUpgrade: false,
    targetEvidenceKind: curKind === "FACT" ? "FACT" : "ASSUMPTION",
    sourceUrl: isUsableSourceUrl(intent?.sourceUrl) ? (intent.sourceUrl as string).trim() : null,
    confidence: null,
    reason: null,
  });

  if (!isUsableSourceUrl(intent?.sourceUrl)) {
    const withUrl = keep();
    return { ...withUrl, reason: "缺少合法 http(s) 来源链接：无出处不得把占位假设升级为事实（§12/§20）" };
  }
  const conf = intent.confidence;
  if (typeof conf !== "number" || !Number.isFinite(conf)) {
    const withUrl = keep();
    withUrl.sourceUrl = (intent.sourceUrl as string).trim();
    return { ...withUrl, reason: "缺少数值型置信度：升级 FACT 须给出 0–100 的置信度（§12）" };
  }
  if (conf < 0 || conf > 100) {
    const withUrl = keep();
    withUrl.sourceUrl = (intent.sourceUrl as string).trim();
    return { ...withUrl, confidence: null, reason: `置信度 ${conf} 越界（须落在 0–100）` };
  }

  return {
    willUpgrade: true,
    targetEvidenceKind: "FACT",
    sourceUrl: (intent.sourceUrl as string).trim(),
    confidence: conf,
    reason: null,
  };
}
