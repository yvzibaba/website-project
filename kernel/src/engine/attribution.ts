/**
 * 差异归因（M6 · 两情景对比的"差在哪、各差多少"）—— R2 的灵魂交付。
 *
 * ## 为什么"并排摆两个数"不等于"归因"
 *
 * 现有的场景比较只是一张表：情景 A 的 NPV、情景 B 的 NPV，并排一放。
 * 它能回答"B 比 A 多了多少钱"，却回答不了决策者真正会追问的那句话——
 * **"多出来的这些钱，是你改了哪几个参数换来的？每个参数各贡献了多少？"**
 * 这两者的差别，就是"报表"和"决策依据"的差别。
 *
 * ## 本模块做的三件事（都基于**唯一计算入口** `runCalculation()`）
 *
 * 1. **指标对照表**：把两个情景的关键经济/物理指标逐条并排（NPV / 资本金 NPV /
 *    IRR / 回收期 / ROI / 度电成本 / 净投资 / 交付电量），给出各自取值与差值。
 *    全部从 `CalculationResult` 直接读，本模块**不参与任何计算**。
 * 2. **输入参数差异**：对两份输入快照做**确定性结构 diff**，列出"到底改了哪几个字段、
 *    从多少改到多少"。刻意排除不参与计算的字段（`name`/`note`/`schemaVersion`/
 *    `definition` 的展示性字段），否则用户会看到一堆与结论无关的"差异"。
 * 3. **逐参数 NPV 归因（一阶反事实）**：从 A 出发，把第 2 步列出的每个改动**按字典序
 *    依次单独替换为 B 的值**，每替换一步重跑一次引擎，得到"这一步换来了多少目标增量"。
 *    这是唯一既**诚实**又**可复算**的做法——它不复用任何公式，数字与报告同源。
 *
 * ## 它做不到什么（必须写在明处，绝不假装精确）
 *
 * - **一阶归因是路径相关的**：把参数从 A 值逐个改到 B 值，"谁先改谁后改"会影响每一步的
 *   边际贡献（因为指标之间非线性）。要消除路径依赖需做 Shapley 展开（组合数 2ⁿ 次引擎），
 *   不现实。所以本模块给出的是**一个确定、可复现的归因顺序下的分解**，并显式记录顺序，
 *   **不宣称为唯一/公正的拆分**。
 * - **残差**：逐参数边际贡献之和 ≠ 总变化，差额叫"残差"。它不是误差，而是**参数间交互效应**
 *   与**无法单独隔离的组合变化**（例如某些参数一改就触发可行性/守恒失败，单独评估不成立）。
 *   残差原样给出并解释，绝不摊平到某个参数上假装自洽。
 * - **不可隔离项**：单独替换某个参数会让引擎判定为不可行/计算失败的，标为
 *   `not_isolable` 并附原因，**不编一个数字填上去**。
 *
 * ## 纯度约束（与引擎、推荐层同等）
 *
 * 不读时钟、不读随机、不读环境变量、不访问网络、不碰数据库、结果不含耗时。
 * 同一对输入 → 逐字节相同的归因结果，这样"归因"才能进审计、才能回归测试。
 */

import { ENGINE_VERSION, MODEL_VERSION, runCalculation } from "@app/kernel/engine/engine";
import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import { round } from "@app/kernel/server/finance";
import type { CalculationResult, ScenarioInput } from "@app/kernel/engine/types";

/** 归因模型版本（改"排除哪些字段 / 归因顺序 / 指标口径 / 残差定义"= 必须升版）。 */
export const ATTRIBUTION_VERSION = "1.0.0";

export function attributionCalcRef(): string {
  return `attrib@${ATTRIBUTION_VERSION}`;
}

/* ═══════════════════════════ 目标函数 ═══════════════════════════ */

/**
 * 归因的度量口径。默认全投资 NPV（元）。
 * 之所以允许切换：决策者关心的常常是"股东的钱划不划算"（资本金）或"多久回本"（回收期），
 * 归因应对着他真正盯的那个指标去拆，而不是自顾自拆 NPV。
 */
