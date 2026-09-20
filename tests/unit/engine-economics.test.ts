import { describe, expect, it } from "vitest";
import {
  computeEconomics,
  perturbEconomicsInput,
  sensitivityBars,
} from "@app/kernel/engine/economics";
import type { EconomicsComputationInput } from "@app/kernel/engine/economics";
import { irr, npv } from "@app/kernel/server/finance";
import type { EconomicsInput } from "@app/kernel/engine/types";

const ECON: EconomicsInput = {
  constructionYears: 1,
  projectLifeYears: 10,
  discountRatePct: 6,
  inflationPct: 2,
  incomeTaxPct: 25,
  residualValuePct: 5,
  equityRatioPct: 30,
  loanInterestPct: 4.5,
  loanTermYears: 8,
  pvCapexYuanPerW: 3.2,
  bessCapexYuanPerWh: 1.0,
  chargerCapexYuanPerKw: 700,
  swapStationCapexYuanPerStation: 4_000_000,
  gridCapexYuanPerKw: 600,
  civilCapexYuanPerChargerKw: 300,
  pvOpexYuanPerKwpYear: 60,
  bessOpexYuanPerKwhYear: 30,
  chargerOpexYuanPerKwYear: 40,
  siteFixedOpexYuanPerYear: 200_000,
  landRentYuanPerYear: 300_000,
  insurancePctOfCapex: 0.8,
  chargingServiceFeeYuanPerKwh: 0.45,
  swapServiceFeeYuanPerKwh: 0,
  electricityResalePriceYuanPerKwh: 0,
  otherRevenueYuanPerYear: 0,
  constructionSubsidyPct: 0,
  operationSubsidyYuanPerKwh: 0,
};

const BASE: EconomicsComputationInput = {
  economics: ECON,
  pvCapacityKwp: 2000,
  bessPowerKw: 1000,
  bessEnergyKwh: 2000,
  chargerInstalledKw: 2400,
  swapStationCount: 1,
  gridCapacityKw: 2500,
  annualChargingDeliveredKwh: 4_500_000,
  annualSwapDeliveredKwh: 0,
  annualLoadKwh: 4_900_000,
  annualNetImportKwh: 4_900_000,
  annualPvGenerationKwh: 2_340_000,
  annualPvSelfConsumedKwh: 0,
  annualEnergyCostYuan: 1_400_000,
  annualDemandChargeYuan: 0,
  annualExportRevenueYuan: 800_000,
  weightedAveragePriceYuanPerKwh: 0.3,
  gridFlatPriceYuanPerKwh: 0.35,
  annualBessArbitrageBenefitYuan: 0,
  pvDegradationPctPerYear: 0.55,
  bessDegradationPctPerYear: 2.5,
  contingencyPct: 3,
  pvEnabled: true,
  bessEnabled: true,
  swapEnabled: false,
};

