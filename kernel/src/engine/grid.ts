/**
 * 电网与电价模型（GridConnection）—— 分时电价、需量电费、购电与上网收入。
 *
 * ## 电价口径（V1 与 V2 的分水岭之一）
 *
 * V1 用一个"工商业电价"平摊全部电量，于是**峰谷价差、储能价值、有序充电**这些结论
 * 全都只能靠外挂参数近似。V2 把它变成逐 15 分钟的真实电价向量：
 *
 *   到户电价(t) = 平段基准价 × 时段倍率(平 / 峰 / 谷)
 *
 * 其中**倍率来自已核实的官方条款**（峰 = 平 × 1.60、谷 = 平 × 0.45），
 * 而**平段基准价的绝对值暂无官方可核验来源**——这一点在基准层与报告的假设清单里都写明了，
 * 不做"用比例倒推绝对值"这种看起来聪明、实则编数的动作。
 *
 * 需量电费按「逐月最大下网需量 × 需量电价」计。集中式充换电设施在 2030 年前按免收处理
 * （有官方条款），此时该项恒为 0，但**逐月最大需量仍照实给出**——它是判断"要不要上储能削峰"
 * 的关键量，不能因为不用付钱就不算。
 *
 * ## 时间口径
 *
 * 时段判定只看**钟点**（不区分季节、不区分工作日/节假日）。官方分时电价的四季时段表
 * 尚未结构化录入，这一缺口写在基准层条目与报告的假设清单里。
 */

import {
  STEPS_PER_YEAR,
  STEPS_PER_DAY,
  STEPS_PER_HOUR,
  TIME_STEP_MINUTES,
  hourOfDay,
  weightedAveragePrice,
  sumAll,
} from "@app/kernel/engine/time";
import { inValleyWindows } from "@app/kernel/engine/charging";
import type { Diagnostic, GridInput, GridResult, TimeSeries } from "@app/kernel/engine/types";

/** 电网模型版本。 */
export const GRID_MODEL_VERSION = "1.0.0";
export function gridModelCalcRef(): string {
  return `grid@${GRID_MODEL_VERSION}`;
}

const DT_HOURS = TIME_STEP_MINUTES / 60;

/** 把 "HH:MM-HH:MM" 解析成 `[起始小时, 结束小时)`（支持跨零点，如 23:00-07:00 → [23,7]）。 */
export function parseHourWindow(spec: string): [number, number] | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec ?? "");
  if (!m) return null;
  const sh = Number(m[1]) + Number(m[2]) / 60;
  const eh = Number(m[3]) + Number(m[4]) / 60;
  if (!Number.isFinite(sh) || !Number.isFinite(eh)) return null;
  if (sh < 0 || sh > 24 || eh < 0 || eh > 24) return null;
  return [sh, eh];
}

export interface PriceProfile {
  /** 逐 15 分钟到户电价（元/kWh）。 */
  priceProfileYuanPerKwh: number[];
  /** 平段电价（元/kWh）。 */
  flatPrice: number;
  /** 峰段电价。 */
  peakPrice: number;
  /** 谷段电价。 */
  valleyPrice: number;
  /** 认为"是峰段"的电价门槛（分类用，取峰与平的中间值）。 */
  peakThreshold: number;
  /** 认为"是谷段"的电价门槛（分类用，取平与谷的中间值）。 */
  valleyThreshold: number;
  /** 解析后的峰/谷时段（小时区间）。 */
  peakWindows: Array<[number, number]>;
  valleyWindows: Array<[number, number]>;
  diagnostics: Diagnostic[];
}

/**
 * 构造逐时电价向量。未启用分时电价 → 全时段平段价（不分峰谷）。
 */
