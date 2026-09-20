/**
 * 能量平衡与不变量（EnergyBalance / EnergyBalanceInvariant）。
 *
 * ## 守恒式（每个 15 分钟都必须成立，一个字都不许含糊）
 *
 * ```
 * 光伏发电 + 储能放电 + 电网下网
 *   = (站点负荷 + 储能充电 − 未满足负荷) + 余电上网 + 弃光
 * ```
 *
 * 四项在左（供给）、四项在右（去向）。**"未满足负荷"必须显式出现在右边**——这是整个模块
 * 最容易被写错的地方：如果把没供上的电直接当成"负荷小一点"，等式照样成立，但"装不下"
 * 这个事实就被抹掉了，而它恰恰是决策里最重要的一条信息（该加桩、该增容）。
 *
 * ## 为什么单独成模块
 *
 * V1 的能量平衡是"年度总量"级别的（富余与下网被当作互斥），所以**消纳价值恒为 0**。
 * V2 把它变成逐时段问题后，任何一处模块的时间轴/口径不一致都会立刻表现为"能量凭空产生或消失"。
 * 把这个校验独立出来、作为每次计算的**强制产物**（而不是调试手段），是为了让这类错误
 * **不可能静默通过**——它是模型以后被改坏时唯一会立刻报警的东西。
 *
 * ## 分配顺序（决定了"光伏到底用在哪"）
 *
 * 1. 光伏先供站点（负荷 + 储能充电）；
 * 2. 不够的部分由储能放电补，再不够由电网下网补（受并网容量限制）；
 * 3. 光伏有富余时：能上网则上网（受上网容量限制），不能上的部分 = 弃光。
 */

import {
  STEPS_PER_YEAR,
  STEPS_PER_HOUR,
  TIME_STEP_MINUTES,
  zeros,
  sumAll,
  peakOf,
  monthStepRange,
} from "@app/kernel/engine/time";
import type { Diagnostic, EnergyBalanceInvariant, TimeSeries } from "@app/kernel/engine/types";

/** 能量平衡模型版本。 */
export const BALANCE_MODEL_VERSION = "1.0.0";
export function balanceModelCalcRef(): string {
  return `balance@${BALANCE_MODEL_VERSION}`;
}

const DT_HOURS = TIME_STEP_MINUTES / 60;

/** 守恒判定的相对容差（相对当期能量规模）与绝对下限。 */
const REL_TOLERANCE = 1e-9;
const ABS_TOLERANCE_KWH = 1e-9;

export interface BalanceInput {
  /** 站点负荷（kW，含充电与换电）。 */
  loadProfileKw: TimeSeries;
  /** 储能充电功率（kW，正 = 从母线取电）。 */
  bessChargeKw: TimeSeries;
  /** 储能放电功率（kW，正 = 向母线送电）。 */
  bessDischargeKw: TimeSeries;
  /** 光伏出力（kW）。 */
  pvOutputKw: TimeSeries;
  /** 并网容量 / 最大受电功率（kW）。 */
  importLimitKw: number;
  /** 是否允许余电上网。 */
  exportAllowed: boolean;
  /** 上网功率上限（kW）。 */
  exportLimitKw: number;
}

export interface BalanceResult {
  /** 下网功率（kW）。 */
  importProfileKw: number[];
  /** 上网功率（kW）。 */
  exportProfileKw: number[];
  /** 弃光功率（kW）。 */
  curtailmentProfileKw: number[];
  /** 未满足负荷（kW，> 0 表示电网容量不足）。 */
  unservedProfileKw: number[];
  /** 光伏直供站点的电量（kWh/年）。 */
  selfConsumedPvKwh: number;
  /** 守恒校验结果。 */
  invariant: EnergyBalanceInvariant;
  /** 逐月最大下网需量（kW，长度 12）。 */
  monthlyPeakImportKw: number[];
  /** 是否存在因并网容量不足而未满足的负荷。 */
  capacityConstrained: boolean;
  diagnostics: Diagnostic[];
}

/**
 * 主计算：逐 15 分钟能量分配 + 守恒校验。
 */
