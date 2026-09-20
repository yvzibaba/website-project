/**
 * 重卡能源需求模型（TruckDemand）—— 把车队运营条件换算成**逐 15 分钟的能量需求**。
 *
 * ## 为什么这一层必须独立
 *
 * 「这个项目要配多大」这个问题的第一个答案来自**车**，不来自设备。V1 直接拿一个年电量参数
 * 进经济模型，跳过了"车怎么跑、什么时候回来充"这一层，于是充电桩配置、峰值负荷、
 * 峰谷套利空间全部只能靠假设。V2 把它显式建出来：
 *
 *   车队规模 × 日里程 × 单位能耗 × 季节/线路修正   →   日能量需求
 *   日能量需求 ÷ 充电窗口（同时率、效率、策略）    →   15 分钟充电负荷曲线
 *
 * ## 三个刻意的建模决定（都为了让结论可审计）
 *
 * 1. **运营日精确等于用户输入的 `operatingDaysPerYear`**。做法是把 N 个运营日**均匀散布**到
 *    365 天里（`出现次数 = floor((d+1)·N/365) − floor(d·N/365)`，全年恰好 N 次）。
 *    比"每周固定休几天"更贴近真实的检修/排班分布，且年总量**精确可控**——这是可复算的前提。
 *
 * 2. **季节因子按年相位正弦施加**（峰值在 1 月中旬）。它乘在**单位能耗**上而不是里程上：
 *    冬季影响的是"同样的路更费电"（低温 + 滚阻 + 采暖），不是"跑得更少"。
 *
 * 3. **充电窗口允许跨越零点**（如 22:00–06:00 写作 `start=22, end=30`）。跨零的时段
 *    写入次日同一步；若越过**年末**（12/31 之后），该部分计入 `yearBoundarySpillKwh`
 *    并如实报告——绝不悄悄丢弃，也绝不回绕到年初造成重复计量。
 *
 * ## 诚实边界
 *
 * - 本层输出是**需求**，不含任何设备可用性约束（那是 `charging.ts` 的职责：装不下就报缺口）；
 * - 不做车辆调度优化（不排班、不排队、不给单车分配桩），当前服务于**投资决策**而非运营调度；
 * - 「电池侧 / 电网侧」两个口径在输出里分列，绝不分不清地混成一个数。
 */

import {
  STEPS_PER_YEAR,
  STEPS_PER_DAY,
  STEPS_PER_HOUR,
  DAYS_PER_YEAR,
  zeros,
  sumByMonth,
  monthStepRange,
  peakOf,
} from "@app/kernel/engine/time";
import type {
  ChargingMode,
  ChargerInput,
  Diagnostic,
  SwapInput,
  TimeSeries,
  TruckDemandResult,
  TruckFleetInput,
} from "@app/kernel/engine/types";

/** 重卡需求模型版本（改任一公式/口径须升版）。 */
export const TRUCK_MODEL_VERSION = "1.0.0";
export function truckModelCalcRef(): string {
  return `truck@${TRUCK_MODEL_VERSION}`;
}

/** 季节曲线的峰值所在日（1 月 15 日，0-based day 14）。 */
const SEASONAL_PEAK_DAY = 14;

export interface TruckDemandComputation {
  result: TruckDemandResult;
  diagnostics: Diagnostic[];
  /** 完成全部日需求所**需要**的站级电网侧功率（kW，30 分钟内可交付的口径）。 */
  requiredStationPowerKw: number;
}

/** 该日是否运营：全年恰好 `operatingDays` 次，均匀散布。 */
export function operatesOnDay(day: number, operatingDays: number): boolean {
  if (operatingDays <= 0) return false;
  if (operatingDays >= DAYS_PER_YEAR) return true;
  const before = Math.floor((day * operatingDays) / DAYS_PER_YEAR);
  const after = Math.floor(((day + 1) * operatingDays) / DAYS_PER_YEAR);
  return after > before;
}

/** 季节能耗倍率（1 = 标准工况；冬高夏低，全年均值≈1）。 */
export function seasonalMultiplier(day: number, seasonalFactorPct: number): number {
  const phase = (2 * Math.PI * (day - SEASONAL_PEAK_DAY)) / DAYS_PER_YEAR;
  return 1 + (seasonalFactorPct / 100) * Math.cos(phase);
}

/** 运营日的电网侧能量需求拆分（电池侧 + 电网侧两个口径）。 */
export interface DailyEnergy {
  /** 电池侧总需求（kWh/日）。 */
  atBatteryKwh: number;
  /** 电网侧需要提供的电量（kWh/日，充电链路效率 + 换电损耗之后）。 */
  atGridKwh: number;
  /** 其中由换电承担的部分（电池侧，kWh/日）。 */
  swapAtBatteryKwh: number;
}

/**
 * 单车队单日能量需求（纯函数，可单独测死）。
 * 单位：kWh。**不含**充电窗口可容纳性判断。
 */