export function buildPriceProfile(grid: GridInput): PriceProfile {
  const diagnostics: Diagnostic[] = [];
  const flat = Math.max(0, grid.flatPriceYuanPerKwh);
  const peakPrice = flat * grid.peakMultiplier;
  const valleyPrice = flat * grid.valleyMultiplier;

  const peakWindows: Array<[number, number]> = [];
  const valleyWindows: Array<[number, number]> = [];
  for (const s of grid.touEnabled ? grid.touWindows.peak : []) {
    const w = parseHourWindow(s);
    if (w) peakWindows.push(w);
    else diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "tou_window_unparsable",
      message: `峰段时段「${s}」无法解析，已忽略该时段。`,
      field: "grid.touWindows.peak",
      suggestion: "时段请按 HH:MM-HH:MM 格式填写，例如 08:00-11:00。",
    });
  }
  for (const s of grid.touEnabled ? grid.touWindows.valley : []) {
    const w = parseHourWindow(s);
    if (w) valleyWindows.push(w);
    else diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "tou_window_unparsable",
      message: `谷段时段「${s}」无法解析，已忽略该时段。`,
      field: "grid.touWindows.valley",
      suggestion: "时段请按 HH:MM-HH:MM 格式填写，例如 23:00-07:00。",
    });
  }

  const price = new Array<number>(STEPS_PER_YEAR);
  if (!grid.touEnabled) {
    price.fill(flat);
  } else {
    for (let t = 0; t < STEPS_PER_YEAR; t++) {
      const h = hourOfDay(t);
      if (inValleyWindows(h, valleyWindows)) price[t] = valleyPrice;
      else if (inValleyWindows(h, peakWindows)) price[t] = peakPrice;
      else price[t] = flat;
    }
  }

  return {
    priceProfileYuanPerKwh: price,
    flatPrice: flat,
    peakPrice,
    valleyPrice,
    // 分类门槛取相邻档位的中间值（本例共三档，故阈值唯一确定）
    peakThreshold: grid.touEnabled ? (peakPrice + flat) / 2 : Number.POSITIVE_INFINITY,
    valleyThreshold: grid.touEnabled ? (flat + valleyPrice) / 2 : Number.NEGATIVE_INFINITY,
    peakWindows,
    valleyWindows,
    diagnostics,
  };
}

export interface GridCostInput {
  importProfileKw: TimeSeries;
  exportProfileKw: TimeSeries;
  curtailmentProfileKw: TimeSeries;
  unservedProfileKw: TimeSeries;
  priceProfileYuanPerKwh: TimeSeries;
  feedInTariffYuanPerKwh: number;
  demandChargePerKwMonth: number;
  monthlyPeakImportKw: number[];
  capacityConstrained: boolean;
  gridCapacityKw: number;
}

export interface GridCostResult {
  result: GridResult;
  diagnostics: Diagnostic[];
  /** 分项成本（供经济层与报告直接引用，避免各处重算）。 */
  breakdown: {
    energyCostYuan: number;
    demandChargeYuan: number;
    exportRevenueYuan: number;
    totalCostYuan: number;
  };
}