describe("项目经济性", () => {
  it("CAPEX 单位换算正确（元/W、元/Wh、元/kW 三种口径都不能差 1000 倍）", () => {
    const { result } = computeEconomics(BASE);
    expect(result.capex.pvYuan).toBeCloseTo(2000 * 1000 * 3.2, 2); // 2000 kWp = 2,000,000 W
    expect(result.capex.bessYuan).toBeCloseTo(2000 * 1000 * 1.0, 2); // 2000 kWh = 2,000,000 Wh
    expect(result.capex.chargerYuan).toBeCloseTo(2400 * 700, 2);
    expect(result.capex.gridYuan).toBeCloseTo(2500 * 600, 2);
    expect(result.capex.civilYuan).toBeCloseTo(2400 * 300, 2);
    const direct =
      result.capex.pvYuan +
      result.capex.bessYuan +
      result.capex.chargerYuan +
      result.capex.swapYuan +
      result.capex.gridYuan +
      result.capex.civilYuan;
    expect(result.capex.contingencyYuan).toBeCloseTo(direct * 0.03, 2);
    expect(result.capex.grossYuan).toBeCloseTo(direct * 1.03, 2);
    expect(result.capex.netYuan).toBeCloseTo(result.capex.grossYuan - result.capex.subsidyYuan, 2);
  });

  it("未启用的组件不产生投资（不是「投了不用」，而是根本没投）", () => {
    const { result } = computeEconomics({ ...BASE, pvEnabled: false, bessEnabled: false, swapEnabled: false });
    expect(result.capex.pvYuan).toBe(0);
    expect(result.capex.bessYuan).toBe(0);
    expect(result.capex.swapYuan).toBe(0);
    expect(result.capex.chargerYuan).toBeGreaterThan(0);
  });

  it("代收电费是过手成本：不记它就等于自掏腰包替车队付电费", () => {
    const withResale = computeEconomics(BASE).result;
    const withoutResale = computeEconomics({ ...BASE, annualChargingDeliveredKwh: 0, annualSwapDeliveredKwh: 0 }).result;
    expect(withResale.revenueY1.electricityResaleYuan).toBeCloseTo(4_500_000 * 0.3, 2);
    expect(withoutResale.revenueY1.electricityResaleYuan).toBe(0);
    expect(withResale.revenueY1.grossYuan).toBeGreaterThan(withoutResale.revenueY1.grossYuan);
  });

  it("显式转供电价优先于平价转供的缺省口径", () => {
    const r = computeEconomics({
      ...BASE,
      economics: { ...ECON, electricityResalePriceYuanPerKwh: 0.5 },
    }).result;
    expect(r.revenueY1.electricityResaleYuan).toBeCloseTo(4_500_000 * 0.5, 2);
  });

  it("首年成本 = 购电成本 + 运维成本；首年税前净流入 = 收入 − 成本", () => {
    const { result } = computeEconomics(BASE);
    const gridCost =
      BASE.annualEnergyCostYuan + BASE.annualDemandChargeYuan - BASE.annualExportRevenueYuan;
    expect(result.costY1Yuan).toBeCloseTo(gridCost + result.opexY1.grossYuan, 2);
    expect(result.netCashFlowY1PreTaxYuan).toBeCloseTo(result.revenueY1.grossYuan - result.costY1Yuan, 2);
    const opexSum =
      result.opexY1.pvYuan +
      result.opexY1.bessYuan +
      result.opexY1.chargerYuan +
      result.opexY1.siteFixedYuan +
      result.opexY1.landYuan +
      result.opexY1.insuranceYuan;
    expect(result.opexY1.grossYuan).toBeCloseTo(opexSum, 2);
  });

  it("NPV 必须等于 finance.ts 原语对同一条现金流的计算结果（不得另写一份公式）", () => {
    const { result } = computeEconomics(BASE);
    const expected = npv(ECON.discountRatePct / 100, result.annualCashFlowYuan);
    expect(result.metrics.npvYuan).toBeCloseTo(expected, 2);
    const i = irr(result.annualCashFlowYuan);
    if (i.ok) expect(result.metrics.irr.valuePct).toBeCloseTo((i.value ?? 0) * 100, 3);
  });

  it("全投资口径不扣还本付息、资本金口径才扣：两条口径不得混用", () => {
    const { result, details } = computeEconomics(BASE);
    // 全投资口径规模应显著大于（更乐观于）资本金口径，因为后者还要还本付息
    expect(details.loanAmountYuan).toBeGreaterThan(0);
    expect(details.equityAmountYuan).toBeGreaterThan(0);
    expect(details.loanAmountYuan + details.equityAmountYuan).toBeCloseTo(result.capex.netYuan, 1);

    // 期初现金流：全投资 = −净投资，资本金 = −资本金
    expect(result.annualCashFlowYuan[0]).toBeCloseTo(-result.capex.netYuan, 1);
    // 若两条口径被混用（期初扣全投资、年度又扣还本），首年现金流会出现"两头扣"
    const y1 = result.annualCashFlowYuan[1];
    const y1Pretax = result.netCashFlowY1PreTaxYuan;
    expect(y1).toBeGreaterThan(y1Pretax * (1 - ECON.incomeTaxPct / 100) - 1); // 至少要接近税前×(1−税率)
    expect(details.annualLoanInterestY1Yuan).toBeGreaterThan(0);
  });

  it("折旧基数 = 净投资 − 残值，直线折旧（不留悬念）", () => {
    const { result, details } = computeEconomics(BASE);
    expect(details.annualDepreciationYuan).toBeCloseTo(
      (result.capex.netYuan * (1 - ECON.residualValuePct / 100)) / ECON.projectLifeYears,
      1,
    );
  });

  it("现金流长度 = 建设期 + 运营期，残值只出现在最后一年", () => {
    const { result } = computeEconomics({ ...BASE, economics: { ...ECON, constructionYears: 2 } });
    expect(result.annualCashFlowYuan).toHaveLength(2 + ECON.projectLifeYears);
    expect(result.annualCashFlowYuan[0]).toBeCloseTo(result.annualCashFlowYuan[1], 1); // 建设期均摊
    expect(result.cumulativeCashFlowYuan).toHaveLength(result.annualCashFlowYuan.length);
  });

  it("全生命周期度电成本为**自有成本口径**（不含过手电费），且可复算", () => {
    const { result, details } = computeEconomics(BASE);
    expect(result.metrics.lcoeYuanPerKwh).not.toBeNull();
    expect(result.metrics.lcoeYuanPerKwh!).toBeCloseTo(
      details.lcoeNumeratorYuan / details.lcoeDenominatorKwh,
      4,
    );
    // 自有成本口径的度电成本必然低于"净投资 ÷ 十年电量"（因为运维也会被折现计入）
    expect(result.metrics.lcoeYuanPerKwh!).toBeLessThan(result.capex.netYuan / 4_500_000);
    // 且应远低于把购电成本也算进去的水平
    expect(result.metrics.lcoeYuanPerKwh!).toBeLessThan(0.6);
  });

  it("服务费为 0 时明确登记「收入侧不成立」的诊断，而不是给一个乐观结论", () => {
    const { diagnostics } = computeEconomics({
      ...BASE,
      economics: { ...ECON, chargingServiceFeeYuanPerKwh: 0 },
    });
    expect(diagnostics.some((d) => d.code === "service_fee_not_provided")).toBe(true);
  });

  it("平价转供被登记为假设（提示它会影响结论）", () => {
    const { diagnostics } = computeEconomics(BASE);
    const d = diagnostics.find((x) => x.code === "resale_price_assumed_at_cost");
    expect(d).toBeTruthy();
    expect(d!.kind).toBe("EVIDENCE_MISSING");
    expect(d!.suggestion).toBeTruthy();
  });

  it("储能无正收益时登记诊断（不让「投了储能」悄悄拉低回报而不出声）", () => {
    const { diagnostics } = computeEconomics({ ...BASE, annualBessArbitrageBenefitYuan: 0 });
    expect(diagnostics.some((d) => d.code === "bess_no_economic_value")).toBe(true);
  });

  it("敏感性：变量集合非空、按摆幅降序、且每根条都带基准值", () => {
    const bars = sensitivityBars(BASE);
    expect(bars.length).toBeGreaterThan(3);
    for (let i = 1; i < bars.length; i++) expect(bars[i - 1].swingYuan).toBeGreaterThanOrEqual(bars[i].swingYuan);
    for (const b of bars) {
      expect(Number.isFinite(b.npvAtLow)).toBe(true);
      expect(Number.isFinite(b.npvAtHigh)).toBe(true);
      expect(b.swingYuan).toBeCloseTo(Math.abs(b.npvAtHigh - b.npvAtLow), 1);
    }
    // 服务费是收入侧主变量，必须出现在列表里
    expect(bars.some((b) => b.key === "chargingServiceFee")).toBe(true);
  });

  it("敏感性：未启用的组件不生成无意义的条（没装光伏就别谈光伏单价）", () => {
    const bars = sensitivityBars({ ...BASE, pvEnabled: false, pvCapacityKwp: 0 });
    expect(bars.some((b) => b.key === "pvCapex")).toBe(false);
    expect(bars.some((b) => b.key === "pvYield")).toBe(false);
  });

  it("扰动函数：只改目标变量，不动其它字段", () => {
    const out = perturbEconomicsInput(BASE, "chargingServiceFee", 20);
    expect(out.economics.chargingServiceFeeYuanPerKwh).toBeCloseTo(0.45 * 1.2, 9);
    expect(out.economics.pvCapexYuanPerW).toBe(BASE.economics.pvCapexYuanPerW);
    expect(out.annualNetImportKwh).toBe(BASE.annualNetImportKwh);
    // 原对象未被就地修改（纯函数）
    expect(BASE.economics.chargingServiceFeeYuanPerKwh).toBe(0.45);

    const fleet = perturbEconomicsInput(BASE, "fleetScale", 20);
    expect(fleet.annualChargingDeliveredKwh).toBeCloseTo(BASE.annualChargingDeliveredKwh * 1.2, 6);
    // 增量运输量只能由电网补（光伏调度规模不变）→ 下网电量与电费同步上升
    expect(fleet.annualNetImportKwh - BASE.annualNetImportKwh).toBeCloseTo(BASE.annualLoadKwh * 0.2, 6);
    expect(fleet.annualEnergyCostYuan).toBeGreaterThan(BASE.annualEnergyCostYuan);
  });

  it("光伏发电量下行会同时减少自用与上网收入（不能只减一边）", () => {
    const down = perturbEconomicsInput({ ...BASE, annualPvSelfConsumedKwh: 1_000_000 }, "pvYield", -20);
    expect(down.annualPvGenerationKwh).toBeCloseTo(BASE.annualPvGenerationKwh * 0.8, 6);
    expect(down.annualPvSelfConsumedKwh).toBeCloseTo(800_000, 6);
    expect(down.annualNetImportKwh).toBeCloseTo(BASE.annualNetImportKwh + 200_000, 6);
    expect(down.annualExportRevenueYuan).toBeCloseTo(BASE.annualExportRevenueYuan * 0.8, 6);
  });
});
