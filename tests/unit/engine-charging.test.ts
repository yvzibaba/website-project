import { describe, expect, it } from "vitest";
import { buildPriceProfile } from "@app/kernel/engine/grid";
import { DEFAULT_CHARGER, DEFAULT_SWAP, DEFAULT_TOU_WINDOWS, DEFAULT_TRUCK } from "@app/kernel/engine/scenario";
import { STEPS_PER_DAY, STEPS_PER_YEAR, zeros } from "@app/kernel/engine/time";
import { computeCharging, inValleyWindows } from "@app/kernel/engine/charging";
import type { ChargerInput, GridInput, SwapInput, TruckFleetInput } from "@app/kernel/engine/types";

const GRID: GridInput = {
  capacityKw: 2500,
  importLimitKw: 2500,
  exportAllowed: true,
  exportLimitKw: 2500,
  touEnabled: true,
  flatPriceYuanPerKwh: 0.55,
  peakMultiplier: 1.6,
  valleyMultiplier: 0.45,
  touWindows: { ...DEFAULT_TOU_WINDOWS },
  demandChargePerKwMonth: 0,
  feedInTariffYuanPerKwh: 0.35,
};

const PRICE = buildPriceProfile(GRID);

function run(opts: {
  fleet?: Partial<TruckFleetInput>;
  charger?: Partial<ChargerInput>;
  swap?: Partial<SwapInput>;
  mode?: "charging" | "swap" | "hybrid";
  swapSharePct?: number;
  managed?: boolean;
} = {}) {
  const fleet: TruckFleetInput = { ...DEFAULT_TRUCK, ...opts.fleet };
  return computeCharging({
    fleet,
    charger: { ...DEFAULT_CHARGER, ...opts.charger },
    swap: { ...DEFAULT_SWAP, ...opts.swap },
    mode: opts.mode ?? "charging",
    swapSharePct: opts.swapSharePct ?? 0,
    managedCharging: opts.managed ?? false,
    pvOutputKw: zeros(),
    priceProfileYuanPerKwh: PRICE.priceProfileYuanPerKwh,
    touEnabled: true,
    touValleyHours: PRICE.valleyWindows,
  });
}

