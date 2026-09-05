/**
 * 沙盘经济编排黄金样本（R2.4）——用 R1.2 基线参数**逐项手算** CAPEX/OPEX/收入/购电/现金流/评价指标，
 * 并覆盖 §4 命脉（改滑块→NPV/回收期变）与 §20 诚实降级。纯函数、无 DB。
 */
import { describe, it, expect } from "vitest";
import {
  MODEL_VERSION,
  modelCalcRef,
  computeEconomics,
  runSandboxModel,
  runSandboxModelBaseline,
} from "../../src/server/sandbox-model";

/** 与 R1.2 默认一致的全量数值快照（能量键 + 经济键），供 computeEconomics 直测。 */
const NUMERIC: Record<string, number> = {
  "project.pvCapacity": 500,
  "region.pvEquivalentHours": 1200,
  "tech.pvPerformanceRatio": 0.82,
  "tech.pvDegradation": 0.5,
  "derived.dailyChargeEnergy": 15000,
  "project.operatingDays": 350,
  "tech.chargerEfficiency": 94,
  "project.storagePower": 200,
  "project.storageEnergy": 400,
  "tech.storageRoundTripEff": 88,
  "tech.storageCycleLife": 6000,
  "tech.storageCalendarLife": 10,
  // 经济
  "tech.pvCapex": 3.5,
  "tech.storageCapex": 1.3,
  "tech.chargerCapex": 500,
  "project.chargerCount": 8,
  "derived.chargerTotalPower": 2880,
  "policy.constructionSubsidy": 5,
  "tech.pvOm": 15,
  "tech.storageOm": 12,
  "tech.chargerOm": 3000,
  "tech.depotFixedOpex": 300000,
  "project.chargingPrice": 0.9,
  "policy.feedInTariff": 0.35,
  "policy.operationSubsidy": 0.05,
  "region.elecPrice": 0.7,
  "finance.discountRate": 8,
  "finance.projectLife": 15,
  "finance.inflation": 2,
  "finance.taxRate": 25,
  "finance.residualValue": 5,
};

describe("sandbox-model · 版本与 calcRef", () => {
  it("版本语义化、calcRef 携带版本", () => {
    expect(MODEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(modelCalcRef()).toBe(`model@${MODEL_VERSION}`);
  });
});

describe("computeEconomics · CAPEX/OPEX/收入 逐项手算（基线）", () => {
  const res = computeEconomics(NUMERIC);
  it("基线成功 + needsProfessionalReview + 方法论", () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.needsProfessionalReview).toBe(true);
    expect(res.calcRef).toBe(modelCalcRef());
    expect(res.methodology).toContain("程序计算");
    expect(res.engineVersions.finance).toBe("1.0.0");
  });

  it("E1 CAPEX：光伏500×1000×3.5=1,750,000 + 储能400×1000×1.3=520,000 + 桩2880×500=1,440,000", () => {
    if (!res.ok) return;
    expect(res.capex.pv).toBe(1750000);
    expect(res.capex.storage).toBe(520000);
    expect(res.capex.charger).toBe(1440000);
    expect(res.capex.gross).toBe(3710000);
    expect(res.capex.constructionSubsidy).toBe(185500); // 5%
    expect(res.capex.net).toBe(3524500);
  });

  it("E2 OPEX：7500+4800+24000+300000=336,300", () => {
    if (!res.ok) return;
    expect(res.opexY1.pv).toBe(7500);
    expect(res.opexY1.storage).toBe(4800);
    expect(res.opexY1.charger).toBe(24000);
    expect(res.opexY1.depotFixed).toBe(300000);
    expect(res.opexY1.gross).toBe(336300);
  });

  it("E3 收入：充电5,250,000×0.9=4,725,000 + 补贴×0.05=262,500（首年无余电上网）", () => {
    if (!res.ok) return;
    expect(res.revenueY1.charging).toBe(4725000);
    expect(res.revenueY1.pvExport).toBe(0);
    expect(res.revenueY1.operationSubsidy).toBe(262500);
    expect(res.revenueY1.gross).toBe(4987500);
  });

  it("E4 购电成本：下网5,093,106×0.7≈3,565,174；税前净=收入−购电−OPEX≈1,086,026", () => {
    if (!res.ok) return;
    expect(res.energyCostY1).toBe(3565174);
    expect(res.netCashFlowY1PreTax).toBe(1086026);
  });

  it("E5–E8 现金流：长度=life+1，flows[0]=−净CAPEX，flows[1]=税前净×(1−25%)", () => {
    if (!res.ok) return;
    expect(res.annualCashFlow.length).toBe(NUMERIC["finance.projectLife"] + 1);
    expect(res.annualCashFlow[0]).toBe(-3524500);
    expect(res.annualCashFlow[1]).toBe(814519); // round(1,086,025.8×0.75)
    // 全名义通胀 → 后续年税后净额单调上升
    expect(res.annualCashFlow[2]).toBeGreaterThan(res.annualCashFlow[1]);
  });

  it("评价指标全程序算且数值合理：NPV>0 / IRR ok≈0.2376 / 回收期 / ROI≈4.0", () => {
    if (!res.ok) return;
    expect(res.metrics.npv).toBeGreaterThan(0);
    expect(res.metrics.npv).toBeCloseTo(4277409, -1); // 容差到十位
    expect(res.metrics.irr.ok).toBe(true);
    expect(res.metrics.irr.value).toBeCloseTo(0.2376, 3);
    expect(res.metrics.irr.signChanges).toBe(1);
    expect(res.metrics.simplePaybackYears).toBeCloseTo(4.2, 1);
    expect(res.metrics.discountedPaybackYears).toBeGreaterThan(res.metrics.simplePaybackYears!);
    expect(res.metrics.roi.ok).toBe(true);
    expect(res.metrics.roi.value).toBeGreaterThan(3);
  });

  it("盈亏平衡充电单价 = (购电+OPEX)÷充电量 ≈ 0.7431", () => {
    if (!res.ok) return;
    expect(res.breakEvenChargingPriceY1).toBeCloseTo(0.7431, 3);
  });
});

