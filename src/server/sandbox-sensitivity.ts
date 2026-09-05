/**
 * 敏感性分析 + 高风险标记（中途重构 R2.3）——《项目中途重构总控》§14 第 8 项「敏感性」、
 * §9「情景」、§16「区分事实/假设/推断…高风险须专业人工确认」在计算层的落地。
 *
 * 做法：**one-at-a-time（OAT）龙卷风图**——对每个关键参数按 ±delta 扰动，其余参数保持基线，
 * 用 R2.4 `runSandboxModel` **整链重算**（真正走 §4 命脉：改滑块→技术→现金流→指标全变），
 * 记录选定经济指标（默认 NPV）的低值/高值与摆幅（swing），按 |swing| 降序即"最敏感变量"排序。
 *
 * ⚠️ 诚实（第 20 条）：
 *   - 指标算不出（NPV=NaN / IRR `ok:false`）时该行 `lowMetric/highMetric/swing` 记 `null` 并留 note，
 *     **绝不用 0 或编造值冒充摆幅**；null 行排在末尾。
 *   - 扰动值仍受 R1 参数引擎的区间裁剪（越界会被夹到边界，故扰动是"在允许范围内"的扰动）。
 *   - 本模块不改模型经济口径，只是**重复调用** `runSandboxModel` 观察输出响应，故与 R2.4 共享同一套简化假设与 `needsProfessionalReview`。
 */
import {
  SANDBOX_PARAMETER_SPECS,
  resolveSandbox,
} from "@/server/sandbox-params";
import type { ResolveLayers } from "@/server/parameter-engine";
import { runSandboxModel, runSandboxModelBaseline, type CalcResult } from "@/server/sandbox-model";

/** 敏感性分析版本。1.1.0：新增可选 `layers`（把龙卷风锚定到「当前情景」= 地区/政策/用户分层，而非仅全局基线），纯加性、默认行为不变。 */
export const SENSITIVITY_VERSION = "1.1.0";
export function sensitivityCalcRef(): string {
  return `sensitivity@${SENSITIVITY_VERSION}`;
}

/** 可作敏感性目标的经济指标（均为 R2.4 程序算产出）。 */
export type MetricKey = "npv" | "irr" | "roi";

/** 参与敏感性扫描的参数（键 + 可选单独 delta%；缺省用全局 deltaPct）。 */
export interface SensitivityParam {
  key: string;
  deltaPct?: number;
}

/** 默认扫描集：覆盖收益/成本/资源/规模/财务五类第一杠杆（±按各自 delta）。 */
export const DEFAULT_SENSITIVITY_PARAMS: readonly SensitivityParam[] = [
  { key: "project.chargingPrice", deltaPct: 15 },
  { key: "region.elecPrice", deltaPct: 15 },
  { key: "project.trucksPerDay", deltaPct: 20 },
  { key: "project.pvCapacity", deltaPct: 20 },
  { key: "tech.pvCapex", deltaPct: 20 },
  { key: "region.pvEquivalentHours", deltaPct: 15 },
  { key: "policy.constructionSubsidy", deltaPct: 50 },
  { key: "finance.discountRate", deltaPct: 25 },
] as const;

/** 键→标签/单位（取自 R1.2 单一真源，绝不另立一份名字表）。 */
const LABELS: Record<string, { label: string; unit?: string }> = Object.fromEntries(
  SANDBOX_PARAMETER_SPECS.map((s) => [s.key, { label: s.label, unit: s.unit }]),
);

/** 从 CalcResult 取指定指标的可比较数值；不可得返回 null（诚实）。 */
function metricValue(res: CalcResult, metric: MetricKey): number | null {
  if (!res.ok) return null;
  if (metric === "npv") {
    return Number.isFinite(res.metrics.npv) ? res.metrics.npv : null;
  }
  if (metric === "irr") {
    return res.metrics.irr.ok && typeof res.metrics.irr.value === "number"
      ? res.metrics.irr.value
      : null;
  }
  // roi
  return res.metrics.roi.ok && typeof res.metrics.roi.value === "number"
    ? res.metrics.roi.value
    : null;
}