describe("充换电模型", () => {
  it("谷段判定支持跨零点区间（23:00 → 07:00）", () => {
    const w: Array<[number, number]> = [[23, 7]];
    expect(inValleyWindows(23, w)).toBe(true);
    expect(inValleyWindows(2, w)).toBe(true);
    expect(inValleyWindows(6, w)).toBe(true);
    expect(inValleyWindows(7, w)).toBe(false);
    expect(inValleyWindows(12, w)).toBe(false);
    expect(inValleyWindows(22, w)).toBe(false);
  });

  it("能力充足时不产生未满足需求，且交付量守恒", () => {
    const { result, diagnostics } = run({ charger: { chargerCount: 20, chargerPowerKw: 240 } });
    expect(result.unservedEnergyKwh).toBe(0);
    expect(diagnostics.some((d) => d.code === "charger_capacity_insufficient")).toBe(false);
    // 电池侧交付 ÷ 效率 = 电网侧取电（无换电时恰好相等）
    expect(result.annualGridSideKwh).toBeCloseTo(result.annualDeliveredKwh / (DEFAULT_CHARGER.chargingEfficiencyPct / 100), 2);
    expect(result.annualChargingDeliveredKwh).toBeCloseTo(result.annualDeliveredKwh, 6);
    expect(result.annualSwapDeliveredKwh).toBe(0);
  });

  it("能力不足时未满足需求被显式登记，不被悄悄摊薄", () => {
    const { result, diagnostics } = run({ charger: { chargerCount: 2, chargerPowerKw: 120 } });
    expect(result.unservedEnergyKwh).toBeGreaterThan(0);
    const d = diagnostics.find((x) => x.code === "charger_capacity_insufficient");
    expect(d).toBeTruthy();
    expect(d!.kind).toBe("CONSTRAINT_VIOLATION");
    expect(d!.suggestion).toBeTruthy();
    // 交付量不可能超过"有效功率 × 窗口时长 × 运营天数"这个物理上限
    const physicalCap = DEFAULT_TRUCK.operatingDaysPerYear * result.effectivePowerKw * 9;
    expect(result.annualGridSideKwh).toBeLessThanOrEqual(physicalCap + 1e-6);
  });

  it("装机由桩数 × 单桩功率给出，有效功率再乘同时率", () => {
    const { result } = run({ charger: { chargerCount: 10, chargerPowerKw: 240, simultaneousRatePct: 80 } });
    expect(result.installedPowerKw).toBe(2400);
    expect(result.effectivePowerKw).toBeCloseTo(1920, 6);
  });

  it("曲线峰值不超过有效并发功率（设备物理上限）", () => {
    const { result } = run({ charger: { chargerCount: 10, chargerPowerKw: 240 } });
    expect(result.peakLoadKw).toBeLessThanOrEqual(result.effectivePowerKw + 1e-6);
  });

  it("有序充电把负荷优先压到低价时段：谷段电量占比显著高于无序", () => {
    const unmanaged = run({ charger: { chargerCount: 14, chargerPowerKw: 240 }, managed: false }).result;
    const managed = run({ charger: { chargerCount: 14, chargerPowerKw: 240 }, managed: true }).result;

    const valleyKwh = (profile: readonly number[]): number => {
      let s = 0;
      for (let t = 0; t < STEPS_PER_YEAR; t++) {
        const h = Math.floor((t % STEPS_PER_DAY) / 4);
        if (inValleyWindows(h, PRICE.valleyWindows)) s += profile[t] * 0.25;
      }
      return s;
    };
    const uv = valleyKwh(unmanaged.loadProfileKw);
    const mv = valleyKwh(managed.loadProfileKw);
    expect(mv).toBeGreaterThan(uv);
    expect(mv / managed.annualGridSideKwh).toBeGreaterThan(uv / unmanaged.annualGridSideKwh);
  });

  it("有序充电不改变总需求（只能挪时间，不能造能量）", () => {
    const a = run({ managed: false }).result;
    const b = run({ managed: true }).result;
    // 只允许年度边界那一天的微妙差别（有序充电把年内容量用得更满），不允许成量级差异
    const relDiff = Math.abs(b.annualGridSideKwh - a.annualGridSideKwh) / a.annualGridSideKwh;
    expect(relDiff).toBeLessThan(0.001);
  });

  it("纯换电：不产生充电负荷，换电量与交付量一致", () => {
    const { result } = run({
      mode: "swap",
      swap: { enabled: true, stationCount: 1, chargingPowerKwPerStation: 2000 },
    });
    expect(result.annualChargingDeliveredKwh).toBe(0);
    expect(result.annualSwapDeliveredKwh).toBeGreaterThan(0);
    expect(result.annualSwapEvents).toBeGreaterThan(0);
    expect(result.swapGridSideKwh).toBeGreaterThan(result.annualSwapDeliveredKwh); // 有换电损耗
  });

  it("混合模式：充换电交付量之和 = 总交付量", () => {
    const { result } = run({
      mode: "hybrid",
      swapSharePct: 40,
      swap: { enabled: true, stationCount: 1, chargingPowerKwPerStation: 2000 },
    });
    expect(result.annualChargingDeliveredKwh + result.annualSwapDeliveredKwh).toBeCloseTo(result.annualDeliveredKwh, 4);
    expect(result.annualChargingDeliveredKwh).toBeGreaterThan(0);
    expect(result.annualSwapDeliveredKwh).toBeGreaterThan(0);
  });

  it("年度边界溢出与能力不足分开归因：前者会进 yearBoundarySpillKwh，后者才进 unserved", () => {
    // 窗口 21:00 → 次日 06:00，年末最后一天必然越过 12/31 24:00
    const { result, diagnostics } = run({ charger: { chargerCount: 30, chargerPowerKw: 240 } });
    expect(result.yearBoundarySpillKwh).toBeGreaterThan(0);
    expect(result.unservedEnergyKwh).toBe(0);
    expect(diagnostics.some((d) => d.code === "charger_capacity_insufficient")).toBe(false);
  });

  it("逐月峰值与曲线一致（用于变压器/并网容量校核）", () => {
    const { result } = run();
    expect(result.monthlyPeakLoadKw).toHaveLength(12);
    const maxMonthly = Math.max(...result.monthlyPeakLoadKw);
    expect(maxMonthly).toBeLessThanOrEqual(result.peakLoadKw + 0.01);
    expect(maxMonthly).toBeGreaterThan(0);
  });
});