export function dailyEnergyOf(
  fleet: TruckFleetInput,
  charging: { mode: ChargingMode; swap: SwapInput; swapSharePct: number; charger: ChargerInput },
  day: number,
): DailyEnergy {
  const routeMult = 1 + fleet.routeFactorPct / 100;
  const seasonMult = seasonalMultiplier(day, fleet.seasonalFactorPct);
  // 单车电池侧日需求 = 里程 × 单位能耗 × 线路修正 × 季节修正
  const perTruck =
    fleet.dailyMileageKm * fleet.energyConsumptionKwhPerKm * routeMult * seasonMult;
  const atBattery = perTruck * Math.max(0, fleet.truckCount);

  const swapEnabled = charging.swap.enabled && charging.mode !== "charging";
  const sharePct = charging.mode === "swap" ? 100 : swapEnabled ? charging.swapSharePct : 0;
  const swapAtBattery = atBattery * (sharePct / 100);
  const chargeAtBattery = atBattery - swapAtBattery;

  const chargeEff = Math.max(0.01, charging.charger.chargingEfficiencyPct / 100);
  const swapEff = Math.max(0.01, 1 - charging.swap.swapEnergyLossPct / 100);
  const atGrid = chargeAtBattery / chargeEff + swapAtBattery / swapEff;

  return { atBatteryKwh: atBattery, atGridKwh: atGrid, swapAtBatteryKwh: swapAtBattery };
}

/** 充电窗口的步集合（支持跨零点；返回的是「一天内的步序」与年内的跨日偏移）。 */
function windowStepOffsets(startHour: number, endHour: number): number[] {
  const startStep = Math.round(startHour * STEPS_PER_HOUR);
  const endStep = Math.round(endHour * STEPS_PER_HOUR);
  const out: number[] = [];
  for (let s = startStep; s < endStep; s++) out.push(s);
  return out;
}

/**
 * 主计算：车队条件 → 15 分钟需求曲线。
 *
 * 输出曲线为**电池侧 kWh/步**（需求口径），站点可交付性由 `charging.ts` 判定。
 */
export function computeTruckDemand(
  fleet: TruckFleetInput,
  charging: { mode: ChargingMode; swap: SwapInput; swapSharePct: number; charger: ChargerInput },
): TruckDemandComputation {
  const diagnostics: Diagnostic[] = [];

  /* ── 输入合法性（缺条件 → 明确告知，不猜）── */
  const windowHours = fleet.chargingWindowEndHour - fleet.chargingWindowStartHour;
  if (!(windowHours > 0)) {
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "charging_window_invalid",
      message: "充电窗口设置无效：窗口终点必须晚于起点（跨零点请把终点写成大于 24 的小时数）。",
      field: "truck.chargingWindowEndHour",
      impact: "无法把日能量需求分配到 15 分钟负荷曲线上，本情景的峰值负荷与购电成本不可用。",
      suggestion: "例如把「22:00 至次日 06:00」写成起点 22、终点 30。",
    });
  }
  if (fleet.truckCount < 0) {
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "truck_count_negative",
      message: "车队规模不能为负数。",
      field: "truck.truckCount",
    });
  }

  const offsets = windowHours > 0 ? windowStepOffsets(fleet.chargingWindowStartHour, fleet.chargingWindowEndHour) : [];
  const windowSteps = Math.max(1, offsets.length); // 仅用于避免除零
  // 真实口径：窗口无效（未配置或倒挂）时为 0，不得报出 0.25 这种假数
  const effectiveWindowHours = offsets.length / STEPS_PER_HOUR;

  /* ── 逐日计算并把能量放到窗口步上 ── */
  const demandProfile = zeros(); // 电池侧（桩输出）负荷曲线，供充电层做资源分配
  const gridSideProfile = zeros(); // 同曲线的**电网侧**等价量，与 `annualEnergyDemandKwh` 同口径
  // 年度合计只统计**落在本年日历内**的部分，保证「逐月之和 === 年度合计」严格闭合；
  // 落在次年的部分单列进 `yearBoundarySpillKwh`，绝不混入年度合计（口径 vs 能力必须分开）。
  let annualAtBattery = 0;
  let annualAtGrid = 0;
  let operatingDays = 0;
  let spillAtBattery = 0;
  let spillAtGrid = 0;
  let peakDailyAtBattery = 0;

  for (let day = 0; day < DAYS_PER_YEAR; day++) {
    if (!operatesOnDay(day, fleet.operatingDaysPerYear)) continue;
    operatingDays++;
    const d = dailyEnergyOf(fleet, charging, day);
    if (d.atBatteryKwh > peakDailyAtBattery) peakDailyAtBattery = d.atBatteryKwh;

    // 窗口内**平铺**（`unmanaged` 口径；有序充电的形状调整在充电层按设备能力完成，
    // 需求层刻意保持"均匀回场"的保守形状——否则"有序"会掩盖"桩不够"的问题）
    const perStepBattery = d.atBatteryKwh / windowSteps;
    const perStepGrid = d.atGridKwh / windowSteps;
    const dayBase = day * STEPS_PER_DAY;
    for (let k = 0; k < offsets.length; k++) {
      const idx = dayBase + offsets[k];
      if (idx >= STEPS_PER_YEAR) {
        // 年末越界：如实累计到溢出量，不回绕、不静默丢弃、也不计入本年合计
        spillAtBattery += perStepBattery;
        spillAtGrid += perStepGrid;
        continue;
      }
      demandProfile[idx] += perStepBattery;
      gridSideProfile[idx] += perStepGrid;
      annualAtBattery += perStepBattery;
      annualAtGrid += perStepGrid;
    }
  }

  /* 边界溢出只作为**数据**返回（`yearBoundarySpillKwh`），不在本层发诊断：
   * 同一个现象在充电层还会再算一次，两处各发一条会让报告出现三条同义告警。
   * 诊断统一由引擎在拿到两层数据后合并成一条，口径只写一次。 */

  /* ── 汇总指标 ── */
  // 月度/日均与 `annualEnergyDemandKwh` **同为电网侧口径**：同名字段族不得跨口径
  // （电池侧曲线只用于负荷形状，不得冒充能量需求统计）。
  const monthlyAtBattery = sumByMonth(demandProfile);
  const monthlyAtGrid = sumByMonth(gridSideProfile);
  const dailyAvgBattery = operatingDays > 0 ? annualAtBattery / operatingDays : 0;
  const dailyAvgGrid = operatingDays > 0 ? annualAtGrid / operatingDays : 0;
  // 峰值/平均充电负荷按**桩输出侧（电池侧）理论口径**（窗口内平铺，不含设备限制）
  const peakChargingLoadKw = effectiveWindowHours > 0 ? peakDailyAtBattery / effectiveWindowHours : 0;
  const averageChargingLoadKw = effectiveWindowHours > 0 ? dailyAvgBattery / effectiveWindowHours : 0;

  const result: TruckDemandResult = {
    annualEnergyDemandKwh: round2(annualAtGrid),
    annualEnergyAtBatteryKwh: round2(annualAtBattery),
    dailyEnergyDemandKwh: round2(dailyAvgGrid),
    monthlyEnergyDemandKwh: monthlyAtGrid.map(round2),
    dailyEnergyAtBatteryKwh: round2(dailyAvgBattery),
    monthlyEnergyAtBatteryKwh: monthlyAtBattery.map(round2),
    operatingDays,
    chargingWindowHours: round2(effectiveWindowHours),
    peakChargingLoadKw: round2(peakChargingLoadKw),
    averageChargingLoadKw: round2(averageChargingLoadKw),
    demandProfileKwh: demandProfile,
    yearBoundarySpillKwh: round2(spillAtGrid),
    yearBoundarySpillAtBatteryKwh: round2(spillAtBattery),
  };

  return {
    result,
    diagnostics,
    requiredStationPowerKw: round2(peakChargingLoadKw),
  };
}