export interface TornadoRow {
  key: string;
  label: string;
  unit?: string;
  deltaPct: number;
  /** 扰动后的参数取值（低/高端，可能已被引擎裁剪到边界）。 */
  lowInput: number;
  highInput: number;
  baseMetric: number | null;
  lowMetric: number | null;
  highMetric: number | null;
  /** 摆幅 = highMetric − lowMetric（可正可负；null 表示指标不可得）。 */
  swing: number | null;
  /** |摆幅| 归一化到本次扫描最大摆幅（0–1），供画条宽；swing=null 时为 null。 */
  normalized?: number | null;
  notes: string[];
}

export interface TornadoResult {
  ok: true;
  calcRef: string;
  metric: MetricKey;
  baseValue: number | null;
  /** 按 |swing| 降序（null 沉底）。 */
  rows: TornadoRow[];
  /** 最敏感参数键（rows 第一且 swing 非 null）。 */
  mostSensitiveKey: string | null;
  needsProfessionalReview: true;
  notes: string[];
}

/** 基线数值快照（无覆写，解析一次即缓存）。 */
const BASELINE_NUMERIC: Record<string, number> = resolveSandbox().numeric;

/**
 * 在既有分层的 user 层上「单点覆写」某键（其余 user 覆写与 region/policy 层原样保留）。
 * `layers` 省略时退化为纯 user 单覆写（= 全局基线上扰动该键），与旧行为逐字一致。
 */
function withUserOverride(
  layers: Omit<ResolveLayers, "derived"> | undefined,
  key: string,
  value: number,
): Omit<ResolveLayers, "derived"> {
  const userValues = layers?.user?.values ?? {};
  return { ...layers, user: { ...layers?.user, values: { ...userValues, [key]: value } } };
}

/**
 * OAT 龙卷风敏感性扫描。`opts.layers` 省略时锚定 R1.2 全默认（旧行为）；传入时锚定到「当前情景」
 * （地区 / 政策 / 用户分层）——基线值、各参数生效值、扰动覆写均在该情景上叠加，使龙卷风与页面
 * 展示的 NPV/指标同源（§8 图表绑模型）。每个参数以 `values:{[key]: base×(1±delta)}` 覆写 →
 * `runSandboxModel` 重算 → 取指标。
 */