export type AttributionObjective = "npv" | "equityNpv" | "payback";

export const ATTRIBUTION_OBJECTIVES: ReadonlyArray<{
  id: AttributionObjective;
  label: string;
  unit: string;
  higherIsBetter: boolean;
}> = [
  { id: "npv", label: "全投资净现值 NPV", unit: "元", higherIsBetter: true },
  { id: "equityNpv", label: "资本金净现值 NPV", unit: "元", higherIsBetter: true },
  { id: "payback", label: "静态回收期", unit: "年", higherIsBetter: false },
];

/** 读取一次计算结果在指定目标口径下的数值（不可算时返回 null）。 */
function objectiveOf(calc: CalculationResult, objective: AttributionObjective): number | null {
  switch (objective) {
    case "npv":
      return calc.economics.metrics.npvYuan;
    case "equityNpv":
      return calc.economics.metrics.equity.npvYuan;
    case "payback":
      return calc.economics.metrics.simplePaybackYears;
  }
}

/* ═══════════════════════════ 输出契约 ═══════════════════════════ */

export interface MetricRow {
  key: string;
  label: string;
  unit: string;
  /** A 的取值（原始数值；null 表示本情景该指标不可算）。 */
  a: number | null;
  /** B 的取值。 */
  b: number | null;
  /** 差值 = b − a（任一为 null 则为 null）。 */
  delta: number | null;
}

export interface InputChange {
  /** 参数路径，如 `pv.capacityKwp`。 */
  path: string;
  /** 展示名（有词表则用词表，否则回退为路径本身，避免误导）。 */
  label: string;
  /** A 的值（标量/枚举/数组，原样，供展示）。 */
  from: unknown;
  /** B 的值。 */
  to: unknown;
}

export interface AttributionRow {
  path: string;
  label: string;
  from: unknown;
  to: unknown;
  /**
   * 归因状态：
   *  - `ok`            单独替换该参数后引擎仍算得通，`marginalDelta` 是其边际贡献；
   *  - `not_isolable`  单独替换该参数导致引擎判定不可行/失败，无法给出该步的边际贡献。
   */
  status: "ok" | "not_isolable";
  /** 该步之后的目标累计值（status=ok 时有效）。 */
  metricAfter: number | null;
  /** 本步边际贡献 = 本步目标 − 上一步目标（status=ok 时有效；单位同目标）。 */
  marginalDelta: number | null;
  /** not_isolable 时给出原因，绝不空着。 */
  reason?: string;
}

export interface ScenarioAttribution {
  ok: true;
  attributionRef: string;
  engineVersion: string;
  modelVersion: string;
  benchmarkVersion: string;
  objective: AttributionObjective;
  objectiveLabel: string;
  objectiveUnit: string;

  /** A、B 各自的输入指纹与情景名（可复算/可追溯的锚点）。 */
  sideA: { name: string; inputHash: string };
  sideB: { name: string; inputHash: string };

  /** 指标对照表。 */
  metrics: MetricRow[];
  /** 改动的输入参数（确定性、按路径字典序）。 */
  changedInputs: InputChange[];
  /** 逐参数一阶归因（顺序 = changedInputs 的字典序，已显式披露路径相关性）。 */
  rows: AttributionRow[];

  /** 目标口径下 A → B 的总变化。 */
  totalDelta: number;
  baseValue: number;
  targetValue: number;
  /** 可归因部分 = Σ rows(status=ok).marginalDelta。 */
  attributableDelta: number;
  /** 残差 = totalDelta − attributableDelta（交互效应 + 不可隔离组合，原样给出）。 */
  residual: number;
  /** 归因顺序（路径序列），用于复现与审计。 */
  order: string[];
  /** 贡献绝对值最大的参数（可能为 null：无可归因项时）。 */
  topDriver: { path: string; label: string; marginalDelta: number } | null;

