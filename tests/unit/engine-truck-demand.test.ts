import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARGER,
  DEFAULT_SWAP,
  DEFAULT_TRUCK,
} from "@app/kernel/engine/scenario";
import { DAYS_PER_YEAR, sumAll } from "@app/kernel/engine/time";
import {
  annualEnergyOf,
  computeTruckDemand,
  dailyEnergyOf,
  monthlySeries,
  operatesOnDay,
  seasonalMultiplier,
} from "@app/kernel/engine/truck-demand";
import type { TruckFleetInput } from "@app/kernel/engine/types";

const CHARGING_REF = {
  mode: "charging" as const,
  swap: DEFAULT_SWAP,
  swapSharePct: 0,
  charger: DEFAULT_CHARGER,
};

describe("重卡用能需求模型", () => {
  it("运营日散布：全年恰好等于设定天数，且不重复不遗漏", () => {
    for (const days of [0, 1, 7, 100, 330, 364, 365]) {
      let n = 0;
      const set = new Set<number>();
      for (let d = 0; d < DAYS_PER_YEAR; d++) {
        if (operatesOnDay(d, days)) {
          n++;
          set.add(d);
        }
      }
      expect(n).toBe(days);
      expect(set.size).toBe(days);
    }
  });

  it("运营日散布是确定的（同入必同出，可复算）", () => {
    const a = Array.from({ length: DAYS_PER_YEAR }, (_, d) => (operatesOnDay(d, 137) ? 1 : 0)).join("");
    const b = Array.from({ length: DAYS_PER_YEAR }, (_, d) => (operatesOnDay(d, 137) ? 1 : 0)).join("");
    expect(a).toBe(b);
  });

  it("季节因子全年均值≈1、冬高夏低（1 月高于 7 月）", () => {
    const avg = Array.from({ length: DAYS_PER_YEAR }, (_, d) => seasonalMultiplier(d, 18)).reduce(
      (a, b) => a + b,
      0,
    ) / DAYS_PER_YEAR;
    expect(avg).toBeCloseTo(1, 6);
    const jan = seasonalMultiplier(14, 18); // 峰值日 = 1 月 15 日（0-based day 14）
    const jul = seasonalMultiplier(14 + 182, 18);
    expect(jan).toBeGreaterThan(jul);
    expect(jan).toBeCloseTo(1.18, 9);
  });

  it("季节因子为 0 时全年持平（不得留下残留季节差）", () => {
    for (const d of [0, 100, 200, 364]) expect(seasonalMultiplier(d, 0)).toBeCloseTo(1, 12);
  });

  it("单车日能耗 = 里程 × 单位能耗 × 线路修正 × 季节修正", () => {
    const fleet: TruckFleetInput = { ...DEFAULT_TRUCK, truckCount: 1, seasonalFactorPct: 0, routeFactorPct: 0 };
    const e = dailyEnergyOf(fleet, CHARGING_REF, 0);
    expect(e.atBatteryKwh).toBeCloseTo(fleet.dailyMileageKm * fleet.energyConsumptionKwhPerKm, 6);
    // 电网侧口径 = 电池侧 ÷ 充电效率
    expect(e.atGridKwh).toBeCloseTo(e.atBatteryKwh / (DEFAULT_CHARGER.chargingEfficiencyPct / 100), 6);
  });

  it("线路/季节/品牌修正按倍率相乘，而不是相加后再乘", () => {
    const base: TruckFleetInput = { ...DEFAULT_TRUCK, truckCount: 1, seasonalFactorPct: 0, routeFactorPct: 0 };
    const withFactors: TruckFleetInput = { ...base, seasonalFactorPct: 20, routeFactorPct: 10 };
    const e0 = dailyEnergyOf(base, CHARGING_REF, 0);
    const e1 = dailyEnergyOf(withFactors, CHARGING_REF, 0);
    // day 0 的季节倍率 = 1 + 0.2*cos(2π(0−14)/365)
    const expected = e0.atBatteryKwh * (1 + 0.1) * seasonalMultiplier(0, 20);
    expect(e1.atBatteryKwh).toBeCloseTo(expected, 6);
  });

  it("换电占比的拆分守恒：充电 + 换电 = 电池侧总需求", () => {
    const fleet = DEFAULT_TRUCK;
    const swapOn = { ...DEFAULT_SWAP, enabled: true };
    for (const share of [0, 30, 60, 100]) {
      const e = dailyEnergyOf(fleet, { mode: "hybrid", swap: swapOn, swapSharePct: share, charger: DEFAULT_CHARGER }, 0);
      expect(e.swapAtBatteryKwh).toBeCloseTo((e.atBatteryKwh * share) / 100, 6);
    }
    // 纯换电模式下占比恒为 100，不受 swapSharePct 影响
    const pure = dailyEnergyOf(fleet, { mode: "swap", swap: swapOn, swapSharePct: 0, charger: DEFAULT_CHARGER }, 0);
    expect(pure.swapAtBatteryKwh).toBeCloseTo(pure.atBatteryKwh, 6);
  });

  it("跨零点窗口（21 → 30）被正确识别为 9 小时", () => {
    const c = computeTruckDemand({ ...DEFAULT_TRUCK, chargingWindowStartHour: 21, chargingWindowEndHour: 30 }, CHARGING_REF);
    expect(c.result.chargingWindowHours).toBeCloseTo(9, 6);
    expect(c.diagnostics.filter((d) => d.code === "charging_window_invalid")).toHaveLength(0);
  });

  it("倒挂的窗口不静默算出 0，而是给出可定位的诊断", () => {
    const c = computeTruckDemand({ ...DEFAULT_TRUCK, chargingWindowStartHour: 10, chargingWindowEndHour: 6 }, CHARGING_REF);
    expect(c.diagnostics.some((d) => d.code === "charging_window_invalid")).toBe(true);
    expect(c.result.chargingWindowHours).toBe(0);
  });

  it("年电量口径严格闭合：曲线积分 = 年合计 = 逐月之和（溢出单列、不得混入本年）", () => {
    const c = computeTruckDemand(DEFAULT_TRUCK, CHARGING_REF);
    const r = c.result;
    const seriesBattery = annualEnergyOf(r.demandProfileKwh);
    const monthlyBattery = monthlySeries(r.demandProfileKwh).reduce((a, b) => a + b, 0);
    const monthlyGrid = r.monthlyEnergyDemandKwh.reduce((a, b) => a + b, 0);

    // 电池侧：曲线积分 = 年合计 = 逐月之和（三者同口径，必须逐个对齐）
    expect(r.annualEnergyAtBatteryKwh).toBeCloseTo(seriesBattery, 0);
    expect(monthlyBattery).toBeCloseTo(seriesBattery, 0);
    expect(r.monthlyEnergyAtBatteryKwh.reduce((a, b) => a + b, 0)).toBeCloseTo(seriesBattery, 0);

    // 电网侧：逐月之和 === 年合计（同名字段族不得跨口径——曾经的缺陷正是这里）
    expect(r.monthlyEnergyDemandKwh).toHaveLength(12);
    expect(monthlyGrid).toBeCloseTo(r.annualEnergyDemandKwh, 0);
    // 电网侧 > 电池侧（充电链路有损耗，方向反了就是符号错）
    expect(r.annualEnergyDemandKwh).toBeGreaterThan(r.annualEnergyAtBatteryKwh);

    // 日均口径同样必须同源
    expect(r.dailyEnergyDemandKwh).toBeCloseTo(r.annualEnergyDemandKwh / r.operatingDays, 0);
    expect(r.dailyEnergyAtBatteryKwh).toBeCloseTo(r.annualEnergyAtBatteryKwh / r.operatingDays, 0);

    // 年末切边单列：两侧都为正，且量级属于「口径差」而非「能力差」
    expect(c.result.yearBoundarySpillKwh).toBeGreaterThan(0);
    expect(c.result.yearBoundarySpillAtBatteryKwh).toBeGreaterThan(0);
    expect(c.result.yearBoundarySpillKwh).toBeLessThan(r.annualEnergyDemandKwh * 0.01);
  });

  it("溢出只由「年末 + 跨零点窗口」共同触发（两者缺一不可）", () => {
    const crossMidnight = { ...DEFAULT_TRUCK, chargingWindowStartHour: 21, chargingWindowEndHour: 30 };
    const inDay = { ...DEFAULT_TRUCK, chargingWindowStartHour: 8, chargingWindowEndHour: 16 };

    // 不跨零点的窗口：无论运营多少天，窗口永远落在当天 96 步之内 → 零溢出
    for (const days of [1, 100, 330, 365]) {
      const c = computeTruckDemand({ ...inDay, operatingDaysPerYear: days }, CHARGING_REF);
      expect(c.result.yearBoundarySpillKwh, `${days} 天不跨零点窗口不该溢出`).toBe(0);
    }

    // 跨零点 + 全年运营（含 12/31）→ 末日窗口后段切到次年，必然溢出
    const cLast = computeTruckDemand({ ...crossMidnight, operatingDaysPerYear: 365 }, CHARGING_REF);
    expect(cLast.result.yearBoundarySpillKwh).toBeGreaterThan(0);
    expect(cLast.result.yearBoundarySpillAtBatteryKwh).toBeGreaterThan(0);
    // 溢出的上限是「一个运营日」的量级——它是口径差，不是能力差
    expect(cLast.result.yearBoundarySpillKwh).toBeLessThan(cLast.result.annualEnergyDemandKwh / 300);

    // 溢出必须被排除在年度合计之外，否则逐月之和永远对不上
    const r = cLast.result;
    expect(r.monthlyEnergyDemandKwh.reduce((a, b) => a + b, 0)).toBeCloseTo(r.annualEnergyDemandKwh, 0);
  });

  it("曲线只落在充电窗口内（不得在非窗口时段偷放电量）", () => {
    const { demandProfileKwh } = computeTruckDemand(DEFAULT_TRUCK, CHARGING_REF).result;
    const windowSteps = new Set([84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    for (let t = 0; t < demandProfileKwh.length; t += 1) {
      const inDay = t % 96;
      if (!windowSteps.has(inDay)) expect(demandProfileKwh[t]).toBe(0);
    }
    void sumAll;
  });
});