export function computeEnergyBalance(input: BalanceInput): BalanceResult {
  const diagnostics: Diagnostic[] = [];
  const n = STEPS_PER_YEAR;

  const importProfile = zeros();
  const exportProfile = zeros();
  const curtailmentProfile = zeros();
  const unservedProfile = zeros();

  const importLimit = Math.max(0, input.importLimitKw);
  const exportLimit = Math.max(0, input.exportLimitKw);
  let selfConsumedPvKwh = 0;
  let capacityConstrained = false;

  for (let t = 0; t < n; t++) {
    const load = input.loadProfileKw[t] ?? 0;
    const charge = input.bessChargeKw[t] ?? 0;
    const discharge = input.bessDischargeKw[t] ?? 0;
    const pv = input.pvOutputKw[t] ?? 0;

    const need = load + charge; // 站点侧需求
    const supplyNoGrid = pv + discharge;
    const deficit = need - supplyNoGrid;

    if (deficit <= 0) {
      // 光伏（+放电）足够：余量上网或弃光
      const surplus = -deficit;
      const exp = input.exportAllowed ? Math.min(surplus, exportLimit) : 0;
      exportProfile[t] = exp;
      curtailmentProfile[t] = surplus - exp;
      importProfile[t] = 0;
      // 约定：光伏优先供站点，其次由储能放电补足（因此站点消纳的光伏 = min(光伏, 站点需求)）
      selfConsumedPvKwh += Math.min(pv, need) * DT_HOURS;
    } else {
      // 不足：储能已放尽 → 电网补，受并网容量约束
      const imp = Math.min(deficit, importLimit);
      importProfile[t] = imp;
      const unserved = deficit - imp;
      unservedProfile[t] = unserved;
      if (unserved > 1e-9) capacityConstrained = true;
      // 光伏全部被站点用掉
      selfConsumedPvKwh += pv * DT_HOURS;
    }
  }

  /* ── 守恒校验（逐时段） ── */
  const invariant = checkEnergyBalanceInvariant({
    pvOutputKw: input.pvOutputKw,
    bessChargeKw: input.bessChargeKw,
    bessDischargeKw: input.bessDischargeKw,
    loadProfileKw: input.loadProfileKw,
    importProfileKw: importProfile,
    exportProfileKw: exportProfile,
    curtailmentProfileKw: curtailmentProfile,
    unservedProfileKw: unservedProfile,
  });

  if (!invariant.ok) {
    diagnostics.push({
      kind: "CALCULATION_ERROR",
      code: "energy_balance_violation",
      message: `能量平衡不守恒：${invariant.violationCount} 个时段出现能量凭空产生或消失（最大偏差 ${invariant.maxAbsDeviationKwh.toExponential(2)} kWh）。`,
      impact: "技术结果与经济结论均不可信，必须修复后才能使用。",
      suggestion: "这是计算引擎缺陷，请联系维护者；不要据此做投资判断。",
      value: invariant.violationCount,
      unit: "步",
    });
  }

  if (capacityConstrained) {
    const totalUnserved = sumAll(unservedProfile) * DT_HOURS;
    const peakUnservedKw = peakOf(unservedProfile);
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "grid_capacity_insufficient",
      message: `并网容量不足：全年约 ${Math.round(totalUnserved).toLocaleString("zh-CN")} kWh 负荷无法由电网供给（缺口峰值约 ${Math.round(peakUnservedKw)} kW）。`,
      impact: "这些负荷在模型里被记为未满足，实际会表现为车辆排长队或无法出车；项目不满足交付条件。",
      suggestion: `按当前负荷曲线，并网容量至少需要 ${Math.ceil(peakOf(importProfile) + peakUnservedKw)} kW（现为 ${Math.round(importLimit)} kW）；或通过储能削峰、延长充电窗口来降低峰值。`,
      value: Math.round(totalUnserved),
      unit: "kWh",
    });
  }

  const monthlyPeakImportKw: number[] = [];
  for (let m = 0; m < 12; m++) {
    const { start, end } = monthStepRange(m);
    let p = 0;
    for (let t = start; t < end; t++) if (importProfile[t] > p) p = importProfile[t];
    monthlyPeakImportKw.push(round2(p));
  }

  return {
    importProfileKw: importProfile,
    exportProfileKw: exportProfile,
    curtailmentProfileKw: curtailmentProfile,
    unservedProfileKw: unservedProfile,
    selfConsumedPvKwh: round2(selfConsumedPvKwh),
    invariant,
    monthlyPeakImportKw,
    capacityConstrained,
    diagnostics,
  };
}