  /** 程序生成的解释文本（非 LLM），回答"差在哪几个参数、各差多少、哪些说不清"。 */
  explanation: { summary: string; paragraphs: string[] };
}

export interface AttributionFailure {
  ok: false;
  attributionRef: string;
  engineVersion: string;
  reason: "invalid_input_a" | "invalid_input_b" | "no_input" | "same_input";
  detail: string;
}

export type AttributionOutcome = ScenarioAttribution | AttributionFailure;

/* ═══════════════════════════ 结构 diff 工具 ═══════════════════════════ */

/**
 * 不参与计算的字段——它们变了也不会改变结论，列出来只会稀释归因。
 * `definition.components` / `definition.managedCharging` 是参与计算的，故不在排除之列。
 */
const NON_COMPUTING_PATHS = new Set<string>([
  "schemaVersion",
  "name",
  "note",
  "definition.id",
  "definition.label",
  "definition.intent",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function leafEqual(a: unknown, b: unknown): boolean {
  // 数组与标量都按"叶子"处理，用稳定序列化比较（键序无关由调用侧的对象结构保证）。
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 递归收集两份输入的叶子差异，按路径字典序返回（确定性）。 */
function diffInputs(a: Record<string, unknown>, b: Record<string, unknown>, prefix: string, out: InputChange[]): void {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (NON_COMPUTING_PATHS.has(path)) continue;
    const av = a[key];
    const bv = b[key];
    const bothObj = isPlainObject(av) && isPlainObject(bv);
    if (bothObj) {
      diffInputs(av, bv, path, out);
      continue;
    }
    // 一方是对象、另一方不是（结构变化），或任一方是叶子 → 作为叶子差异记录。
    if (!leafEqual(av, bv)) {
      out.push({ path, label: labelForPath(path), from: av ?? null, to: bv ?? null });
    }
  }
}

/** 沿路径把叶子值替换进去，返回新对象（不改动入参，保证纯函数）。 */
function withLeaf(root: unknown, segs: string[], value: unknown): unknown {
  if (segs.length === 0) return value;
  const [head, ...rest] = segs;
  const base = isPlainObject(root) ? root : {};
  return { ...base, [head]: withLeaf(base[head], rest, value) };
}

/* ═══════════════════════════ 展示词表（可缺省，缺省回退路径） ═══════════════════════════ */

const PARAM_LABELS: Record<string, string> = {
  "definition.components": "参与计算的能力组合",
  "definition.managedCharging": "是否启用有序充电",
  "truck.truckCount": "车队规模（辆）",
  "truck.payloadTons": "额定载重（吨）",
  "truck.dailyMileageKm": "单车日均里程（km）",
  "truck.operatingDays": "年运营天数",
  "truck.energyConsumptionKwhPerKm": "单位能耗（kWh/km）",
  "truck.chargingWindowStartHour": "充电窗口起（时）",
  "truck.chargingWindowEndHour": "充电窗口止（时）",
  "truck.chargingStrategy": "充电策略",
  "charging.mode": "补能方式",
  "charging.swapSharePct": "换电需求占比（%）",
  "charging.charger.chargerCount": "充电桩数量",
  "charging.charger.chargerPowerKw": "单桩功率（kW）",
  "charging.charger.simultaneousRatePct": "同时使用率（%）",
  "charging.swap.stationCount": "换电站数量",
  "charging.swap.chargingPowerKwPerStation": "单站换电功率（kW）",
  "pv.enabled": "是否配置光伏",
  "pv.capacityKwp": "光伏装机（kWp）",
  "pv.specificYieldKwhPerKwp": "光伏年利用小时（kWh/kWp）",
  "bess.enabled": "是否配置储能",
  "bess.powerKw": "储能功率（kW）",
  "bess.energyKwh": "储能容量（kWh）",
  "bess.strategy": "储能策略",
  "grid.capacityKw": "并网容量（kW）",
  "grid.importLimitKw": "受电容量上限（kW）",
  "grid.flatPriceYuanPerKwh": "平段电价（元/kWh）",
  "grid.peakMultiplier": "峰段电价倍数",
  "grid.valleyMultiplier": "谷段电价倍数",
  "grid.demandPriceYuanPerKwMonth": "需量电价（元/kW·月）",
  "economics.chargingServiceFeeYuanPerKwh": "充电服务费（元/kWh）",
  "economics.pvCapexYuanPerW": "光伏单位造价（元/W）",
  "economics.bessCapexYuanPerWh": "储能单位造价（元/Wh）",
  "economics.chargerCapexYuanPerKw": "充电设施单位造价（元/kW）",
  "economics.discountRatePct": "折现率（%）",
  "economics.equityRatioPct": "资本金比例（%）",
  "economics.operationYears": "运营年限",
};

function labelForPath(path: string): string {
  return PARAM_LABELS[path] ?? path;
}

/* ═══════════════════════════ 指标对照 ═══════════════════════════ */

function metricRow(key: string, label: string, unit: string, a: number | null, b: number | null): MetricRow {
  return { key, label, unit, a, b, delta: a === null || b === null ? null : round(b - a, 2) };
}

function irrPct(m: CalculationResult["economics"]["metrics"], equity = false): number | null {
  const i = equity ? m.equity.irr : m.irr;
  return i.ok ? (i.valuePct ?? null) : null;
}

function buildMetrics(a: CalculationResult, b: CalculationResult): MetricRow[] {
  const ma = a.economics.metrics;
  const mb = b.economics.metrics;
  return [
    metricRow("npv", "全投资 NPV", "元", ma.npvYuan, mb.npvYuan),
    metricRow("equityNpv", "资本金 NPV", "元", ma.equity.npvYuan, mb.equity.npvYuan),
    metricRow("irr", "全投资 IRR", "%", irrPct(ma), irrPct(mb)),
    metricRow("payback", "静态回收期", "年", ma.simplePaybackYears, mb.simplePaybackYears),
    metricRow("discountedPayback", "折现回收期", "年", ma.discountedPaybackYears, mb.discountedPaybackYears),
    metricRow("lcoe", "度电成本（自有口径）", "元/kWh", ma.lcoeYuanPerKwh, mb.lcoeYuanPerKwh),
    metricRow("capexNet", "净投资", "元", a.economics.capex.netYuan, b.economics.capex.netYuan),
    metricRow("deliveredKwh", "年交付电量（电池侧）", "kWh", round(a.charging.annualDeliveredKwh, 1), round(b.charging.annualDeliveredKwh, 1)),
  ];
}

/* ═══════════════════════════ 数字格式化（仅展示，不参与结论） ═══════════════════════════ */

function fmtWan(v: number): string {
  const wan = v / 10_000;
  const sign = wan < 0 ? "-" : "";
  return `${sign}${Math.abs(wan).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万元`;
}
function fmtObj(v: number, objective: AttributionObjective): string {
  if (objective === "payback") return `${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 年`;
  return fmtWan(v);
}
function fmtSignedObj(v: number, objective: AttributionObjective): string {
  const s = v > 0 ? "+" : v < 0 ? "-" : "";
  const mag = Math.abs(v);
  if (objective === "payback") return `${s}${mag.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 年`;
  return `${s}${fmtWan(mag)}`;
}

/* ═══════════════════════════ 主入口 ═══════════════════════════ */

export interface AttributionOptions {
  objective?: AttributionObjective;
}

/**
 * 对同一套引擎下的两个情景输入做差异归因。
 * 输入是两份 `ScenarioInput`（通常来自各自存档快照），输出是可复现的结构化归因。
 */
export function attributeScenarioDelta(
  inputA: ScenarioInput | null | undefined,
  inputB: ScenarioInput | null | undefined,
  opts: AttributionOptions = {},
): AttributionOutcome {
  const objective: AttributionObjective = opts.objective ?? "npv";
  const meta = {
    attributionRef: attributionCalcRef(),
    engineVersion: ENGINE_VERSION,
    modelVersion: MODEL_VERSION,
    benchmarkVersion: BENCHMARK_VERSION,
  };

  if (!inputA || !inputB) {
    return { ...meta, ok: false, reason: "no_input", detail: "两个情景都需有可复算的输入快照才能归因。" };
  }

  const calcA = runCalculation(inputA);
  if (!calcA.ok) {
    return { ...meta, ok: false, reason: "invalid_input_a", detail: `起点情景在当前引擎下算不通：${calcA.detail}` };
  }
  const calcB = runCalculation(inputB);
  if (!calcB.ok) {
    return { ...meta, ok: false, reason: "invalid_input_b", detail: `对照情景在当前引擎下算不通：${calcB.detail}` };
  }

  // 结构 diff（确定性、字典序）。
  const changedInputs: InputChange[] = [];
  diffInputs(inputA as unknown as Record<string, unknown>, inputB as unknown as Record<string, unknown>, "", changedInputs);

  const objA = objectiveOf(calcA, objective);
  const objB = objectiveOf(calcB, objective);
  const metaObj = ATTRIBUTION_OBJECTIVES.find((o) => o.id === objective)!;

  if (changedInputs.length === 0) {
    return { ...meta, ok: false, reason: "same_input", detail: "两个情景参与计算的输入完全一致，没有可归因的差异。" };
  }

  // 若目标口径在某侧不可算（如回收期"未回本"= null），无法做该口径的逐参数分解，退回 NPV 并在解释中说明。
  const objectiveComputable = objA !== null && objB !== null;
  const effObjective: AttributionObjective = objectiveComputable ? objective : "npv";
  const effMeta = ATTRIBUTION_OBJECTIVES.find((o) => o.id === effObjective)!;

  const baseValue = (objectiveComputable ? objA : calcA.economics.metrics.npvYuan) as number;
  const targetValue = (objectiveComputable ? objB : calcB.economics.metrics.npvYuan) as number;

  // 一阶反事实：从 A 出发，按字典序逐个把参数改到 B 的值，每步重跑引擎。
  const rows: AttributionRow[] = [];
  let running: unknown = inputA;
  let prevMetric = baseValue;
  for (const ch of changedInputs) {
    const segs = ch.path.split(".");
    running = withLeaf(running, segs, ch.to);
    const candidate = running as ScenarioInput;
    const res = runCalculation(candidate);
    if (!res.ok) {
      rows.push({
        path: ch.path,
        label: ch.label,
        from: ch.from,
        to: ch.to,
        status: "not_isolable",
        metricAfter: null,
        marginalDelta: null,
        reason: `单独改这一项会让方案在该步算不通（${res.reason}）：${res.detail}`,
      });
      // 不推进 prevMetric：这一步的贡献并入残差（耦合），保持诚实。
      continue;
    }
    const m = objectiveOf(res, effObjective);
    if (m === null) {
      rows.push({
        path: ch.path,
        label: ch.label,
        from: ch.from,
        to: ch.to,
        status: "not_isolable",
        metricAfter: null,
        marginalDelta: null,
        reason: `该步在此目标口径下不可算（如回收期未回本），不给出虚构的边际贡献。`,
      });
      continue;
    }
    rows.push({
      path: ch.path,
      label: ch.label,
      from: ch.from,
      to: ch.to,
      status: "ok",
      metricAfter: round(m, 2),
      marginalDelta: round(m - prevMetric, 2),
    });
    prevMetric = m;
  }

  const totalDelta = round(targetValue - baseValue, 2);
  const attributableDelta = round(
    rows.reduce((s, r) => (r.status === "ok" && r.marginalDelta !== null ? s + r.marginalDelta : s), 0),
    2,
  );
  const residual = round(totalDelta - attributableDelta, 2);

  const okRows = rows.filter((r) => r.status === "ok" && r.marginalDelta !== null);
  let topDriver: ScenarioAttribution["topDriver"] = null;
  if (okRows.length) {
    const t = okRows.reduce((best, r) => (Math.abs(r.marginalDelta!) > Math.abs(best.marginalDelta!) ? r : best), okRows[0]);
    if (Math.abs(t.marginalDelta!) > 0) topDriver = { path: t.path, label: t.label, marginalDelta: t.marginalDelta! };
  }

  const explanation = buildExplanation({
    metaObj: effMeta,
    baseValue,
    targetValue,
    totalDelta,
    attributableDelta,
    residual,
    topDriver,
    notIsolable: rows.filter((r) => r.status === "not_isolable"),
    fellBack: !objectiveComputable && objective !== "npv",
    requestedLabel: metaObj.label,
  });

  return {
    ok: true,
    ...meta,
    objective: effObjective,
    objectiveLabel: effMeta.label,
    objectiveUnit: effMeta.unit,
    sideA: { name: inputA.name ?? "情景 A", inputHash: calcA.inputHash },
    sideB: { name: inputB.name ?? "情景 B", inputHash: calcB.inputHash },
    metrics: buildMetrics(calcA, calcB),
    changedInputs,
    rows,
    totalDelta,
    baseValue: round(baseValue, 2),
    targetValue: round(targetValue, 2),
    attributableDelta,
    residual,
    order: changedInputs.map((c) => c.path),
    topDriver,
    explanation,
  };
}

/* ═══════════════════════════ 解释生成（程序产出，可追溯） ═══════════════════════════ */

function buildExplanation(args: {
  metaObj: { id: AttributionObjective; label: string; unit: string; higherIsBetter: boolean };
  baseValue: number;
  targetValue: number;
  totalDelta: number;
  attributableDelta: number;
  residual: number;
  topDriver: { label: string; marginalDelta: number } | null;
  notIsolable: AttributionRow[];
  fellBack: boolean;
  requestedLabel: string;
}): ScenarioAttribution["explanation"] {
  const { metaObj, baseValue, targetValue, totalDelta, attributableDelta, residual, topDriver, notIsolable, fellBack } = args;
  const o = metaObj.id === "payback" ? "payback" : "npv";
  const dir = totalDelta === 0 ? "无净变化" : metaObj.higherIsBetter ? (totalDelta > 0 ? "改善" : "恶化") : totalDelta < 0 ? "改善" : "恶化";

  const summary =
    `对照情景相对基线情景，${metaObj.label}从 ${fmtObj(baseValue, o)} 变为 ${fmtObj(targetValue, o)}，` +
    `净变化 ${fmtSignedObj(totalDelta, o)}（${dir}）。`;

  const paragraphs: string[] = [];
  if (fellBack) paragraphs.push(`所选目标口径「${args.requestedLabel}」在某侧不可算，本次归因退回全投资 NPV 口径。`);
  paragraphs.push(
    `其中可逐参数拆出贡献的合计为 ${fmtSignedObj(attributableDelta, o)}；` +
      `与总变化的差额（残差 ${fmtSignedObj(residual, o)}）来自参数间的交互效应与无法单独隔离的组合变化——这是模型非线性的如实反映，不是算错。`,
  );
  if (topDriver) {
    paragraphs.push(`单看逐个替换，影响最大的一步是「${topDriver.label}」，该步换来 ${fmtSignedObj(topDriver.marginalDelta, o)}。`);
  }
  if (notIsolable.length) {
    paragraphs.push(
      `有 ${notIsolable.length} 项改动无法单独归因（单独改会让方案在该步算不通），其贡献已并入残差：${notIsolable
        .map((r) => r.label)
        .join("、")}。`,
    );
  }
  paragraphs.push(
    "归因顺序按参数路径字典序固定，因此该分解可复现；但一阶归因存在路径依赖，" +
      "各步贡献的绝对切分不宣称为唯一公正——要精确到公平拆分需做组合展开，代价与不确定性都更高。",
  );
  return { summary, paragraphs };
}
