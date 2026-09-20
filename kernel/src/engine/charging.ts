/**
 * 充换电模型（ChargingDemand / ChargingSolution）—— 把「车要多少电」变成「站要买多少电、什么时候买」。
 *
 * ## 与需求层的分工（不可混）
 *
 * - `truck-demand.ts` 算的是**需求**：车要多少，窗口内平铺，不含任何设备限制；
 * - 本层算的是**可交付**：桩/站的实际并发能力、链路效率、有序充电的时段再分配。
 *
 * 当设备装不下时，本层**不修改需求**去迎合设备（那是自欺），而是如实给出
 * `unservedEnergyKwh` 与一条可执行建议（加桩 / 缩短周转 / 延长窗口）。
 *
 * ## 有序充电（managed）的确定性与边界
 *
 * 有序充电的目标是「把充电量尽可能挪到光伏出力高的时段」。实现方式是：
 *   1. 在充电窗口内按**光伏出力从高到低**排序（同值按步序，保证确定性）；
 *   2. 贪心填充每一步到并发功率上限；
 *   3. 用不完的电量再平铺到窗口内剩余容量上。
 *
 * 三个刻意的边界：
 *   - **只挪窗口内的电量**，不把充电挪出用户给定的窗口（那会改变运营前提）；
 *   - **不改总量**：有序充电改变的是形状，不是需求（这不是 DSM 激励模型）；
 *   - 若窗口内总容量仍装不下，缺口照实报出——**有序不能救容量不足**。
 *
 * ## 换电站的充电时段
 *
 * 换电站的电池池是**独立于卡车窗口**的：它的充电时刻由站方按电价决定。
 * 因此启用分时电价时，换电电池池优先在**谷段**充电（这是换电模式的经济优势来源），
 * 受「单站充电功率 × 站数」上限约束；未启用分时电价时按 24 小时平铺。
 */

import {
  STEPS_PER_YEAR,
  STEPS_PER_DAY,
  STEPS_PER_HOUR,
  DAYS_PER_YEAR,
  TIME_STEP_MINUTES,
  zeros,
  sumAll,
  peakOf,
  monthStepRange,
  stepToMonth,
} from "@app/kernel/engine/time";
import { operatesOnDay, dailyEnergyOf } from "@app/kernel/engine/truck-demand";
import type {
  ChargerInput,
  ChargingMode,
  ChargingResult,
  Diagnostic,
  SwapInput,
  TimeSeries,
  TruckFleetInput,
} from "@app/kernel/engine/types";

/** 充换电模型版本。 */
export const CHARGING_MODEL_VERSION = "1.0.0";
export function chargingModelCalcRef(): string {
  return `charging@${CHARGING_MODEL_VERSION}`;
}

const DT_HOURS = TIME_STEP_MINUTES / 60;

export interface ChargingComputationInput {
  fleet: TruckFleetInput;
  charger: ChargerInput;
  swap: SwapInput;
  mode: ChargingMode;
  swapSharePct: number;
  /** 有序充电开关（来自场景定义）。 */
  managedCharging: boolean;
  /** 光伏出力曲线（kW，15 分钟）——有序充电的"往哪儿挪"依据；无光伏时传全零。 */
  pvOutputKw: TimeSeries;
  /**
   * 逐 15 分钟到户电价（元/kWh）——有序充电的**次级**排序依据。
   *
   * 为什么需要它：有序充电按光伏出力从高到低排队；当充电窗口落在夜间（光伏全为 0）时，
   * 这个排序退化成按步序平铺，等于没做有序充电。加上价格作为同分时的次序，
   * 夜间窗口就会自动优先填谷段——这才是有序充电在本项目里真正的价值。
   */
  priceProfileYuanPerKwh: TimeSeries;
  /** 是否启用分时电价（决定换电电池池是否只在谷段充电）。 */
  touEnabled: boolean;
  touValleyHours: Array<[number, number]>;
}

export interface ChargingComputation {
  result: ChargingResult;
  diagnostics: Diagnostic[];
}

/** 窗口内步序（0..95，支持跨零点）。 */
function windowOffsets(startHour: number, endHour: number): number[] {
  const s = Math.round(startHour * STEPS_PER_HOUR);
  const e = Math.round(endHour * STEPS_PER_HOUR);
  const out: number[] = [];
  for (let i = s; i < e; i++) out.push(i);
  return out;
}

/** 某小时是否落在谷段（谷段小时列表，支持跨零点区间如 [23, 7]）。 */
function inValleyWindows(hour: number, windows: Array<[number, number]>): boolean {
  for (const [a, b] of windows) {
    if (a <= b) {
      if (hour >= a && hour < b) return true;
    } else {
      // 跨零点，如 23 → 7
      if (hour >= a || hour < b) return true;
    }
  }
  return false;
}

