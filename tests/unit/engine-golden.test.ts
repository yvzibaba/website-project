import { describe, expect, it } from "vitest";
import {
  ENGINE_VERSION,
  MODEL_COMPOSITION,
  hashScenarioInput,
  runCalculation,
  validateScenarioInput,
} from "@app/kernel/engine/engine";
import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import {
  SCENARIO_TEMPLATES,
  buildScenarioFromTemplate,
  buildScenarioInput,
  defaultScenarioInput,
  getScenarioTemplate,
} from "@app/kernel/engine/scenario";
import { STEPS_PER_YEAR, TIME_STEP_MINUTES, sumAll } from "@app/kernel/engine/time";
import { npv } from "@app/kernel/server/finance";
import type { CalculationResult, ScenarioInput } from "@app/kernel/engine/types";

/** 黄金样本的服务费取值：属经营策略输入，与山西官方条款无关（服务费为市场调节价）。 */
const FEE_YUAN_PER_KWH = 0.45;

function calcDefault(): CalculationResult {
  const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH });
  const out = runCalculation(input);
  if (!out.ok) throw new Error(`默认情景计算失败：${out.reason} ${out.detail}`);
  return out;
}

const CACHED = calcDefault();

describe("端到端：默认山西重卡情景（光伏 + 储能 + 有序充电）", () => {
  it("一次完整计算在 1 秒内完成（35,040 步 × 9 个模型）", () => {
    const t0 = Date.now();
    calcDefault();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("计算成功，且携带完整的版本与可复算信息", () => {
    expect(CACHED.ok).toBe(true);
    expect(CACHED.calcRef).toBe(`calc@${ENGINE_VERSION}`);
    expect(CACHED.modelVersion).toBe("1.0.0");
    expect(CACHED.modelComposition).toBe(MODEL_COMPOSITION);
    expect(CACHED.modelComposition).toContain("truck@");
    expect(CACHED.modelComposition).toContain("economics@");
    expect(CACHED.benchmarkVersion).toBe(BENCHMARK_VERSION);
    expect(CACHED.timeStepMinutes).toBe(TIME_STEP_MINUTES);
    expect(CACHED.stepsPerYear).toBe(STEPS_PER_YEAR);
    expect(CACHED.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(CACHED.needsProfessionalReview).toBe(true);
  });

  it("能量平衡不变量通过（逐时段守恒），且独立于各模块自证", () => {
    expect(CACHED.invariant.ok).toBe(true);
    expect(CACHED.invariant.violationCount).toBe(0);
    expect(CACHED.invariant.maxAbsDeviationKwh).toBeLessThan(CACHED.invariant.toleranceKwh);
    expect(Math.abs(CACHED.invariant.annualDeviationKwh) / Math.max(1, CACHED.grid.annualImportKwh)).toBeLessThan(1e-9);
  });

  it("技术侧自洽：光伏锚定等效小时、需求被完整交付、SOC 不越界", () => {
    expect(CACHED.pv.annualGenerationKwh).toBeCloseTo(2000 * 1170, 2);
    expect(CACHED.charging.unservedEnergyKwh).toBe(0);
    expect(CACHED.bess.socViolations).toBe(0);
    expect(CACHED.charging.yearBoundarySpillKwh).toBeGreaterThan(0); // 年末切边如实登记
    expect(CACHED.charging.yearBoundarySpillKwh).toBeLessThan(CACHED.charging.annualGridSideKwh * 0.01);
  });

  it("电量口径闭合：逐月之和 = 年度合计（不得丢步或多算）", () => {
    expect(CACHED.pv.monthlyGenerationKwh.reduce((a, b) => a + b, 0)).toBeCloseTo(CACHED.pv.annualGenerationKwh, 2);
    expect(CACHED.charging.monthlyPeakLoadKw).toHaveLength(12);
    expect(CACHED.grid.monthlyPeakImportKw).toHaveLength(12);
    expect(CACHED.truckDemand.monthlyEnergyDemandKwh.reduce((a, b) => a + b, 0)).toBeCloseTo(
      CACHED.truckDemand.annualEnergyDemandKwh,
      0,
    );
  });

  it("交付量拆分守恒：充电交付 + 换电交付 = 总交付量", () => {
    expect(CACHED.charging.annualChargingDeliveredKwh + CACHED.charging.annualSwapDeliveredKwh).toBeCloseTo(
      CACHED.charging.annualDeliveredKwh,
      4,
    );
  });

  it("电网侧成本分解精确：总成本 = 电量电费 + 需量电费 − 上网收入", () => {
    expect(CACHED.grid.annualGridCostYuan).toBeCloseTo(
      CACHED.grid.annualEnergyCostYuan + CACHED.grid.annualDemandChargeYuan - CACHED.grid.annualExportRevenueYuan,
      2,
    );
    // 山西集中式充换电免征需量电费（已核实的官方条款）→ 本情景必须为 0
    expect(CACHED.grid.annualDemandChargeYuan).toBe(0);
  });

  it("经济指标可复算：NPV 必须能由留档现金流重新算出来", () => {
    const rate = CACHED.inputSnapshot.economics.discountRatePct / 100;
    expect(CACHED.economics.metrics.npvYuan).toBeCloseTo(npv(rate, CACHED.economics.annualCashFlowYuan), 2);
    expect(CACHED.economics.annualCashFlowYuan).toHaveLength(
      CACHED.inputSnapshot.economics.constructionYears + CACHED.inputSnapshot.economics.projectLifeYears,
    );
    expect(CACHED.economics.cumulativeCashFlowYuan).toHaveLength(CACHED.economics.annualCashFlowYuan.length);
  });

  it("全投资口径与资本金口径同时给出，且互不冒名", () => {
    expect(Number.isFinite(CACHED.economics.metrics.npvYuan)).toBe(true);
    expect(Number.isFinite(CACHED.economics.metrics.equity.npvYuan)).toBe(true);
    expect(CACHED.economics.metrics.equity.irr.ok).toBe(true);
    // 资本金口径只扣 30% 的期初，因此其 IRR 必须高于全投资 IRR（杠杆放大）
    expect(CACHED.economics.metrics.equity.irr.valuePct!).toBeGreaterThan(CACHED.economics.metrics.irr.valuePct!);
  });

  it("决策结论结构完整，且逐条判据都带说明", () => {
    const d = CACHED.decision;
    expect(d.feasibility.checks.length).toBeGreaterThanOrEqual(8);
    for (const c of d.feasibility.checks) expect(c.detail.length).toBeGreaterThan(5);
    expect(d.feasibility.feasible).toBe(true);
    expect(d.feasibility.blockers).toHaveLength(0);
    expect(d.recommendation.recommended).toBe(true);
    expect(d.keyDrivers.length).toBeGreaterThan(0);
    expect(d.sensitivity.length).toBeGreaterThan(3);
    expect(d.explanation.paragraphs.length).toBeGreaterThanOrEqual(5);
  });

  it("每条风险都带具体数值依据，不是「存在一定风险」这种空话", () => {
    expect(CACHED.decision.risks.length).toBeGreaterThan(0);
    for (const r of CACHED.decision.risks) {
      expect(r.basis.length).toBeGreaterThan(10);
      expect(r.mitigation.length).toBeGreaterThan(5);
      expect(/\d/.test(r.basis), `风险 ${r.id} 的依据里没有任何数值`).toBe(true);
    }
  });

  it("关键假设只包含真正影响本情景的项，且每条都回答「若不成立会怎样」", () => {
    expect(CACHED.decision.criticalAssumptions.length).toBeGreaterThan(0);
    for (const a of CACHED.decision.criticalAssumptions) {
      expect(a.impactIfWrong.length).toBeGreaterThan(10);
      expect(a.evidenceKind).not.toBe("FACT");
    }
    // 本情景没装换电 → 不该出现换电站单价的假设
    expect(CACHED.decision.criticalAssumptions.some((a) => a.key.includes("swapStation"))).toBe(false);
  });

  it("结论溯源链完整（输入 → 情景 → 引擎 → 基准 → 具体数值）", () => {
    const t = CACHED.decision.explanation.traceability;
    expect(t.engineVersion).toBe(ENGINE_VERSION);
    expect(t.benchmarkVersion).toBe(BENCHMARK_VERSION);
    expect(t.scenarioId).toBe("pv-bess-tou");
    expect(t.cited.length).toBeGreaterThan(5);
    for (const c of t.cited) expect(Number.isFinite(c.value)).toBe(true);
  });

  it("诊断按三类问题分列，且本次没有「引擎缺陷」类诊断", () => {
    expect(CACHED.diagnostics.some((d) => d.kind === "CALCULATION_ERROR")).toBe(false);
    for (const d of CACHED.diagnostics) expect(d.message.length).toBeGreaterThan(5);
    // 转供电价未约定 → 必须显式登记为假设
    expect(CACHED.diagnostics.some((d) => d.code === "resale_price_assumed_at_cost")).toBe(true);
  });

  it("冻结基线：关键指标回归（防静默漂移）", () => {
    // 这些数字是"当前模型 + 当前基准参数"的唯一答案；任何一处改动都必须在此处留下痕迹
    expect(CACHED.truckDemand.annualEnergyDemandKwh).toBeCloseTo(4_959_730.37, 0);
    expect(CACHED.truckDemand.annualEnergyAtBatteryKwh).toBeCloseTo(4_562_951.94, 0);
    expect(CACHED.charging.annualGridSideKwh).toBeCloseTo(4_959_954.68, 0);
    expect(CACHED.pv.annualGenerationKwh).toBeCloseTo(2_340_000, 0);
    expect(CACHED.grid.annualImportKwh).toBeCloseTo(4_946_067.79, 0);
    expect(CACHED.grid.annualExportKwh).toBeCloseTo(2_323_713.2, 0);
    expect(CACHED.economics.capex.netYuan).toBeCloseTo(12_669_000, 0);
    expect(CACHED.economics.metrics.npvYuan).toBeCloseTo(1_095_959.99, 0);
    expect(CACHED.economics.metrics.irr.valuePct).toBeCloseTo(7.702, 2);
    expect(CACHED.economics.metrics.simplePaybackYears).toBeCloseTo(7.07, 2);
  });

  it("跨层口径闭合：两层归集到「完整一年」后必须相等（年内口径才允许差异）", () => {
    // 需求层：年内需求 + 年末切边 = 完整一年需求
    const demandTotal =
      CACHED.truckDemand.annualEnergyDemandKwh + CACHED.truckDemand.yearBoundarySpillKwh;
    // 交付层：年内交付 + 年末切边 = 完整一年交付
    const deliveredTotal =
      CACHED.charging.annualGridSideKwh + CACHED.charging.yearBoundarySpillKwh;

    // 同一批需求、同一个自然年 → 完整一年口径下两层必须一致
    expect(deliveredTotal).toBeCloseTo(demandTotal, 0);

    // 年内口径：交付(年内) 必须 ≤ 完整一年需求（不可能交付超过总需求）
    expect(CACHED.charging.annualGridSideKwh).toBeLessThanOrEqual(demandTotal + 1e-6);
    // 且两层必须各有切边登记（否则说明有一层把跨年量悄悄吞了）
    expect(CACHED.truckDemand.yearBoundarySpillAtBatteryKwh).toBeGreaterThan(0);
    expect(CACHED.charging.yearBoundarySpillKwh).toBeGreaterThan(0);
  });

  it("资本金口径的现金流同样留档，可独立复算（不只是给出一个 IRR 数字）", () => {
    const eq = CACHED.economics.equityCashFlowYuan;
    expect(eq).toHaveLength(CACHED.economics.annualCashFlowYuan.length);
    const rate = CACHED.inputSnapshot.economics.discountRatePct / 100;
    expect(CACHED.economics.metrics.equity.npvYuan).toBeCloseTo(npv(rate, eq), 0);
    // 资本金口径每一年都应「不低于」全投资口径（少投了 30% 本金 → 少扣一笔钱）
    expect(eq[0]).toBeGreaterThan(CACHED.economics.annualCashFlowYuan[0]);
  });

  it("确定性：同一份输入两次计算逐字节一致（不读时钟、不读随机）", () => {
    const a = runCalculation(cachedInput());
    const b = runCalculation(cachedInput());
    expect(a.ok && b.ok).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(CACHED));
  });

  it("结果自带输入快照，可直接用于复算", () => {
    const replay = runCalculation(CACHED.inputSnapshot);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.inputHash).toBe(CACHED.inputHash);
  });
});

function cachedInput(): ScenarioInput {
  return CACHED.inputSnapshot;
}

describe("输入哈希的语义", () => {
  it("改展示名不改变哈希（改名不是改输入）", () => {
    const a = cachedInput();
    const b: ScenarioInput = { ...a, name: "换了个名字的情景" };
    expect(hashScenarioInput(b)).toBe(hashScenarioInput(a));
  });

  it("改任何参与计算的字段都改变哈希（否则复算校验形同虚设）", () => {
    const a = cachedInput();
    const base = hashScenarioInput(a);
    const variants: ScenarioInput[] = [
      { ...a, truck: { ...a.truck, truckCount: a.truck.truckCount + 1 } },
      { ...a, grid: { ...a.grid, flatPriceYuanPerKwh: a.grid.flatPriceYuanPerKwh + 0.01 } },
      { ...a, economics: { ...a.economics, chargingServiceFeeYuanPerKwh: a.economics.chargingServiceFeeYuanPerKwh + 0.01 } },
      { ...a, pv: { ...a.pv, capacityKwp: a.pv.capacityKwp + 1 } },
      { ...a, definition: { ...a.definition, components: ["GRID", "CHARGING"] } },
    ];
    for (const v of variants) expect(hashScenarioInput(v)).not.toBe(base);
  });

  it("组件顺序不同但集合相同 → 规整后定义一致，因此输入哈希稳定", () => {
    const d1 = { id: "t", label: "T", components: ["GRID", "CHARGING", "PV"] as const, managedCharging: false, intent: "" };
    const d2 = { id: "t", label: "T", components: ["PV", "CHARGING", "GRID"] as const, managedCharging: false, intent: "" };
    const a = buildScenarioInput({ name: "x", chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH, definition: { ...d1, components: [...d1.components] } });
    const b = buildScenarioInput({ name: "x", chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH, definition: { ...d2, components: [...d2.components] } });
    expect(a.input.definition.components).toEqual(b.input.definition.components);
    expect(hashScenarioInput(a.input)).toBe(hashScenarioInput(b.input));
  });
});

describe("失败的形状（不许静默、不许半成品）", () => {
  it("倒挂的充电窗口 → invalid_input，且给出可定位的字段", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH });
    const bad: ScenarioInput = { ...input, truck: { ...input.truck, chargingWindowStartHour: 10, chargingWindowEndHour: 6 } };
    const out = runCalculation(bad);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("invalid_input");
      expect(out.detail).toContain("充电窗口");
      expect(out.diagnostics.some((d) => d.field === "truck.chargingWindowEndHour")).toBe(true);
    }
  });

  it("服务费缺失（非数字）→ invalid_input（不拿 0 顶替后照常出结论）", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH });
    const bad = { ...input, economics: { ...input.economics, chargingServiceFeeYuanPerKwh: Number.NaN } };
    const out = runCalculation(bad);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("invalid_input");
  });

  it("负车队 / 负年限 / 零并网容量 都拦在最外层", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH });
    const bads: ScenarioInput[] = [
      { ...input, truck: { ...input.truck, truckCount: -1 } },
      { ...input, economics: { ...input.economics, projectLifeYears: 0 } },
      { ...input, grid: { ...input.grid, capacityKw: 0 } },
    ];
    for (const b of bads) {
      const out = runCalculation(b);
      expect(out.ok).toBe(false);
    }
  });

  it("校验器把「算不了」和「算得出来但不好看」分开：后者只出警告", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH });
    const v = validateScenarioInput({ ...input, truck: { ...input.truck, energyConsumptionKwhPerKm: 0 } });
    expect(v.fatal).toHaveLength(0);
    expect(v.warnings.some((w) => w.code === "zero_energy_consumption")).toBe(true);
    expect(runCalculation({ ...input, truck: { ...input.truck, energyConsumptionKwhPerKm: 0 } }).ok).toBe(true);
  });
});