export function computeTornado(
  opts: {
    params?: readonly SensitivityParam[];
    metric?: MetricKey;
    deltaPct?: number;
    /** 锚定的分层情景（含 region/policy/user + now）；省略=全局基线。 */
    layers?: Omit<ResolveLayers, "derived">;
  } = {},
): TornadoResult {
  const metric: MetricKey = opts.metric ?? "npv";
  const globalDelta = opts.deltaPct ?? 20;
  const params = opts.params ?? DEFAULT_SENSITIVITY_PARAMS;
  const layers = opts.layers;

  const base = layers ? runSandboxModel(layers) : runSandboxModelBaseline();
  const baseValue = metricValue(base, metric);

  // 基线各参数生效值：取自参数引擎对应分层的数值快照（R1.2 单一真源；有情景则按情景解析）。
  const baseNumeric = layers ? resolveSandbox(layers).numeric : BASELINE_NUMERIC;

  const rows: TornadoRow[] = [];
  for (const p of params) {
    const delta = (p.deltaPct ?? globalDelta) / 100;
    const baseInput = baseNumeric[p.key];
    const notes: string[] = [];
    const meta = LABELS[p.key] ?? { label: p.key };

    if (typeof baseInput !== "number" || !Number.isFinite(baseInput)) {
      rows.push({
        key: p.key,
        label: meta.label,
        unit: meta.unit,
        deltaPct: delta * 100,
        lowInput: NaN,
        highInput: NaN,
        baseMetric: baseValue,
        lowMetric: null,
        highMetric: null,
        swing: null,
        normalized: null,
        notes: [`基线未取到 ${p.key} 的生效值，无法扰动`],
      });
      continue;
    }

    const lowInput = baseInput * (1 - delta);
    const highInput = baseInput * (1 + delta);
    const lowRes = runSandboxModel(withUserOverride(layers, p.key, lowInput));
    const highRes = runSandboxModel(withUserOverride(layers, p.key, highInput));
    const lowMetric = metricValue(lowRes, metric);
    const highMetric = metricValue(highRes, metric);
    if (!lowRes.ok) notes.push(`低端模型未通过：${lowRes.reason}`);
    if (!highRes.ok) notes.push(`高端模型未通过：${highRes.reason}`);
    const swing =
      lowMetric != null && highMetric != null ? highMetric - lowMetric : null;
    if (swing == null) notes.push("指标在扰动端不可得（NaN/无解），摆幅记 null，不编造");

    rows.push({
      key: p.key,
      label: meta.label,
      unit: meta.unit,
      deltaPct: delta * 100,
      lowInput,
      highInput,
      baseMetric: baseValue,
      lowMetric,
      highMetric,
      swing,
      notes,
    });
  }

  // 排序：|swing| 降序，null 沉底。
  rows.sort((a, b) => {
    const av = a.swing == null ? -Infinity : Math.abs(a.swing);
    const bv = b.swing == null ? -Infinity : Math.abs(b.swing);
    return bv - av;
  });

  // 归一化条宽。
  const maxAbs = rows.reduce(
    (m, r) => (r.swing == null ? m : Math.max(m, Math.abs(r.swing))),
    0,
  );
  for (const r of rows) {
    r.normalized = r.swing == null || maxAbs === 0 ? (r.swing == null ? null : 0) : Math.abs(r.swing) / maxAbs;
  }

  const top = rows.find((r) => r.swing != null);
  const notes: string[] = [];
  if (baseValue == null) notes.push("基线目标指标不可得，龙卷风图各行摆幅多为 null，仅供参考");

  return {
    ok: true,
    calcRef: sensitivityCalcRef(),
    metric,
    baseValue,
    rows,
    mostSensitiveKey: top ? top.key : null,
    needsProfessionalReview: true,
    notes,
  };
}

/**
 * 高风险标记（§16）：从一次 `CalcResult` 派生"须专业人工确认"的具体关注点列表。
 * 纯读取、不改数值。沙盘所有结论本就 needsProfessionalReview，这里给出**可展示的理由清单**。
 */
export function deriveRiskFlags(res: CalcResult): {
  needsProfessionalReview: boolean;
  flags: string[];
} {
  if (!res.ok) {
    return { needsProfessionalReview: true, flags: [`模型未通过（${res.reason}），结论不可用，须人工核查输入`] };
  }
  const flags: string[] = [
    "本沙盘为透明简化年度估算（非可研/逐时/财税级），投资与并网决策须经专业人工确认",
    "全部关键输入为占位假设（ASSUMPTION），须逐项替换为可追溯来源后重算",
  ];
  if (!Number.isFinite(res.metrics.npv)) flags.push("NPV 计算失败（NaN）：折现率/现金流异常，须人工排查");
  else if (res.metrics.npv < 0) flags.push("NPV<0：按当前假设项目不可行，须复核参数或方案");
  if (!res.metrics.irr.ok) flags.push(`IRR 不可得（${res.metrics.irr.reason}）：现金流形态非常规或无正解`);
  if (res.metrics.discountedPaybackYears == null)
    flags.push("折现回收期超出计算期：分析期内未回本");
  if (res.metrics.irr.multipleRootsPossible)
    flags.push("现金流存在多次符号变化，IRR 可能多解，解读需谨慎");
  return { needsProfessionalReview: true, flags };
}