/**
 * 主计算：需求 + 设备 → 站点负荷曲线（电网侧）。
 */
export function computeCharging(input: ChargingComputationInput): ChargingComputation {
  const { fleet, charger, swap, mode, managedCharging } = input;
  const diagnostics: Diagnostic[] = [];

  const windowHours = fleet.chargingWindowEndHour - fleet.chargingWindowStartHour;
  const offsets = windowHours > 0 ? windowOffsets(fleet.chargingWindowStartHour, fleet.chargingWindowEndHour) : [];
  const windowSteps = Math.max(1, offsets.length);
  // 真实口径：窗口无效时为 0（windowSteps 只用于避免除零）
  const effectiveWindowHours = offsets.length / STEPS_PER_HOUR;

  /* ── 设备能力 ── */
  const installedPowerKw = Math.max(0, charger.chargerCount) * Math.max(0, charger.chargerPowerKw);
  const simultaneous = Math.max(0, Math.min(1, charger.simultaneousRatePct / 100));
  const effectivePowerKw = installedPowerKw * simultaneous;
  const maxKwhPerStep = effectivePowerKw * DT_HOURS; // 单步可交付电量（电网侧）
  const chargingEff = Math.max(0.01, charger.chargingEfficiencyPct / 100);

  /* ── 逐日装配充电负荷 ── */
  const loadProfile = zeros(); // 电网侧 kWh/步（充电 + 换电合计）
  const chargeLoadProfile = zeros(); // 仅充电部分（电网侧）
  const swapLoadProfile = zeros(); // 仅换电部分（电网侧）

  let chargeDeliveredKwh = 0; // 电池侧交付量（仅充电部分）
  let swapDeliveredKwh = 0; // 电池侧交付量（仅换电部分）
  let unservedEnergyKwh = 0;
  let yearBoundarySpillKwh = 0;
  let annualSwapEvents = 0;
  let operatingDaysCount = 0;

  // 有序充电需要"窗口内步按光伏出力排序"的次序；每天相同，先算一次
  const orderByPv = [...offsets].sort((a, b) => {
    const pa = input.pvOutputKw[a] ?? 0;
    const pb = input.pvOutputKw[b] ?? 0;
    if (pb !== pa) return pb - pa;
    const ca = input.priceProfileYuanPerKwh[a] ?? 0;
    const cb = input.priceProfileYuanPerKwh[b] ?? 0;
    if (ca !== cb) return ca - cb; // 同光伏出力 → 电价低者优先（谷段先行）
    return a - b; // 同值按步序，保证确定性
  });

  for (let day = 0; day < DAYS_PER_YEAR; day++) {
    if (!operatesOnDay(day, fleet.operatingDaysPerYear)) continue;
    operatingDaysCount++;
    const d = dailyEnergyOf(fleet, { mode, swap, swapSharePct: input.swapSharePct, charger }, day);

    /* — 充电部分 — */
    const chargeAtBatteryDay = d.atBatteryKwh - d.swapAtBatteryKwh;
    const chargeAtGridDay = chargeAtBatteryDay / chargingEff;
    const perStepNeed = chargeAtGridDay / windowSteps;

    const dayBase = day * STEPS_PER_DAY;
    let deliveredGridDay = 0;

    /* 窗口内"落在本年度之内"与"越过年度边界"的时段 */
    const inYearOffsets: number[] = [];
    let outOfYearSteps = 0;
    for (const off of offsets) {
      if (dayBase + off < STEPS_PER_YEAR) inYearOffsets.push(off);
      else outOfYearSteps++;
    }

    if (chargeAtGridDay <= 0) {
      // 无充电需求（如纯换电）——不产生充电负荷
    } else {
      // 年内可交付上限 = 年内剩余时段数 × 单步上限；跨年时段对应的容量只能算"边界溢出"
      const capacityInYear = inYearOffsets.length * maxKwhPerStep;
      const capacityOutOfYear = outOfYearSteps * maxKwhPerStep;

      if (!managedCharging || effectivePowerKw <= 0) {
        // 回场即充：窗口内平铺
        const rate = Math.min(perStepNeed, maxKwhPerStep);
        for (const off of inYearOffsets) {
          const idx = dayBase + off;
          chargeLoadProfile[idx] += rate;
          deliveredGridDay += rate;
        }
      } else {
        // 有序充电：按"光伏出力降序 → 电价升序 → 步序"把年内容量用满
        let toPlace = Math.min(chargeAtGridDay, capacityInYear);
        for (const off of orderByPv) {
          if (toPlace <= 1e-9) break;
          if (dayBase + off >= STEPS_PER_YEAR) continue;
          const take = Math.min(maxKwhPerStep, toPlace);
          chargeLoadProfile[dayBase + off] += take;
          deliveredGridDay += take;
          toPlace -= take;
        }
      }

      /* 未交付部分的**归因顺序**（不可混为一谈）：
       *   ① 先归因于"充电窗口越过年度边界"——这是口径问题，同一笔需求会在次年交付；
       *   ② 归因之后仍有剩余，才是"设施能力真的不够"——这是配置问题，必须解决。
       * 反过来归因（把跨年当成能力不足）会让报告指责一个并不存在的缺陷。 */
      const notDelivered = Math.max(0, chargeAtGridDay - deliveredGridDay);
      const boundaryShare = Math.min(notDelivered, capacityOutOfYear);
      yearBoundarySpillKwh += boundaryShare;
      const genuineShortfall = notDelivered - boundaryShare;
      if (genuineShortfall > 1e-9) unservedEnergyKwh += genuineShortfall;
    }

    chargeDeliveredKwh += deliveredGridDay * chargingEff;

    /* — 换电部分（独立于窗口，谷段优先） — */
    if (d.swapAtBatteryKwh > 0) {
      const swapAtBatteryDay = d.swapAtBatteryKwh;
      const swapEff = Math.max(0.01, 1 - swap.swapEnergyLossPct / 100);
      const swapAtGridDay = swapAtBatteryDay / swapEff;
      const stationPowerKw = Math.max(0, swap.stationCount) * Math.max(0, swap.chargingPowerKwPerStation);
      const maxSwapKwhPerStep = stationPowerKw * DT_HOURS;

      // 候选步：优先谷段；谷段不足时扩到全天
      const valleyOffsets: number[] = [];
      const allOffsets: number[] = [];
      for (let s = 0; s < STEPS_PER_DAY; s++) {
        allOffsets.push(s);
        if (input.touEnabled && inValleyWindows(s / STEPS_PER_HOUR, input.touValleyHours)) valleyOffsets.push(s);
      }
      const primary = valleyOffsets.length > 0 ? valleyOffsets : allOffsets;

      let remainingSwap = swapAtGridDay;
      // 一轮：谷段容量
      if (primary.length > 0 && maxSwapKwhPerStep > 0) {
        let cap = maxSwapKwhPerStep;
        // 谷段若装不下，允许按谷段容量比例分摊（保持形状均匀）
        const totalCap = cap * primary.length;
        const use = Math.min(remainingSwap, totalCap);
        const per = use / primary.length;
        for (const off of primary) {
          const idx = dayBase + off;
          if (idx >= STEPS_PER_YEAR) {
            yearBoundarySpillKwh += per;
            continue;
          }
          swapLoadProfile[idx] += per;
        }
        remainingSwap -= use;
      }
      // 二轮：谷段装不下 → 余量平铺到全天（诚实：没有更便宜的时段了）
      if (remainingSwap > 1e-9 && maxSwapKwhPerStep > 0) {
        const totalCap = maxSwapKwhPerStep * allOffsets.length;
        const use = Math.min(remainingSwap, totalCap);
        const per = use / allOffsets.length;
        for (const off of allOffsets) {
          const idx = dayBase + off;
          if (idx >= STEPS_PER_YEAR) {
            yearBoundarySpillKwh += per;
            continue;
          }
          swapLoadProfile[idx] += per;
        }
        remainingSwap -= use;
      }
      if (remainingSwap > 1e-9) unservedEnergyKwh += remainingSwap;

      swapDeliveredKwh += swapAtBatteryDay;
      // 换电次数：日换电电量 ÷ 单块电池可换电量（按电池容量的可用比例计，简化为全额）
      const perSwapKwh = swap.batteryEnergyKwh > 0 ? swap.batteryEnergyKwh : 0;
      if (perSwapKwh > 0) annualSwapEvents += swapAtBatteryDay / perSwapKwh;
    }
  }

  /* ── 合成站点总负荷（电网侧）与汇总指标 ── */
  for (let i = 0; i < STEPS_PER_YEAR; i++) loadProfile[i] = chargeLoadProfile[i] + swapLoadProfile[i];

  // 合计交付量（电池侧）——诊断与结果共用，故先于此声明
  const annualDeliveredKwh = chargeDeliveredKwh + swapDeliveredKwh;

  const annualGridSideKwh = sumAll(loadProfile);
  const peakLoadKw = peakOf(loadProfile) * STEPS_PER_HOUR;
  const annualWindowHours = operatingDaysCount * effectiveWindowHours;
  const utilizationPct =
    effectivePowerKw > 0 && annualWindowHours > 0
      ? Math.min(100, (annualGridSideKwh / (effectivePowerKw * annualWindowHours)) * 100)
      : 0;

  const monthlyPeakLoadKw: number[] = [];
  for (let m = 0; m < 12; m++) {
    const { start, end } = monthStepRange(m);
    let p = 0;
    for (let t = start; t < end; t++) if (loadProfile[t] > p) p = loadProfile[t];
    monthlyPeakLoadKw.push(round2(p * STEPS_PER_HOUR));
  }

  /* ── 诊断 ── */
  if (unservedEnergyKwh > 1) {
    const needKw = effectiveWindowHours > 0 ? unservedEnergyKwh / (operatingDaysCount * effectiveWindowHours) + effectivePowerKw : 0;
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "charger_capacity_insufficient",
      message: `充电设施在给定窗口内装不下全部需求，全年约 ${fmtKwh(unservedEnergyKwh)} 电量无法交付。`,
      impact: "站点负荷与购电成本被低估，项目收益偏乐观；该情景不满足基本交付条件。",
      suggestion: `可考虑：增加充电桩数量（当前装机 ${Math.round(installedPowerKw)} kW）、提高单桩功率、延长充电窗口，或把部分需求转为换电。按当前窗口估算，需要的有效并发功率约 ${Math.round(needKw)} kW。`,
      value: round2(unservedEnergyKwh),
      unit: "kWh",
    });
  }
  if (effectivePowerKw <= 0 && annualDeliveredKwh > 0) {
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "no_charger_capacity",
      message: "当前情景未配置有效充电能力（桩数或单桩功率为 0），无法交付充电需求。",
      suggestion: "请配置充电桩数量与单桩功率。",
    });
  }
  if (utilizationPct < 10 && annualGridSideKwh > 0) {
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "charger_oversized",
      message: `充电设施年利用率仅 ${utilizationPct.toFixed(1)}%，装机明显偏大。`,
      impact: "投资中充电设施部分存在浪费，回收期被拉长。",
      suggestion: "可下调桩数或单桩功率后重算，观察回收期变化。",
      value: round2(utilizationPct),
      unit: "%",
    });
  }
  return {
    result: {
      loadProfileKw: loadProfile.map((v) => round2(v * STEPS_PER_HOUR)),
      annualDeliveredKwh: round2(annualDeliveredKwh),
      annualChargingDeliveredKwh: round2(chargeDeliveredKwh),
      annualSwapDeliveredKwh: round2(swapDeliveredKwh),
      annualGridSideKwh: round2(annualGridSideKwh),
      installedPowerKw: round2(installedPowerKw),
      effectivePowerKw: round2(effectivePowerKw),
      peakLoadKw: round2(peakLoadKw),
      utilizationPct: round2(utilizationPct),
      unservedEnergyKwh: round2(Math.max(0, unservedEnergyKwh)),
      annualSwapEvents: Math.round(annualSwapEvents),
      swapGridSideKwh: round2(sumAll(swapLoadProfile)),
      yearBoundarySpillKwh: round2(yearBoundarySpillKwh),
      monthlyPeakLoadKw,
    },
    diagnostics,
  };
}

function fmtKwh(v: number): string {
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万 kWh`;
  return `${Math.round(v).toLocaleString("zh-CN")} kWh`;
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

/** 供电池池展示：某月的负荷峰值（kW）。 */
export function monthOfStep(step: number): number {
  return stepToMonth(step);
}

/** 谷段小时预设（与电价时段表同源；仅用于换电电池池的错峰充电）。 */
export function defaultValleyWindows(): Array<[number, number]> {
  return [[23, 7]];
}

/** 供 UI/报告使用的"典型一天"负荷曲线（kW）。 */
export function typicalDayLoadKw(loadProfileKw: TimeSeries, day: number): { hours: number[]; valuesKw: number[] } {
  const hours: number[] = [];
  const valuesKw: number[] = [];
  const base = Math.max(0, Math.min(DAYS_PER_YEAR - 1, day)) * STEPS_PER_DAY;
  for (let s = 0; s < STEPS_PER_DAY; s++) {
    hours.push(s / STEPS_PER_HOUR);
    valuesKw.push(round2(loadProfileKw[base + s] ?? 0));
  }
  return { hours, valuesKw };
}

/** 小时口径的时段判定（导出供电价模块共用，避免两处各写一份）。 */
export { inValleyWindows };