describe("跨情景对比：同一引擎、同一路径", () => {
  it("六个模板都能算通，且纯电网情景的 NPV 高于「加了不产生价值的储能」的情景", () => {
    const results = SCENARIO_TEMPLATES.map((t) => {
      const { input } = buildScenarioFromTemplate(t.id, { chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH });
      const out = runCalculation(input);
      expect(out.ok, `${t.id} 计算失败`).toBe(true);
      return { id: t.id, out };
    });
    for (const r of results) {
      if (!r.out.ok) continue;
      expect(r.out.invariant.ok).toBe(true);
      expect(r.out.charging.unservedEnergyKwh).toBe(0);
    }
    const gridOnly = results.find((r) => r.id === "grid-only")!.out;
    const full = results.find((r) => r.id === "full")!.out;
    if (gridOnly.ok && full.ok) {
      // 两台"机器"必须给出不同的数（否则说明场景定义没真正生效）
      expect(gridOnly.economics.capex.netYuan).not.toBeCloseTo(full.economics.capex.netYuan, 0);
      expect(gridOnly.pv.annualGenerationKwh).toBe(0);
      expect(full.pv.annualGenerationKwh).toBeGreaterThan(0);
    }
  });

  it("场景定义真的改变了计算：去掉储能后 BESS 结果归零、且产能不降低", () => {
    const withBess = calcDefault();
    const tpl = getScenarioTemplate("pv-charging")!;
    const { input } = buildScenarioFromTemplate(tpl.id, { chargingServiceFeeYuanPerKwh: FEE_YUAN_PER_KWH });
    const out = runCalculation(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.bess.annualDischargeKwh).toBe(0);
    expect(withBess.bess.annualDischargeKwh).toBeGreaterThan(0);
    expect(out.charging.unservedEnergyKwh).toBe(0);
    expect(sumAll(out.charging.loadProfileKw)).toBeGreaterThan(0);
  });
});