/** 单日能耗画像（供 UI 展示"典型一天"）。取全年运营日中能耗最接近日均值的一天。 */
export function typicalDayProfile(
  demandProfileKwh: TimeSeries,
  day: number,
): { hours: number[]; valuesKwh: number[]; valuesKw: number[] } {
  const hours: number[] = [];
  const valuesKwh: number[] = [];
  const valuesKw: number[] = [];
  const base = Math.max(0, Math.min(DAYS_PER_YEAR - 1, day)) * STEPS_PER_DAY;
  for (let s = 0; s < STEPS_PER_DAY; s++) {
    const v = demandProfileKwh[base + s] ?? 0;
    hours.push(s / STEPS_PER_HOUR);
    valuesKwh.push(round2(v));
    valuesKw.push(round2(v * STEPS_PER_HOUR));
  }
  return { hours, valuesKwh, valuesKw };
}

/** 月度能量（供图表）。 */
export function monthlySeries(series: TimeSeries): number[] {
  return sumByMonth(series).map(round2);
}

/** 全年总量（kWh；序列为 kWh/步，逐步相加即为年电量）。 */
export function annualEnergyOf(series: TimeSeries): number {
  return round2(sumAllSafe(series));
}

function sumAllSafe(series: TimeSeries): number {
  let s = 0;
  for (let i = 0; i < series.length; i++) s += series[i];
  return s;
}

/** 曲线峰值（kW；序列为 kWh/步）。 */
export function peakKw(seriesKwhPerStep: TimeSeries): number {
  return round2(peakOf(seriesKwhPerStep) * STEPS_PER_HOUR);
}

/** 某月的曲线峰值（kW；序列为 kWh/步）。 */
export function peakKwInMonth(seriesKwhPerStep: TimeSeries, month: number): number {
  const { start, end } = monthStepRange(month);
  let p = 0;
  for (let t = start; t < end; t++) if (seriesKwhPerStep[t] > p) p = seriesKwhPerStep[t];
  return round2(p * STEPS_PER_HOUR);
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
