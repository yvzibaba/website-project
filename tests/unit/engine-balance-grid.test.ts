import { describe, expect, it } from "vitest";
import { checkEnergyBalanceInvariant, computeEnergyBalance } from "@app/kernel/engine/balance";
import { buildPriceProfile, computeGridCosts, parseHourWindow, touEnergySplit } from "@app/kernel/engine/grid";
import { STEPS_PER_DAY, STEPS_PER_YEAR, zeros } from "@app/kernel/engine/time";
import type { GridInput } from "@app/kernel/engine/types";

/** 造一条"白天光伏、夜间负荷"的曲线。 */
function makeProfiles(loadKw: number, pvKw: number) {
  const load = zeros();
  const pv = zeros();
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const h = (t % STEPS_PER_DAY) / 4;
    if (h >= 21 || h < 6) load[t] = loadKw;
    if (h >= 9 && h < 16) pv[t] = pvKw;
  }
  return { load, pv };
}

describe("能量平衡与守恒不变量", () => {
  it("守恒式逐时段成立：pv + 放电 + 下网 == (负荷 + 充电 − 未满足) + 上网 + 弃光", () => {
    const { load, pv } = makeProfiles(1600, 900);
    const charge = zeros();
    charge[400] = 300;
    const discharge = zeros();
    discharge[800] = 200;
    const r = computeEnergyBalance({
      loadProfileKw: load,
      bessChargeKw: charge,
      bessDischargeKw: discharge,
      pvOutputKw: pv,
      importLimitKw: 2500,
      exportAllowed: true,
      exportLimitKw: 2500,
    });
    expect(r.invariant.ok).toBe(true);
    expect(r.invariant.violationCount).toBe(0);
    expect(r.invariant.maxAbsDeviationKwh).toBeLessThan(r.invariant.toleranceKwh);
  });

  it("不允许上网时，光伏富余全部计入弃光（不凭空消失）", () => {
    const { load, pv } = makeProfiles(100, 900);
    const r = computeEnergyBalance({
      loadProfileKw: load,
      bessChargeKw: zeros(),
      bessDischargeKw: zeros(),
      pvOutputKw: pv,
      importLimitKw: 2500,
      exportAllowed: false,
      exportLimitKw: 0,
    });
    expect(r.invariant.ok).toBe(true);
    expect(r.exportProfileKw.every((v) => v === 0)).toBe(true);
    expect(r.curtailmentProfileKw.some((v) => v > 0)).toBe(true);
  });

  it("并网容量不足时未满足负荷被显式记在等式右边，并给出扩容建议", () => {
    const { load, pv } = makeProfiles(2000, 0);
    const r = computeEnergyBalance({
      loadProfileKw: load,
      bessChargeKw: zeros(),
      bessDischargeKw: zeros(),
      pvOutputKw: pv,
      importLimitKw: 800,
      exportAllowed: true,
      exportLimitKw: 2500,
    });
    expect(r.capacityConstrained).toBe(true);
    expect(r.invariant.ok).toBe(true); // 守恒仍然成立——未满足被显式放在右边
    const d = r.diagnostics.find((x) => x.code === "grid_capacity_insufficient");
    expect(d).toBeTruthy();
    expect(d!.kind).toBe("CONSTRAINT_VIOLATION");
    expect(d!.suggestion).toContain("kW");
  });

  it("未满足负荷**不会**被伪装成「负荷小了一点」：任意扰动下不变量都成立", () => {
    // 随机（但确定）地扰动各类曲线，守恒必须始终成立
    for (let seed = 0; seed < 12; seed++) {
      const load = zeros();
      const pv = zeros();
      const charge = zeros();
      const discharge = zeros();
      for (let t = 0; t < STEPS_PER_YEAR; t += 7) {
        load[t] = ((t * (seed + 3)) % 900) + 1;
        pv[t] = ((t * (seed + 11)) % 700) + 1;
        charge[t] = seed % 2 === 0 ? (t % 300) : 0;
        discharge[t] = seed % 3 === 0 ? (t % 200) : 0;
      }
      const r = computeEnergyBalance({
        loadProfileKw: load,
        bessChargeKw: charge,
        bessDischargeKw: discharge,
        pvOutputKw: pv,
        importLimitKw: 300,
        exportAllowed: seed % 2 === 0,
        exportLimitKw: 250,
      });
      expect(r.invariant.ok).toBe(true);
    }
  });

  it("checkEnergyBalanceInvariant 能抓到人为破坏（不是永远返回 ok）", () => {
    const { load, pv } = makeProfiles(1000, 500);
    const bad = checkEnergyBalanceInvariant({
      pvOutputKw: pv,
      bessChargeKw: zeros(),
      bessDischargeKw: zeros(),
      loadProfileKw: load,
      importProfileKw: zeros().fill(5000), // 凭空多出 5000 kW 的下网
      exportProfileKw: zeros(),
      curtailmentProfileKw: zeros(),
      unservedProfileKw: zeros(),
    });
    expect(bad.ok).toBe(false);
    expect(bad.violationCount).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════ 电网 ═══════════════════════════ */

const GRID: GridInput = {
  capacityKw: 2500,
  importLimitKw: 2500,
  exportAllowed: true,
  exportLimitKw: 2500,
  touEnabled: true,
  flatPriceYuanPerKwh: 0.55,
  peakMultiplier: 1.6,
  valleyMultiplier: 0.45,
  touWindows: { valley: ["23:00-07:00"], peak: ["08:00-11:00", "18:00-23:00"] },
  demandChargePerKwMonth: 0,
  feedInTariffYuanPerKwh: 0.35,
};

describe("电网与电价", () => {
  it("时段字符串解析：含跨零点与非法输入", () => {
    expect(parseHourWindow("23:00-07:00")).toEqual([23, 7]);
    expect(parseHourWindow("08:00-11:00")).toEqual([8, 11]);
    expect(parseHourWindow("18:30-23:00")).toEqual([18.5, 23]);
    expect(parseHourWindow("随便写")).toBeNull();
    expect(parseHourWindow("25:00-30:00")).toBeNull();
  });

  it("分时电价向量：峰 = 平×1.60、谷 = 平×0.45，其余为平段", () => {
    const p = buildPriceProfile(GRID);
    expect(p.flatPrice).toBeCloseTo(0.55, 9);
    expect(p.peakPrice).toBeCloseTo(0.88, 9);
    expect(p.valleyPrice).toBeCloseTo(0.2475, 9);
    const at = (h: number) => p.priceProfileYuanPerKwh[h * 4];
    expect(at(23)).toBeCloseTo(0.2475, 9);
    expect(at(3)).toBeCloseTo(0.2475, 9);
    expect(at(9)).toBeCloseTo(0.88, 9);
    expect(at(20)).toBeCloseTo(0.88, 9);
    expect(at(13)).toBeCloseTo(0.55, 9);
  });

  it("未启用分时电价 → 全时段平段价（不该偷偷用峰谷价）", () => {
    const p = buildPriceProfile({ ...GRID, touEnabled: false });
    expect(new Set(p.priceProfileYuanPerKwh).size).toBe(1);
    expect(p.priceProfileYuanPerKwh[0]).toBeCloseTo(0.55, 9);
  });

  it("无法解析的时段被忽略并登记诊断，不静默套用默认时段", () => {
    const p = buildPriceProfile({ ...GRID, touWindows: { valley: ["晚上11点到早上7点"], peak: [] } });
    expect(p.diagnostics.some((d) => d.code === "tou_window_unparsable")).toBe(true);
    expect(new Set(p.priceProfileYuanPerKwh).size).toBe(1); // 只剩平段
  });

  it("电网侧总成本 = 电量电费 + 需量电费 − 上网收入", () => {
    const { load, pv } = makeProfiles(1500, 1200);
    const price = buildPriceProfile(GRID);
    const bal = computeEnergyBalance({
      loadProfileKw: load,
      bessChargeKw: zeros(),
      bessDischargeKw: zeros(),
      pvOutputKw: pv,
      importLimitKw: 2500,
      exportAllowed: true,
      exportLimitKw: 2500,
    });
    const g = computeGridCosts({
      importProfileKw: bal.importProfileKw,
      exportProfileKw: bal.exportProfileKw,
      curtailmentProfileKw: bal.curtailmentProfileKw,
      unservedProfileKw: bal.unservedProfileKw,
      priceProfileYuanPerKwh: price.priceProfileYuanPerKwh,
      feedInTariffYuanPerKwh: GRID.feedInTariffYuanPerKwh,
      demandChargePerKwMonth: 0,
      monthlyPeakImportKw: bal.monthlyPeakImportKw,
      capacityConstrained: bal.capacityConstrained,
      gridCapacityKw: GRID.capacityKw,
    });
    const r = g.result;
    expect(r.annualGridCostYuan).toBeCloseTo(
      r.annualEnergyCostYuan + r.annualDemandChargeYuan - r.annualExportRevenueYuan,
      2,
    );
    expect(r.annualExportRevenueYuan).toBeCloseTo(r.annualExportKwh * GRID.feedInTariffYuanPerKwh, 2);
    // 夜间负荷里 21:00–23:00 属峰段、23:00–06:00 属谷段 → 加权均价应为两者的电量加权
    const expectedWap = (2 * 0.88 + 7 * 0.2475) / 9;
    expect(r.weightedAveragePriceYuanPerKwh).toBeCloseTo(expectedWap, 3);
  });

  it("需量电费按逐月最大下网需量计收；免征时恒为 0", () => {
    const { load, pv } = makeProfiles(1500, 0);
    const price = buildPriceProfile(GRID);
    const bal = computeEnergyBalance({
      loadProfileKw: load,
      bessChargeKw: zeros(),
      bessDischargeKw: zeros(),
      pvOutputKw: pv,
      importLimitKw: 2500,
      exportAllowed: true,
      exportLimitKw: 2500,
    });
    const base = {
      importProfileKw: bal.importProfileKw,
      exportProfileKw: bal.exportProfileKw,
      curtailmentProfileKw: bal.curtailmentProfileKw,
      unservedProfileKw: bal.unservedProfileKw,
      priceProfileYuanPerKwh: price.priceProfileYuanPerKwh,
      feedInTariffYuanPerKwh: GRID.feedInTariffYuanPerKwh,
      monthlyPeakImportKw: bal.monthlyPeakImportKw,
      capacityConstrained: bal.capacityConstrained,
      gridCapacityKw: GRID.capacityKw,
    };
    expect(computeGridCosts({ ...base, demandChargePerKwMonth: 0 }).result.annualDemandChargeYuan).toBe(0);
    const charged = computeGridCosts({ ...base, demandChargePerKwMonth: 30 }).result;
    expect(charged.annualDemandChargeYuan).toBeCloseTo(1500 * 30 * 12, 2);
    // 免征时把 30 元/kW·月 计入会凭空多出 54 万元，必须能被这一条测住
    expect(charged.annualGridCostYuan - computeGridCosts({ ...base, demandChargePerKwMonth: 0 }).result.annualGridCostYuan).toBeCloseTo(
      1500 * 30 * 12,
      2,
    );
  });

  it("无下网电量时加权平均电价为 null（不是 0，避免被当成「免费电」）", () => {
    const price = buildPriceProfile(GRID);
    const g = computeGridCosts({
      importProfileKw: zeros(),
      exportProfileKw: zeros().fill(100),
      curtailmentProfileKw: zeros(),
      unservedProfileKw: zeros(),
      priceProfileYuanPerKwh: price.priceProfileYuanPerKwh,
      feedInTariffYuanPerKwh: GRID.feedInTariffYuanPerKwh,
      demandChargePerKwMonth: 0,
      monthlyPeakImportKw: new Array(12).fill(0),
      capacityConstrained: false,
      gridCapacityKw: GRID.capacityKw,
    });
    expect(g.result.weightedAveragePriceYuanPerKwh).toBeNull();
    expect(g.result.annualEnergyCostYuan).toBe(0);
    expect(g.result.annualExportRevenueYuan).toBeGreaterThan(0);
  });

  it("分时电量拆分：峰 + 平 + 谷 = 总下网电量", () => {
    const { load } = makeProfiles(1500, 0);
    const price = buildPriceProfile(GRID);
    const kwh = load.map((v) => v * 0.25);
    const split = touEnergySplit(kwh, price.priceProfileYuanPerKwh, price.flatPrice, {
      peakThreshold: price.peakThreshold,
      valleyThreshold: price.valleyThreshold,
    });
    const total = kwh.reduce((a, b) => a + b, 0);
    expect(split.peakKwh + split.flatKwh + split.valleyKwh).toBeCloseTo(total, 2);
    // 夜间 9 小时里 7 小时为谷段、2 小时（21:00–23:00）为峰段
    expect(split.valleyPct).toBeCloseTo((700 / 900) * 100, 1);
  });
});