/**
 * 守恒校验的**公开契约**（测试直接调它，而不是只看总结果）。
 *
 * 判定式（逐步、单位 kWh）：
 *   `pv + discharge + import  ==  (load + charge − unserved) + export + curtailment`
 *
 * 容差按当期能量规模取相对值（避免大电量工况下浮点误差被误判为违规），
 * 但绝对下限保证零能量时段也严格判定。
 */
export function checkEnergyBalanceInvariant(series: {
  pvOutputKw: TimeSeries;
  bessChargeKw: TimeSeries;
  bessDischargeKw: TimeSeries;
  loadProfileKw: TimeSeries;
  importProfileKw: TimeSeries;
  exportProfileKw: TimeSeries;
  curtailmentProfileKw: TimeSeries;
  unservedProfileKw: TimeSeries;
}): EnergyBalanceInvariant {
  const samples: EnergyBalanceInvariant["samples"] = [];
  let violationCount = 0;
  let maxAbs = 0;
  let annualDeviation = 0;
  let worstTolerance = ABS_TOLERANCE_KWH;

  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const pv = (series.pvOutputKw[t] ?? 0) * DT_HOURS;
    const dis = (series.bessDischargeKw[t] ?? 0) * DT_HOURS;
    const imp = (series.importProfileKw[t] ?? 0) * DT_HOURS;
    const load = (series.loadProfileKw[t] ?? 0) * DT_HOURS;
    const chg = (series.bessChargeKw[t] ?? 0) * DT_HOURS;
    const exp = (series.exportProfileKw[t] ?? 0) * DT_HOURS;
    const cur = (series.curtailmentProfileKw[t] ?? 0) * DT_HOURS;
    const uns = (series.unservedProfileKw[t] ?? 0) * DT_HOURS;

    const lhs = pv + dis + imp;
    const rhs = load + chg - uns + exp + cur;
    const dev = lhs - rhs;
    const scale = Math.max(lhs, rhs, 1);
    const tol = Math.max(ABS_TOLERANCE_KWH, scale * REL_TOLERANCE);
    worstTolerance = Math.max(worstTolerance, tol);
    annualDeviation += dev;

    const abs = Math.abs(dev);
    if (abs > maxAbs) maxAbs = abs;
    if (abs > tol) {
      violationCount++;
      if (samples.length < 3) {
        samples.push({ step: t, lhsKwh: lhs, rhsKwh: rhs, deviationKwh: dev });
      }
    }
  }

  return {
    ok: violationCount === 0,
    violationCount,
    maxAbsDeviationKwh: maxAbs,
    toleranceKwh: worstTolerance,
    samples,
    annualDeviationKwh: annualDeviation,
  };
}

/** 逐月下网电量（kWh），供报告。 */
export function monthlyImportKwh(importProfileKw: TimeSeries): number[] {
  const out = new Array(12).fill(0);
  for (let m = 0; m < 12; m++) {
    const { start, end } = monthStepRange(m);
    let s = 0;
    for (let t = start; t < end; t++) s += (importProfileKw[t] ?? 0) * DT_HOURS;
    out[m] = round2(s);
  }
  return out;
}

/** 曲线峰值（kW）。 */
export function peakKwOf(profileKw: TimeSeries): number {
  return round2(peakOf(profileKw));
}

/** 年电量（kWh）。 */
export function annualKwhOf(profileKw: TimeSeries): number {
  return round2(sumAll(profileKw) * DT_HOURS);
}

/** 步长小时数（导出给上层换算，避免各处重复写字面量）。 */
export const STEP_HOURS = DT_HOURS;
/** 每小时步数（导出）。 */
export const STEPS_EACH_HOUR = STEPS_PER_HOUR;

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