/** 主计算：由能量分配结果推出电网侧成本。 */
export function computeGridCosts(input: GridCostInput): GridCostResult {
  const diagnostics: Diagnostic[] = [];

  const importKwhPerStep = new Array<number>(STEPS_PER_YEAR);
  const exportKwhPerStep = new Array<number>(STEPS_PER_YEAR);
  const curtailKwhPerStep = new Array<number>(STEPS_PER_YEAR);
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    importKwhPerStep[t] = (input.importProfileKw[t] ?? 0) * DT_HOURS;
    exportKwhPerStep[t] = (input.exportProfileKw[t] ?? 0) * DT_HOURS;
    curtailKwhPerStep[t] = (input.curtailmentProfileKw[t] ?? 0) * DT_HOURS;
  }

  const annualImportKwh = sumAll(importKwhPerStep);
  const annualExportKwh = sumAll(exportKwhPerStep);

  let energyCost = 0;
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    energyCost += importKwhPerStep[t] * (input.priceProfileYuanPerKwh[t] ?? 0);
  }
  const demandCharge = input.monthlyPeakImportKw.reduce(
    (s, p) => s + p * input.demandChargePerKwMonth,
    0,
  );
  const exportRevenue = annualExportKwh * input.feedInTariffYuanPerKwh;

  if (input.demandChargePerKwMonth > 0 && input.monthlyPeakImportKw.length) {
    const peak = Math.max(...input.monthlyPeakImportKw);
    diagnostics.push({
      kind: "EVIDENCE_MISSING",
      code: "demand_charge_applied",
      message: `已按需量电价计入电费：逐月最大下网需量峰值约 ${Math.round(peak)} kW，全年需量电费约 ${Math.round(demandCharge).toLocaleString("zh-CN")} 元。`,
      impact: "需量电价水平取自基准参数，若当地实际结算价不同，购电成本会随之变化。",
      suggestion: "如项目属于免收需量电费的集中式充换电设施，可把需量电价改为 0 后重算对比。",
    });
  }

  const wapRaw = weightedAveragePrice(input.priceProfileYuanPerKwh, importKwhPerStep);
  const wap = wapRaw === null || !Number.isFinite(wapRaw) ? null : round4(wapRaw);

  const result: GridResult = {
    importProfileKwh: importKwhPerStep.map(round4),
    exportProfileKwh: exportKwhPerStep.map(round4),
    priceProfileYuanPerKwh: input.priceProfileYuanPerKwh as number[],
    curtailmentProfileKwh: curtailKwhPerStep.map(round4),
    annualImportKwh: round2(annualImportKwh),
    annualExportKwh: round2(annualExportKwh),
    annualEnergyCostYuan: round2(energyCost),
    annualExportRevenueYuan: round2(exportRevenue),
    annualDemandChargeYuan: round2(demandCharge),
    annualGridCostYuan: round2(energyCost + demandCharge - exportRevenue),
    weightedAveragePriceYuanPerKwh: wap,
    monthlyPeakImportKw: input.monthlyPeakImportKw.map(round2),
    capacityConstrained: input.capacityConstrained,
  };

  return {
    result,
    diagnostics,
    breakdown: {
      energyCostYuan: round2(energyCost),
      demandChargeYuan: round2(demandCharge),
      exportRevenueYuan: round2(exportRevenue),
      totalCostYuan: round2(energyCost + demandCharge - exportRevenue),
    },
  };
}

/** 年度分时电量分布（峰/平/谷各多少电量），供报告展示分时结构。 */
export function touEnergySplit(
  importKwh: TimeSeries,
  priceProfile: TimeSeries,
  flatPrice: number,
  threshold: { peakThreshold: number; valleyThreshold: number },
): { peakKwh: number; flatKwh: number; valleyKwh: number; peakPct: number; valleyPct: number } {
  let peak = 0;
  let flat = 0;
  let valley = 0;
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const e = importKwh[t] ?? 0;
    const p = priceProfile[t] ?? flatPrice;
    if (p >= threshold.peakThreshold) peak += e;
    else if (p <= threshold.valleyThreshold) valley += e;
    else flat += e;
  }
  const total = peak + flat + valley;
  return {
    peakKwh: round2(peak),
    flatKwh: round2(flat),
    valleyKwh: round2(valley),
    peakPct: total > 0 ? round2((peak / total) * 100) : 0,
    valleyPct: total > 0 ? round2((valley / total) * 100) : 0,
  };
}

/** 典型日的逐时电价（供 UI 画价格阶梯）。 */
export function typicalDayPrice(priceProfile: TimeSeries, day: number): { hours: number[]; price: number[] } {
  const hours: number[] = [];
  const price: number[] = [];
  const base = Math.max(0, Math.min(364, day)) * STEPS_PER_DAY;
  for (let s = 0; s < STEPS_PER_DAY; s++) {
    hours.push(s / STEPS_PER_HOUR);
    price.push(round4(priceProfile[base + s] ?? 0));
  }
  return { hours, price };
}

/** 步序号 → 当天小时（供 UI 定位时间轴；与 `time.hourOfDay` 同口径，此处仅做重导出）。 */
export function stepHour(t: number): number {
  return hourOfDay(t);
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  if (!Number.isFinite(v)) return v as unknown as number;
  return Math.round(v * 10000) / 10000;
}
