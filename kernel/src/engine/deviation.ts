/**
 * R6 · 预测 vs 实测偏差分析（**纯领域层**，`M13`）。
 *
 * ## 这一层在整个闭环里的位置
 *   Forecast（存档快照）+ Actual（实测回填）
 *        ↓  本模块
 *   Deviation（偏差）→ Impact（影响，量纲内换算）→ CalibrationCandidate（校准建议）
 *
 * ## 三条铁律（对应任务书 §1 / §5 / §14 / §30 / §34）
 *   1. **不重算、不碰引擎**：本文件绝不 `import` `runCalculation`、benchmark、engine。
 *      它只吃两份「已经算好/量好」的数据：一份是落库时冻结的 `ForecastSnapshot`，
 *      一份是实测行。因此「历史预测」永远不会被今天的模型悄悄改写（§3/§5）。
 *   2. **不写库、无副作用**：纯函数，输入相同输出必相同；不 `import` prisma / node 运行时。
 *      落库与鉴权全在 service 层。也正因如此它能过 `kernel:verify`（无框架依赖）。
 *   3. **不复制经济公式**：影响分析（Impact）只做**同量纲换算**——
 *      钱对钱是精确差；电量偏差若要折成钱，只乘**预测自身**给出的隐含单价（比值，来自存档快照，
 *      非模型公式），并一律标注 `evidenceKind:"ASSUMPTION"`。NPV/IRR 等跨期指标**不在此臆算**，
 *      需要严谨重算时必须经唯一引擎另建对照情景（见 service 层注释），本层一个折现公式都不写。
 *
 * ## null ≠ 0（§9）
 *   实测留空 = 没测 = `null`，绝不是 0。少了这条，「光伏还没装表」会被算成「光伏一度没发 = -100%」，
 *   得出与事实完全相反的结论。因此 `MISSING_ACTUAL` 与「实测为零」是两种不同状态。
 */

import type { CalculationResult } from "./types";

/* ═══════════════════════════ 1. ForecastSnapshot：冻结的「预测侧」机器可读快照 ═══════════════════════════ */

/**
 * 预测身份（§4）：一份偏差分析必须能说清「实测到底在和哪一次预测比」。
 * 全部来自被计算的 `CalculationResult`，本层不新增任何真源。
 */
export interface ForecastIdentity {
  engineVersion: string; // calc.calcRef（如 calc@2.0.0）
  modelVersion: string; // calc.engineVersion（纯版本号 2.0.0）
  benchmarkVersion: string; // calc.benchmarkVersion
  inputHash: string; // calc.inputHash
  scenarioSchemaVersion: string; // calc.inputSnapshot.schemaVersion
  regionId: string; // calc.inputSnapshot.site.regionId（跨项目聚合分组用）
  /** 该快照的口径版本（结构演进时可判别，避免旧快照被误读）。 */
  snapshotSchema: "forecast-snapshot/v1";
}

/** 年度预测量（与 `ProjectActual` 各列一一对应，同量纲、同口径才可比）。 */
export interface ForecastAnnual {
  gridImportKwh: number | null; // grid.annualImportKwh（电网侧下网）
  pvGenerationKwh: number | null; // pv.annualGenerationKwh（AC 侧发电）
  bessDischargeKwh: number | null; // bess.annualDischargeKwh（AC 侧放电）
  deliveredKwh: number | null; // charging.annualDeliveredKwh（电池侧交付）
  exportKwh: number | null; // grid.annualExportKwh（上网）
  gridCostYuan: number | null; // grid.annualGridCostYuan（电量+需量−上网收入）
  serviceRevenueYuan: number | null; // revenueY1.charging + swap 服务费（与实测「充电/服务费收入」同口径）
  grossRevenueYuan: number | null; // revenueY1.grossYuan（参考，口径更宽，不默认用于比对）
  opexYuan: number | null; // opexY1.grossYuan（含土地+保险，口径备注见 comparabilityNotes）
}

/** 逐月预测量（引擎已按正确月界算好、可直接复用的数组，长度 12；不重导时间序列以防月界漂移）。 */
export interface ForecastMonthly {
  pvGenerationKwh: number[]; // pv.monthlyGenerationKwh
}

/**
 * 预测自身的隐含单价（**比值，不是模型**）：仅用于把「电量偏差」同口径折成「金额量级」，
 * 且始终标 `ASSUMPTION`。分子/分母都取自同一次预测，不引入任何外部参数。
 */
export interface ImpliedUnitEconomics {
  costPerImportKwhYuan: number | null; // annualGridCostYuan ÷ annualImportKwh（购电侧）
  serviceFeePerDeliveredKwhYuan: number | null; // serviceRevenueYuan ÷ annualChargingDeliveredKwh（服务费侧）
}

export interface ForecastSnapshot {
  identity: ForecastIdentity;
  annual: ForecastAnnual;
  monthly: ForecastMonthly;
  implied: ImpliedUnitEconomics;
  /**
   * 逐度电口径说明：某些量两边并非严格同口径（如「购电成本」预测含需量与上网冲抵、
   * 「运维」预测含土地与保险）。这里把差异写清楚，UI 与报告据此提示，而不是假装完全可比。
   */
  comparabilityNotes: Record<string, string>;
}