describe("★§4 命脉：改滑块 → 经济结果整链重算", () => {
  const base = runSandboxModelBaseline();
  it("调高综合充电单价 → 净现金流与 NPV 上升", () => {
    const bumped = runSandboxModel({
      user: { values: { "project.chargingPrice": 1.2 } },
    });
    expect(base.ok && bumped.ok).toBe(true);
    if (!base.ok || !bumped.ok) return;
    expect(bumped.metrics.npv).toBeGreaterThan(base.metrics.npv);
    expect(bumped.annualCashFlow[1]).toBeGreaterThan(base.annualCashFlow[1]);
    // IRR 亦随之升高
    expect(bumped.metrics.irr.value!).toBeGreaterThan(base.metrics.irr.value!);
  });

  it("调高工商业电价 → 购电成本上升 → NPV 下降（同一下游对成本的反应）", () => {
    const costly = runSandboxModel({ user: { values: { "region.elecPrice": 1.0 } } });
    expect(base.ok && costly.ok).toBe(true);
    if (!base.ok || !costly.ok) return;
    expect(costly.energyCostY1).toBeGreaterThan(base.energyCostY1);
    expect(costly.metrics.npv).toBeLessThan(base.metrics.npv);
  });

  it("光伏装机置 0 → 光伏 CAPEX/收入分量归 0（改上游参数→下游结构变）", () => {
    const noPv = runSandboxModel({ user: { values: { "project.pvCapacity": 0 } } });
    expect(noPv.ok).toBe(true);
    if (!noPv.ok || !base.ok) return;
    expect(noPv.capex.pv).toBe(0);
    expect(noPv.revenueY1.charging).toBeGreaterThan(0); // 仍是充电站
    // 无光伏 → 全部下网 → 购电成本更高 → NPV 显著下降
    expect(noPv.metrics.npv).toBeLessThan(base.metrics.npv);
  });

  it("storagePower=0 → 按无储能降级（储能 CAPEX/OPEX 归 0，仍成功）", () => {
    const noStorage = runSandboxModel({ user: { values: { "project.storagePower": 0 } } });
    expect(noStorage.ok).toBe(true);
    if (!noStorage.ok) return;
    expect(noStorage.capex.storage).toBe(0);
    expect(noStorage.opexY1.storage).toBe(0);
  });
});

describe("诚实降级（第 20 条）", () => {
  it("缺经济参数 → missing_econ_inputs 且列出键（绝不猜默认收益）", () => {
    const missing = { ...NUMERIC };
    delete missing["project.chargingPrice"];
    const res = computeEconomics(missing);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("missing_econ_inputs");
    expect(res.missingInputs).toContain("project.chargingPrice");
  });

  it("经济参数含非有限 → invalid_econ_inputs", () => {
    const res = computeEconomics({ ...NUMERIC, "finance.discountRate": NaN });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid_econ_inputs");
    expect(res.invalidInputs).toContain("finance.discountRate");
  });

  it("技术层缺键先行拦截 → tech_error（经济层不掩盖技术缺口）", () => {
    const broken = { ...NUMERIC };
    delete broken["region.pvEquivalentHours"];
    const res = computeEconomics(broken);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("tech_error");
  });

  it("极端：充电单价低于盈亏平衡 → NPV 转负（引擎如实反映亏损，不粉饰）", () => {
    const res = computeEconomics({ ...NUMERIC, "project.chargingPrice": 0.5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.breakEvenChargingPriceY1!).toBeGreaterThan(0.5);
    expect(res.metrics.npv).toBeLessThan(0);
  });
});

describe("确定性", () => {
  it("同参数两次运行输出深相等（无时钟/随机/IO）", () => {
    expect(computeEconomics(NUMERIC)).toEqual(computeEconomics(NUMERIC));
  });
});