/** 非有限数（NaN/Infinity）一律归 null：宁缺毋假（与引擎失败时数字列全 null 同纪律）。 */
function fin(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 逐项把非有限数换成 null（数组保持长度，坏点单独置 null，不影响其它月）。 */
function finArray(arr: readonly number[] | undefined, len: number): number[] {
  const out: number[] = new Array(len).fill(null as unknown as number);
  for (let i = 0; i < len; i++) {
    const raw = arr && typeof arr[i] === "number" && Number.isFinite(arr[i]) ? (arr[i] as number) : (null as unknown as number);
    out[i] = raw;
  }
  return out;
}

/**
 * `CalculationResult` → `ForecastSnapshot` 的**只读投影**。
 *
 * 关键：本函数在**写库路径**被调用（`decisionSnapshotToColumns`），输入就是刚算好的 `calc`——
 * 它不重新计算、不改 `calc` 的任何字段，只把与实测可比的量挑出来冻一份。
 * 因此它对黄金基线零影响（黄金测钉的是 `runCalculation` 的输出，不是这一列）。
 */
export function buildForecastSnapshot(calc: CalculationResult): ForecastSnapshot {
  const gridImport = fin(calc.grid.annualImportKwh);
  const gridCost = fin(calc.grid.annualGridCostYuan);
  const chargingDelivered = fin(calc.charging.annualChargingDeliveredKwh);
  const serviceRevenue =
    fin(calc.economics.revenueY1.chargingServiceYuan) !== null || fin(calc.economics.revenueY1.swapServiceYuan) !== null
      ? (fin(calc.economics.revenueY1.chargingServiceYuan) ?? 0) + (fin(calc.economics.revenueY1.swapServiceYuan) ?? 0)
      : null;

  return {
    identity: {
      engineVersion: calc.calcRef,
      modelVersion: calc.engineVersion,
      benchmarkVersion: calc.benchmarkVersion,
      inputHash: calc.inputHash,
      scenarioSchemaVersion: calc.inputSnapshot?.schemaVersion ?? "unknown",
      regionId: calc.inputSnapshot?.site?.regionId ?? "unknown",
      snapshotSchema: "forecast-snapshot/v1",
    },
    annual: {
      gridImportKwh: gridImport,
      pvGenerationKwh: fin(calc.pv.annualGenerationKwh),
      bessDischargeKwh: fin(calc.bess.annualDischargeKwh),
      deliveredKwh: fin(calc.charging.annualDeliveredKwh),
      exportKwh: fin(calc.grid.annualExportKwh),
      gridCostYuan: gridCost,
      serviceRevenueYuan: serviceRevenue,
      grossRevenueYuan: fin(calc.economics.revenueY1.grossYuan),
      opexYuan: fin(calc.economics.opexY1.grossYuan),
    },
    monthly: {
      pvGenerationKwh: finArray(calc.pv.monthlyGenerationKwh, 12),
    },
    implied: {
      costPerImportKwhYuan:
        gridCost !== null && gridImport !== null && gridImport > 0 ? gridCost / gridImport : null,
      serviceFeePerDeliveredKwhYuan:
        serviceRevenue !== null && chargingDelivered !== null && chargingDelivered > 0
          ? serviceRevenue / chargingDelivered
          : null,
    },
    comparabilityNotes: {
      gridCostYuan: "预测「购电成本」= 电量电费 + 需量电费 − 上网收入；当前免需量政策下需量电费为 0。",
      revenueYuan: "预测「充电/服务费收入」= 充电服务费 + 换电服务费，不含转供电费、运营补贴与其他收入。",
      opexYuan: "预测「运维支出」为宽口径，含场地固定运维、土地租金与保险；若实测仅记运维，请知悉口径差异。",
    },
  };
}

/* ═══════════════════════════ 2. 指标目录：实测列 ↔ 预测字段（口径/单位/参数溯源） ═══════════════════════════ */

/**
 * 一个「可对比指标」的定义。两边必须**同单位、同量纲口径（basis）**才允许计算偏差（§11）。
 * basis 用稳定的机读串：不一致即判 `NOT_COMPARABLE`，绝不跨口径硬比
 * （例：拿电池侧实测去比电网侧预测）。
 */
export interface MetricDef {
  /** 机读键（候选/证据引用它）。 */
  key: string;
  /** 人读名（UI/建议文案）。 */
  label: string;
  /** 对应的 `ProjectActual` 列名（实测侧字段）。 */
  actualField: keyof ActualLike;
  /** 年度：对应的 `ForecastAnnual` 字段。 */
  annualField?: keyof ForecastAnnual;
  /** 逐月：对应的 `ForecastMonthly` 字段（引擎已给好的月度数组）。 */
  monthlyField?: keyof ForecastMonthly;
  unit: string;
  basis: string;
  /** 偏差方向持续时，最可能应复核的参数（供建议引用；本层绝不改它）。 */
  paramKey?: string;
  paramLabel?: string;
  /** 建议模板：`{over}`=预测偏高、`{under}`=预测偏低 时的措辞由检测层拼装。 */
  suggestionHint?: string;
}

/** 目录只列「两边都取得到数、且口径可比」的指标。availabilityPct 无预测侧 → 不在此列（会被显式标为不可比）。 */
export const DEVIATION_METRICS: readonly MetricDef[] = [
  {
    key: "pvGenerationKwh",
    label: "光伏发电量",
    actualField: "pvGenerationKwh",
    annualField: "pvGenerationKwh",
    monthlyField: "pvGenerationKwh",
    unit: "kWh",
    basis: "pv-ac-generation",
    paramKey: "pv.specificYieldKwhPerKwp",
    paramLabel: "光伏年等效利用小时（产能基准）",
    suggestionHint: "建议复核该地区光伏产能基准（等效利用小时/资源数据）。",
  },
  {
    key: "gridImportKwh",
    label: "电网侧购电量",
    actualField: "gridImportKwh",
    annualField: "gridImportKwh",
    unit: "kWh",
    basis: "grid-side-import",
    paramKey: "truck.energyConsumptionKwhPerKm / truck.dailyMileageKm / charging.chargingStrategy",
    paramLabel: "车辆能耗 / 里程 / 充电策略",
    suggestionHint: "建议复核车辆能耗、里程或充电策略假设。",
  },
  {
    key: "deliveredKwh",
    label: "交付给车辆的电量",
    actualField: "deliveredKwh",
    annualField: "deliveredKwh",
    unit: "kWh",
    basis: "battery-side-delivered",
    paramKey: "truck.truckCount / truck.operatingDaysPerYear",
    paramLabel: "车队规模 / 运营天数",
    suggestionHint: "建议复核实际车队规模、出勤天数与单车补电量假设。",
  },
  {
    key: "bessDischargeKwh",
    label: "储能放电量",
    actualField: "bessDischargeKwh",
    annualField: "bessDischargeKwh",
    unit: "kWh",
    basis: "bess-ac-discharge",
    paramKey: "bess.roundTripEfficiencyPct / bess.strategy",
    paramLabel: "储能往返效率 / 调度策略",
    suggestionHint: "建议复核储能往返效率与调度策略假设。",
  },
  {
    key: "exportKwh",
    label: "上网电量",
    actualField: "exportKwh",
    annualField: "exportKwh",
    unit: "kWh",
    basis: "grid-export",
    paramKey: "grid.exportAllowed / grid.exportLimitKw",
    paramLabel: "上网允许与上限",
    suggestionHint: "建议复核余电上网策略与实际上网量。",
  },
  {
    key: "gridCostYuan",
    label: "购电成本",
    actualField: "gridCostYuan",
    annualField: "gridCostYuan",
    unit: "元",
    basis: "grid-side-total-cost",
    paramKey: "grid.flatPriceYuanPerKwh / grid.touWindows / grid.demandChargePerKwMonth",
    paramLabel: "电价与分时/需量条款",
    suggestionHint: "建议复核电价基准、分时时段与需量/免需量条款。",
  },
  {
    key: "revenueYuan",
    label: "充电/服务费收入",
    actualField: "revenueYuan",
    annualField: "serviceRevenueYuan",
    unit: "元",
    basis: "service-fee-revenue",
    paramKey: "economics.chargingServiceFeeYuanPerKwh",
    paramLabel: "充电服务费单价",
    suggestionHint: "建议复核服务费实际达成单价与结算口径（市场调节价）。",
  },
  {
    key: "opexYuan",
    label: "运维支出",
    actualField: "opexYuan",
    annualField: "opexYuan",
    unit: "元",
    basis: "gross-opex",
    paramKey: "economics.pvOpexYuanPerKwpYear / bessOpexYuanPerKwhYear / chargerOpexYuanPerKwYear",
    paramLabel: "各部件单位运维成本",
    suggestionHint: "建议复核运维成本假设（含口径：预测为宽口径含土地与保险）。",
  },
];

/** 实测行的最小结构（服务层把 Prisma Decimal 映射成 number|null 后传入，避免本层耦合 ORM）。 */
export interface ActualLike {
  periodYear: number;
  periodMonth: number; // 0 = 年度汇总；1..12 = 自然月
  gridImportKwh: number | null;
  pvGenerationKwh: number | null;
  bessDischargeKwh: number | null;
  deliveredKwh: number | null;
  exportKwh: number | null;
  gridCostYuan: number | null;
  revenueYuan: number | null;
  opexYuan: number | null;
  availabilityPct: number | null;
}

/** 已知实测列但没有预测侧可比的（诚实标注，不静默丢弃；供 UI/测试引用为何某列不进对照）。 */
export const METRICLESS_ACTUAL_FIELDS: Record<string, string> = {
  availabilityPct: "预测侧无对应「设施可用率」口径，暂不可比",
};

/* ═══════════════════════════ 3. 单点偏差计算（§8 公式统一 + §10 完整度闸门） ═══════════════════════════ */

export type DeviationStatus =
  | "COMPARABLE" // 两边都有同口径可比值，正常算出偏差
  | "MATCH" // 偏差恰为 0（两边相等）
  | "ZERO_FORECAST" // 预测为 0：绝对偏差可报，百分比不可（防除零）
  | "MISSING_FORECAST" // 预测侧没有这个量（含无同口径预测，如逐月非光伏）
  | "MISSING_ACTUAL" // 实测没测（null）——绝不当成 0
  | "NOT_COMPARABLE"; // 单位/口径不一致，或数据不足以构成一次比较

export interface DeviationPoint {
  metricKey: string;
  label: string;
  periodYear: number;
  periodMonth: number; // 0 = 年度
  unit: string;
  basis: string;
  status: DeviationStatus;
  forecast: number | null;
  actual: number | null;
  /** actual − forecast（同量纲）；MISSING_* / NOT_COMPARABLE 时为 null。 */
  absoluteDeviation: number | null;
  /** (actual − forecast)/forecast ×100（%）；预测为 0 或缺失时为 null（绝不除零、绝不臆造）。 */
  percentageDeviation: number | null;
  /** 方向：实测高于预测 / 低于预测 / 相等 / 无法判定。 */
  direction: "actual_above" | "actual_below" | "match" | "unknown";
  /** 诊断/原因说明（面向用户，且机读 reason 供测试钉桩）。 */
  reason?: string;
}

/**
 * 单点偏差计算的**唯一公式源**（§8）。所有上层聚合都复用它，杜绝两处各写一遍偏差公式而漂移。
 *
 * 顺序即纪律：先判「能不能比」（口径一致 → 两边有没有值），再算。任何一边缺、或单位/口径对不上，
 * 一律不产出数字，只产出状态与原因——「宁可说不能比，不可假装有偏差」。
 */
export function computeDeviation(args: {
  metricKey: string;
  label: string;
  periodYear: number;
  periodMonth: number;
  unit: string;
  basis: string;
  actualBasis?: string;
  actualUnit?: string;
  forecast: number | null;
  actual: number | null;
}): DeviationPoint {
  const base: DeviationPoint = {
    metricKey: args.metricKey,
    label: args.label,
    periodYear: args.periodYear,
    periodMonth: args.periodMonth,
    unit: args.unit,
    basis: args.basis,
    status: "COMPARABLE",
    forecast: null,
    actual: null,
    absoluteDeviation: null,
    percentageDeviation: null,
    direction: "unknown",
  };

  // 口径/单位一致性优先（§11）：两边都显式声明才判，缺省视为同口径（本目录同列默认同口径）。
  if (args.actualBasis && args.actualBasis !== args.basis) {
    return { ...base, status: "NOT_COMPARABLE", reason: "basis_mismatch" };
  }
  if (args.actualUnit && args.actualUnit !== args.unit) {
    return { ...base, status: "NOT_COMPARABLE", reason: "unit_mismatch" };
  }
  // 缺预测（§10）：没有同口径预测值可对齐。
  if (args.forecast == null || !Number.isFinite(args.forecast)) {
    return { ...base, status: "MISSING_FORECAST", actual: fin(args.actual), reason: "no_forecast_same_basis" };
  }
  // 缺实测 ≠ 0（§9）：没测就是没测，绝不落到 -100%。
  if (args.actual == null || !Number.isFinite(args.actual)) {
    return { ...base, forecast: args.forecast, status: "MISSING_ACTUAL", reason: "not_reported" };
  }

  const absolute = args.actual - args.forecast;
  const direction: DeviationPoint["direction"] =
    absolute === 0 ? "match" : absolute > 0 ? "actual_above" : "actual_below";

  // 预测为 0：绝对偏差仍有意义，但百分比会除零 → 如实置 null 并登记（§8）。
  if (args.forecast === 0) {
    return {
      ...base,
      status: "ZERO_FORECAST",
      forecast: args.forecast,
      actual: args.actual,
      absoluteDeviation: absolute,
      percentageDeviation: null,
      direction,
      reason: "zero_forecast_pct_undefined",
    };
  }

  if (absolute === 0) {
    return { ...base, status: "MATCH", forecast: args.forecast, actual: args.actual, absoluteDeviation: 0, percentageDeviation: 0, direction: "match" };
  }

  return {
    ...base,
    status: "COMPARABLE",
    forecast: args.forecast,
    actual: args.actual,
    absoluteDeviation: absolute,
    percentageDeviation: (absolute / args.forecast) * 100,
    direction,
  };
}

/* ═══════════════════════════ 4. 指标级聚合（§12 简单统计 + §20 禁止「抵消即无偏」） ═══════════════════════════ */

export interface MetricAnalysis {
  metricKey: string;
  label: string;
  unit: string;
  basis: string;
  paramKey?: string;
  paramLabel?: string;
  suggestionHint?: string;

  /** 年度单点（periodMonth=0 的实测 vs 年度预测）。 */
  annual: DeviationPoint | null;
  /** 逐月单点（1..12，仅对有同口径逐月预测的指标非空；其余为 MISSING_FORECAST）。 */
  monthly: DeviationPoint[];

  /** 参与统计的「可比且两边齐」样本数（含 MATCH）。 */
  comparableCount: number;
  /** 方向一致的符号偏差均值（%）；无有效百分比样本 → null。 */
  signedMeanPct: number | null;
  /** 平均绝对百分比偏差（%）——专门用来防止「+20% 与 -20% 平均成 0% 假装无偏」（§20）。 */
  meanAbsPct: number | null;
  /** 平均绝对偏差（同量纲，|actual−forecast| 的均值）。 */
  meanAbsoluteDeviation: number | null;
  /** 全期绝对偏差之和（同量纲；对电量=净缺口方向不明，故同时给 below/above 计数）。 */
  sumAbsoluteDeviation: number | null;
  /** 符号绝对偏差之和（Σ(actual−forecast)，同量纲）。 */
  netSumDeviation: number | null;
  positiveCount: number; // 实测高于预测（预测低估）
  negativeCount: number; // 实测低于预测（预测高估）
  zeroForecastCount: number;
  missingActualCount: number;
  missingForecastCount: number;
  notComparableCount: number;
  /** 主方向：consistent_above / consistent_below / mixed / none。 */
  direction: "consistent_above" | "consistent_below" | "mixed" | "none";
  /** 偏差百分比区间（min/max），暴露离散度而非只报均值。 */
  rangePct: { min: number; max: number } | null;
  /** 「抵消预警」：符号均值很小但平均绝对偏差很大 → 掩盖了真实误差，不可下「模型没问题」结论（§20）。 */
  cancelsOut: boolean;
  /** 是否「数据不足，无法判断」（§12）。 */
  insufficientData: boolean;
}

const MATCH_EPS_PCT = 0.5; // |signedMeanPct| 小于此、而 meanAbsPct 明显更大 → 判为相互抵消

/** 收集一个指标的所有单点（年度 + 逐月）里「两边齐」的百分比与绝对偏差。 */
function pointsForStats(ma: { annual: DeviationPoint | null; monthly: DeviationPoint[] }): DeviationPoint[] {
  const all: DeviationPoint[] = [];
  if (ma.annual) all.push(ma.annual);
  all.push(...ma.monthly);
  return all;
}

/** 对一组单点做统计（§12 保持简单：均值/绝对均值/方向/区间/计数，无花哨模型）。 */
function buildMetricAnalysis(def: MetricDef, annual: DeviationPoint | null, monthly: DeviationPoint[]): MetricAnalysis {
  const pts = pointsForStats({ annual, monthly });
  let positiveCount = 0;
  let negativeCount = 0;
  let zeroForecastCount = 0;
  let missingActualCount = 0;
  let missingForecastCount = 0;
  let notComparableCount = 0;
  const pctSamples: number[] = [];
  const absSamples: number[] = [];
  let netSum = 0;
  let sumAbs = 0;
  let netSumSeen = false;

  for (const p of pts) {
    switch (p.status) {
      case "MISSING_FORECAST":
        missingForecastCount++;
        break;
      case "MISSING_ACTUAL":
        missingActualCount++;
        break;
      case "NOT_COMPARABLE":
        notComparableCount++;
        break;
      case "ZERO_FORECAST":
        zeroForecastCount++;
        if (p.absoluteDeviation != null) {
          netSum += p.absoluteDeviation;
          sumAbs += Math.abs(p.absoluteDeviation);
          netSumSeen = true;
          if (p.absoluteDeviation > 0) positiveCount++;
          else if (p.absoluteDeviation < 0) negativeCount++;
        }
        break;
      case "MATCH":
        // 两边相等：计入「可比且为 0」，但方向中性，不计正负。
        absSamples.push(0);
        pctSamples.push(0);
        netSum += 0;
        netSumSeen = true;
        break;
      case "COMPARABLE":
        if (p.percentageDeviation != null) pctSamples.push(p.percentageDeviation);
        if (p.absoluteDeviation != null) {
          absSamples.push(Math.abs(p.absoluteDeviation));
          netSum += p.absoluteDeviation;
          sumAbs += Math.abs(p.absoluteDeviation);
          netSumSeen = true;
          if (p.direction === "actual_above") positiveCount++;
          else if (p.direction === "actual_below") negativeCount++;
        }
        break;
    }
  }

  const comparableCount = pctSamples.length;
  const signedMeanPct = comparableCount > 0 ? pctSamples.reduce((a, b) => a + b, 0) / comparableCount : null;
  const meanAbsPct = comparableCount > 0 ? pctSamples.reduce((a, b) => a + Math.abs(b), 0) / comparableCount : null;
  const meanAbsoluteDeviation = absSamples.length > 0 ? absSamples.reduce((a, b) => a + b, 0) / absSamples.length : null;
  const rangePct =
    comparableCount > 0
      ? { min: Math.min(...pctSamples), max: Math.max(...pctSamples) }
      : null;

  let direction: MetricAnalysis["direction"] = "none";
  if (positiveCount > 0 && negativeCount === 0) direction = "consistent_above";
  else if (negativeCount > 0 && positiveCount === 0) direction = "consistent_below";
  else if (positiveCount > 0 && negativeCount > 0) direction = "mixed";

  const minSamples = 2;
  const insufficientData = comparableCount < minSamples;
  const cancelsOut =
    signedMeanPct != null &&
    meanAbsPct != null &&
    Math.abs(signedMeanPct) < MATCH_EPS_PCT &&
    meanAbsPct >= MATCH_EPS_PCT * 4;

  return {
    metricKey: def.key,
    label: def.label,
    unit: def.unit,
    basis: def.basis,
    paramKey: def.paramKey,
    paramLabel: def.paramLabel,
    suggestionHint: def.suggestionHint,
    annual,
    monthly,
    comparableCount,
    signedMeanPct,
    meanAbsPct,
    meanAbsoluteDeviation,
    sumAbsoluteDeviation: netSumSeen ? sumAbs : null,
    netSumDeviation: netSumSeen ? netSum : null,
    positiveCount,
    negativeCount,
    zeroForecastCount,
    missingActualCount,
    missingForecastCount,
    notComparableCount,
    direction,
    rangePct,
    cancelsOut,
    insufficientData,
  };
}

/* ═══════════════════════════ 5. 主分析入口：ForecastSnapshot × Actual[] → 逐指标偏差 ═══════════════════════════ */

export interface DeviationAnalysis {
  /** 被对照的预测身份（回显，供 UI 说明「在对哪一次预测」）。 */
  identity: ForecastIdentity | null;
  /** 有实测但无预测快照 → 一切不可比，给出诚实总说明。 */
  forecastAvailable: boolean;
  /** 是否有任何一条可对比的单点。 */
  anyComparable: boolean;
  metrics: MetricAnalysis[];
  /** 数据完整度概览（§10）。 */
  completeness: {
    actualRowCount: number;
    annualActualCount: number;
    monthlyActualCount: number;
    comparablePoints: number;
    missingActualPoints: number;
    missingForecastPoints: number;
    notComparablePoints: number;
    zeroForecastPoints: number;
  };
  /** 「尚无可比较实测数据」类总结（供报告/界面直接引用，§26）。 */
  headline: string;
}

const MIN_EMPTY = "尚无与预测口径一致的可比较实测数据。";

/**
 * 把「一次存档预测」与「一批实测行」对齐成逐指标偏差。
 *
 * 年度：取 periodMonth=0 的实测行 vs `forecast.annual`。
 * 逐月：取 periodMonth 1..12 的实测行 vs 同月预测——**仅对提供 monthlyField 的指标有预测**，
 *       其余月份如实标 `MISSING_FORECAST`（引擎只给了光伏的逐月预测，我们不为凑数去重算/瞎补）。
 */
export function analyzeForecastVsActual(forecast: ForecastSnapshot | null, actuals: readonly ActualLike[]): DeviationAnalysis {
  const annualActual = actuals.find((a) => a.periodMonth === 0) ?? null;
  const monthlyActuals = actuals.filter((a) => a.periodMonth >= 1 && a.periodMonth <= 12);

  const metrics: MetricAnalysis[] = DEVIATION_METRICS.map((def) => {
    // 年度点
    let annual: DeviationPoint | null = null;
    if (def.annualField) {
      const fv = forecast ? forecast.annual[def.annualField] : null;
      const av = annualActual ? (annualActual[def.actualField] as number | null) : null;
      annual = computeDeviation({
        metricKey: def.key,
        label: def.label,
        periodYear: annualActual?.periodYear ?? 0,
        periodMonth: 0,
        unit: def.unit,
        basis: def.basis,
        forecast: forecast ? fv : null,
        actual: av,
      });
    }

    // 逐月点（1..12）
    const monthly: DeviationPoint[] = [];
    if (def.monthlyField && forecast) {
      const arr = forecast.monthly[def.monthlyField] as number[];
      for (let m = 1; m <= 12; m++) {
        const row = monthlyActuals.find((a) => a.periodMonth === m) ?? null;
        const fv = Array.isArray(arr) ? fin(arr[m - 1]) : null;
        const av = row ? (row[def.actualField] as number | null) : null;
        monthly.push(
          computeDeviation({
            metricKey: def.key,
            label: def.label,
            periodYear: row?.periodYear ?? 0,
            periodMonth: m,
            unit: def.unit,
            basis: def.basis,
            forecast: fv,
            actual: av,
          }),
        );
      }
    }

    return buildMetricAnalysis(def, annual, monthly);
  });

  // 完整度汇总
  const completeness = { actualRowCount: actuals.length, annualActualCount: annualActual ? 1 : 0, monthlyActualCount: monthlyActuals.length, comparablePoints: 0, missingActualPoints: 0, missingForecastPoints: 0, notComparablePoints: 0, zeroForecastPoints: 0 };
  for (const ma of metrics) {
    const pts = pointsForStats(ma);
    for (const p of pts) {
      if (p.status === "COMPARABLE" || p.status === "MATCH") completeness.comparablePoints++;
      else if (p.status === "MISSING_ACTUAL") completeness.missingActualPoints++;
      else if (p.status === "MISSING_FORECAST") completeness.missingForecastPoints++;
      else if (p.status === "NOT_COMPARABLE") completeness.notComparablePoints++;
      else if (p.status === "ZERO_FORECAST") completeness.zeroForecastPoints++;
    }
  }
  const anyComparable = completeness.comparablePoints > 0;

  let headline: string;
  if (!forecast) headline = "该项目还没有可对照的预测快照（可能情景尚未成功计算或未留档）。";
  else if (actuals.length === 0) headline = MIN_EMPTY;
  else if (!anyComparable) headline = actuals.length > 0 ? "已录入实测，但缺少与预测同口径的可比较数据（多为逐月预测不可得或字段未测）。" : MIN_EMPTY;
  else headline = `已对照预测，得到 ${completeness.comparablePoints} 个可比较偏差点。`;

  return {
    identity: forecast ? forecast.identity : null,
    forecastAvailable: Boolean(forecast),
    anyComparable,
    metrics,
    completeness,
    headline,
  };
}

/* ═══════════════════════════ 6. 影响分析（§14：同量纲换算，绝不复制 NPV/折现） ═══════════════════════════ */

/**
 * 一次影响估算。
 * - 钱（元）：actual−forecast 本身就是金额影响，精确。
 * - 电（kWh）：折成钱用**预测自身隐含单价**（存档里的比值），故标 `ASSUMPTION`、注明口径，
 *   且明确「这只是量级参考，不是重新算的 NPV/现金流」。
 */
export interface ImpactEstimate {
  metricKey: string;
  label: string;
  unit: string;
  /** 金额量级影响（元）。对电能量指标 = 净偏差电量 × 预测隐含单价（ASSUMPTION）。 */
  amountYuan: number | null;
  /** 该影响的确信度：money 直接可比=FACT；energy×implied=ASSUMPTION。 */
  evidenceKind: "FACT" | "ASSUMPTION";
  /** 口径/换算说明（面向用户，写清「怎么来的、别当成 NPV」）。 */
  note: string;
}

/** 从指标分析 + 预测快照推导金额影响（只读快照里已有的比值，不新增公式）。 */
export function deriveImpacts(forecast: ForecastSnapshot | null, analysis: DeviationAnalysis): ImpactEstimate[] {
  if (!forecast) return [];
  const out: ImpactEstimate[] = [];
  for (const ma of analysis.metrics) {
    if (ma.netSumDeviation == null) continue;
    if (ma.unit === "元") {
      out.push({
        metricKey: ma.metricKey,
        label: ma.label,
        unit: "元",
        amountYuan: ma.netSumDeviation,
        evidenceKind: "FACT",
        note: "实测与预测同为金额，差额即影响（未做跨期折现）。",
      });
    } else if (ma.unit === "kWh") {
      const rate =
        ma.metricKey === "gridImportKwh" || ma.metricKey === "exportKwh"
          ? forecast.implied.costPerImportKwhYuan
          : forecast.implied.serviceFeePerDeliveredKwhYuan;
      if (rate == null) {
        out.push({
          metricKey: ma.metricKey,
          label: ma.label,
          unit: "kWh",
          amountYuan: null,
          evidenceKind: "ASSUMPTION",
          note: "预测未提供可用的隐含单价（购电量或交付量为 0），不臆算金额影响。",
        });
      } else {
        out.push({
          metricKey: ma.metricKey,
          label: ma.label,
          unit: "kWh",
          amountYuan: ma.netSumDeviation * rate,
          evidenceKind: "ASSUMPTION",
          note: `按预测隐含单价 ${rate.toFixed(4)} 元/kWh 折算的量级参考，非重算 NPV/现金流。`,
        });
      }
    }
  }
  return out;
}

/* ═══════════════════════════ 7. 校准候选检测（§16–§18：只产出建议，人工审核门之后才可能改） ═══════════════════════════ */

export const CALIBRATION_STATUSES = ["CANDIDATE", "UNDER_REVIEW", "ACCEPTED", "REJECTED"] as const;
export type CalibrationStatus = (typeof CALIBRATION_STATUSES)[number];

export interface CandidateSeed {
  /** 稳定幂等键：同指标+同地区+同口径+同周期类型 只应存一条 CANDIDATE（避免每次分析堆重复）。 */
  dedupeKey: string;
  metric: string;
  metricLabel: string;
  parameter: string | null;
  parameterLabel: string | null;
  measurementBasis: string;
  unit: string;
  periodKind: "annual" | "monthly" | "aggregate";
  regionId: string | null;
  projectId: string | null;
  /** over_forecast=预测持续偏高（实测低于预测）；under_forecast=预测持续偏低。 */
  direction: "over_forecast" | "under_forecast";
  forecastValue: number | null;
  actualValue: number | null;
  biasPct: number | null;
  meanAbsPct: number | null;
  sampleCount: number;
  impactYuan: number | null;
  impactEvidenceKind: "FACT" | "ASSUMPTION";
  evidence: {
    comparableCount: number;
    positiveCount: number;
    negativeCount: number;
    rangePct: { min: number; max: number } | null;
    note: string;
  };
  suggestion: string;
}

export interface DetectConfig {
  /** 触发一条候选所需的最少可比较本数（默认 2）。 */
  minSamples: number;
  /** 系统性偏差阈值（|signedMeanPct| 超过它，默认 5%）。 */
  biasThresholdPct: number;
  nowIso?: string; // 由调用方注入，纯函数不读时钟
}

export const DEFAULT_DETECT_CONFIG: DetectConfig = { minSamples: 2, biasThresholdPct: 5 };

/**
 * 从一次项目的偏差分析里，挑出「方向一致 + 达到阈值 + 样本够」的系统性偏差 → 候选种子。
 *
 * 刻意只认**方向一致**（consistent_above/below）：这正对应 §17「连续多个都偏高/都偏低」。
 * `mixed` 或 `cancelsOut` 的信号**不生成自动改参建议**（那需要人看分布，不能机器拍）。
 * 本函数只产出 `CandidateSeed`（建议），**不改任何基准/引擎/情景**——那是人工审核后的事（§18/§34）。
 */
export function detectCalibrationCandidates(
  args: {
    projectId: string;
    analysis: DeviationAnalysis;
    impacts: ImpactEstimate[];
    config?: Partial<DetectConfig>;
  },
): CandidateSeed[] {
  const cfg: DetectConfig = { ...DEFAULT_DETECT_CONFIG, ...args.config };
  const regionId = args.analysis.identity?.regionId ?? null;
  const seeds: CandidateSeed[] = [];

  for (const ma of args.analysis.metrics) {
    if (ma.direction !== "consistent_above" && ma.direction !== "consistent_below") continue;
    if (ma.comparableCount < cfg.minSamples) continue;
    if (ma.signedMeanPct == null || Math.abs(ma.signedMeanPct) < cfg.biasThresholdPct) continue;

    const direction: CandidateSeed["direction"] =
      ma.direction === "consistent_below" ? "over_forecast" : "under_forecast";
    const impact = args.impacts.find((i) => i.metricKey === ma.metricKey) ?? null;
    const biasWord = direction === "over_forecast" ? "系统性偏高（高估）" : "系统性偏低（低估）";

    seeds.push({
      dedupeKey: `${ma.metricKey}|${regionId ?? "na"}|${ma.basis}|aggregate`,
      metric: ma.metricKey,
      metricLabel: ma.label,
      parameter: ma.paramKey ?? null,
      parameterLabel: ma.paramLabel ?? null,
      measurementBasis: ma.basis,
      unit: ma.unit,
      periodKind: "aggregate",
      regionId,
      projectId: args.projectId,
      direction,
      forecastValue: ma.annual?.forecast ?? null,
      actualValue: ma.annual?.actual ?? null,
      biasPct: ma.signedMeanPct,
      meanAbsPct: ma.meanAbsPct,
      sampleCount: ma.comparableCount,
      impactYuan: impact ? impact.amountYuan : null,
      impactEvidenceKind: impact ? impact.evidenceKind : "ASSUMPTION",
      evidence: {
        comparableCount: ma.comparableCount,
        positiveCount: ma.positiveCount,
        negativeCount: ma.negativeCount,
        rangePct: ma.rangePct,
        note: `${ma.label} 预测${biasWord}，样本 ${ma.comparableCount} 个${ma.rangePct ? `，偏差区间 ${ma.rangePct.min.toFixed(1)}%~${ma.rangePct.max.toFixed(1)}%` : ""}。`,
      },
      suggestion: ma.suggestionHint ?? `建议复核「${ma.label}」相关假设。`,
    });
  }

  return seeds;
}

/**
 * 跨项目方向性判定（§19）：回答「这是单项目偶然，还是多项目反复出现的方向性偏差？」
 *
 * 只做**最小聚合**：把同一 `metric + basis + region` 的各项目符号偏差放一起，
 * 给加权（按样本数）与不加权两套均值、方向、以及「抵消预警」——绝不简单平均到 0 就当没事（§20）。
 * 输入由 service 层从**当前用户可访问**的项目里聚合（越权在 service 层挡），本函数纯算。
 */
export interface ProjectBiasInput {
  projectId: string;
  regionId: string | null;
  signedMeanPct: number;
  sampleCount: number;
}

export interface CrossProjectBias {
  metric: string;
  basis: string;
  regionId: string | null;
  projectCount: number;
  totalSamples: number;
  unweightedMeanPct: number;
  weightedMeanPct: number | null;
  direction: "consistent_above" | "consistent_below" | "mixed" | "none";
  rangePct: { min: number; max: number };
  /** 项目层面是否也「方向一致且达阈值」——够格作为区域性复核信号。 */
  systemic: boolean;
  note: string;
}

export function aggregateCrossProjectBias(
  args: { metric: string; basis: string; regionId: string | null; biases: ProjectBiasInput[]; biasThresholdPct?: number },
): CrossProjectBias {
  const threshold = args.biasThresholdPct ?? DEFAULT_DETECT_CONFIG.biasThresholdPct;
  const b = args.biases;
  const projectCount = b.length;
  const totalSamples = b.reduce((s, x) => s + x.sampleCount, 0);
  const unweightedMeanPct = projectCount > 0 ? b.reduce((s, x) => s + x.signedMeanPct, 0) / projectCount : 0;
  const weightedMeanPct =
    totalSamples > 0 ? b.reduce((s, x) => s + x.signedMeanPct * x.sampleCount, 0) / totalSamples : null;
  const anyAbove = b.some((x) => x.signedMeanPct > 0);
  const anyBelow = b.some((x) => x.signedMeanPct < 0);
  const direction: CrossProjectBias["direction"] =
    anyAbove && anyBelow ? "mixed" : anyAbove ? "consistent_above" : anyBelow ? "consistent_below" : "none";
  const rangePct =
    projectCount > 0
      ? { min: Math.min(...b.map((x) => x.signedMeanPct)), max: Math.max(...b.map((x) => x.signedMeanPct)) }
      : { min: 0, max: 0 };
  const systemic = direction !== "mixed" && Math.abs(unweightedMeanPct) >= threshold && projectCount >= 2;
  return {
    metric: args.metric,
    basis: args.basis,
    regionId: args.regionId,
    projectCount,
    totalSamples,
    unweightedMeanPct,
    weightedMeanPct,
    direction,
    rangePct,
    systemic,
    note: systemic
      ? `跨 ${projectCount} 个项目、${totalSamples} 个样本，方向一致（${direction === "consistent_below" ? "普遍高估" : "普遍低估"}），提示为区域性/参数性问题而非个案。`
      : direction === "mixed"
        ? "项目间方向不一致，可能是个案或口径差异，不宜下系统性结论。"
        : "样本或方向不足以判定为系统性偏差。",
  };
}
