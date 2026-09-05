/**
 * 技术能耗模型黄金样本（R2.1）——用 R1.2 默认参数（可手算）钉死能量流，并覆盖 §20 诚实降级路径。
 * 纯函数、无 DB、确定性。
 */
import { describe, it, expect } from "vitest";
import {
  TECH_VERSION,
  techCalcRef,
  TECH_METHODOLOGY,
  TRANSPARENT_SIMPLIFICATIONS,
  pvAnnualEnergyYear1,
  pvDegradedAnnualEnergy,
  annualChargeEnergyDelivered,
  acLoadFromDelivered,
  annualEnergyBalance,
  storageAnnualThroughput,
  computeTechModel,
} from "../../src/server/sandbox-tech";

/** R1.2 基线数值快照（与 sandbox-params 默认一致，用于聚合入口手算）。 */
const BASELINE: Record<string, number> = {
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
};

describe("sandbox-tech · 版本/方法论/透明度声明", () => {
  it("版本语义化、calcRef 携带版本", () => {
    expect(TECH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(techCalcRef()).toBe(`tech@${TECH_VERSION}`);
  });
  it("简化清单非空且每条可读（对外明示「这是简化」）", () => {
    expect(Array.isArray(TRANSPARENT_SIMPLIFICATIONS)).toBe(true);
    expect(TRANSPARENT_SIMPLIFICATIONS.length).toBeGreaterThanOrEqual(4);
    expect(TECH_METHODOLOGY).toContain("简化");
  });
});

describe("pvAnnualEnergyYear1 · S2 首年光伏量", () => {
  it("手算：500kWp × 1200h × 0.82 = 492000 kWh", () => {
    expect(pvAnnualEnergyYear1({ pvCapacityKwP: 500, equivalentHours: 1200, performanceRatio: 0.82 })).toBeCloseTo(492000, 6);
  });
  it("装机 0 → 出力 0", () => {
    expect(pvAnnualEnergyYear1({ pvCapacityKwP: 0, equivalentHours: 1200, performanceRatio: 0.82 })).toBe(0);
  });
});

describe("pvDegradedAnnualEnergy · S2 逐年衰减", () => {
  it("第 1 年 = 首年（不衰减）", () => {
    expect(pvDegradedAnnualEnergy(492000, 0.5, 1)).toBeCloseTo(492000, 6);
  });
  it("第 2 年 = 首年×(1-0.5%)", () => {
    expect(pvDegradedAnnualEnergy(492000, 0.5, 2)).toBeCloseTo(492000 * 0.995, 6);
  });
  it("年序<1 或非有限 → NaN（诚实）", () => {
    expect(Number.isNaN(pvDegradedAnnualEnergy(492000, 0.5, 0))).toBe(true);
    expect(Number.isNaN(pvDegradedAnnualEnergy(NaN, 0.5, 3))).toBe(true);
  });
});

describe("充电负荷 · S3", () => {
  it("年电池侧电量：15000×350 = 5,250,000 kWh", () => {
    expect(annualChargeEnergyDelivered({ dailyChargeEnergyKwh: 15000, operatingDays: 350 })).toBeCloseTo(5250000, 6);
  });
  it("交流负荷 = 电池侧÷效率：5,250,000/0.94 ≈ 5,585,106.38", () => {
    expect(acLoadFromDelivered(5250000, 94)).toBeCloseTo(5585106.3829787, 3);
  });
  it("除零：eff≤0 → NaN（不诈算负荷）", () => {
    expect(Number.isNaN(acLoadFromDelivered(5250000, 0))).toBe(true);
    expect(Number.isNaN(acLoadFromDelivered(5250000, -5))).toBe(true);
  });
});

describe("annualEnergyBalance · S1 年度平衡", () => {
  it("光伏 < 负荷：全自用 + 下网补差，无上网", () => {
    const r = annualEnergyBalance({ pvEnergyKwh: 492000, acLoadKwh: 5585106.38 })!;
    expect(r.selfConsumedKwh).toBeCloseTo(492000, 6);
    expect(r.pvExportKwh).toBe(0);
    expect(r.gridImportKwh).toBeCloseTo(5585106.38 - 492000, 4);
    expect(r.pvSelfConsumptionRate).toBeCloseTo(1, 6);
    expect(r.renewableFraction).toBeCloseTo(492000 / 5585106.38, 6);
  });
  it("光伏 > 负荷：满自用 + 余电上网，无下网", () => {
    const r = annualEnergyBalance({ pvEnergyKwh: 1000000, acLoadKwh: 400000 })!;
    expect(r.selfConsumedKwh).toBeCloseTo(400000, 6);
    expect(r.pvExportKwh).toBeCloseTo(600000, 6);
    expect(r.gridImportKwh).toBe(0);
    expect(r.pvSelfConsumptionRate).toBeCloseTo(0.4, 6);
    expect(r.renewableFraction).toBeCloseTo(1, 6);
  });
  it("除零安全：pv=0 或 load=0 相关比率记 0", () => {
    expect(annualEnergyBalance({ pvEnergyKwh: 0, acLoadKwh: 100 })!.pvSelfConsumptionRate).toBe(0);
    expect(annualEnergyBalance({ pvEnergyKwh: 100, acLoadKwh: 0 })!.renewableFraction).toBe(0);
  });
  it("非有限 → null", () => {
    expect(annualEnergyBalance({ pvEnergyKwh: NaN, acLoadKwh: 100 })).toBeNull();
  });
});

describe("storageAnnualThroughput · S4 储能吞吐上界", () => {
  it("手算：容量400×RTE88%×年循环min(350,6000/10=600)=350 → 年放电 123,200 kWh", () => {
    const r = storageAnnualThroughput({
      storageEnergyKwh: 400,
      chargerOrRtePct: 88,
      operatingDays: 350,
      cycleLife: 6000,
      calendarLifeYears: 10,
    })!;
    expect(r.annualCycles).toBe(350);
    expect(r.annualDischargeThroughputKwh).toBe(123200); // 400*0.88*350
  });
  it("寿命折算更紧时封顶年循环：cycleLife=1000,cal=10→100<350", () => {
    const r = storageAnnualThroughput({
      storageEnergyKwh: 400,
      chargerOrRtePct: 88,
      operatingDays: 350,
      cycleLife: 1000,
      calendarLifeYears: 10,
    })!;
    expect(r.annualCycles).toBe(100);
  });
  it("未配/非法（容量≤0 或效率≤0）→ null", () => {
    expect(storageAnnualThroughput({ storageEnergyKwh: 0, chargerOrRtePct: 88, operatingDays: 350, cycleLife: 6000, calendarLifeYears: 10 })).toBeNull();
    expect(storageAnnualThroughput({ storageEnergyKwh: 400, chargerOrRtePct: 0, operatingDays: 350, cycleLife: 6000, calendarLifeYears: 10 })).toBeNull();
  });
});

describe("computeTechModel · 聚合入口（R1.2 基线手算全链）", () => {
  it("基线成功：首年能量流符合逐项手算", () => {
    const res = computeTechModel(BASELINE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.firstYear.pvEnergyY1Kwh).toBe(492000);
    expect(res.firstYear.chargeEnergyDeliveredY1Kwh).toBe(5250000);
    expect(res.firstYear.acLoadY1Kwh).toBe(5585106);
    expect(res.firstYear.chargingLossY1Kwh).toBe(335106);
    expect(res.firstYear.selfConsumedY1Kwh).toBe(492000);
    expect(res.firstYear.pvExportY1Kwh).toBe(0);
    expect(res.firstYear.gridImportY1Kwh).toBe(5093106);
    expect(res.firstYear.pvSelfConsumptionRatePct).toBe(100);
    expect(res.firstYear.renewableFractionPct).toBe(8.8);
    expect(res.needsProfessionalReview).toBe(true);
    expect(res.storageIncluded).toBe(true);
    expect(res.storage?.annualDischargeThroughputKwh).toBe(123200);
    expect(res.calcRef).toBe(techCalcRef());
    expect(res.methodology).toBe(TECH_METHODOLOGY);
  });

  it("★§4 命脉实证：改上游桩均电量→日充电量→负荷与下网全部重算", () => {
    const base = computeTechModel(BASELINE);
    const bumped = computeTechModel({ ...BASELINE, "derived.dailyChargeEnergy": 30000 }); // 翻倍
    expect(base.ok && bumped.ok).toBe(true);
    if (!base.ok || !bumped.ok) return;
    // 负荷随充电量翻倍（效率不变）
    expect(bumped.firstYear.acLoadY1Kwh).toBeGreaterThan(base.firstYear.acLoadY1Kwh);
    expect(bumped.firstYear.chargeEnergyDeliveredY1Kwh).toBe(2 * base.firstYear.chargeEnergyDeliveredY1Kwh);
    // 光伏不变 → 自用率(相对光伏)被负荷变化影响：负荷更大时光伏全自用仍成立，可再生渗透率下降
    expect(bumped.firstYear.renewableFractionPct).toBeLessThan(base.firstYear.renewableFractionPct);
  });

  it("改光伏装机→出力与上网联动（另一侧的 §4 实证）", () => {
    const big = computeTechModel({ ...BASELINE, "project.pvCapacity": 5000 });
    expect(big.ok).toBe(true);
    if (!big.ok) return;
    // 5000kWp → 年发电 4,920,000 > 负荷 5,585,106? 仍略小 → 无上网但下网大降、渗透率升
    expect(big.firstYear.pvEnergyY1Kwh).toBe(4920000);
    expect(big.firstYear.gridImportY1Kwh).toBeLessThan(5093106);
    expect(big.firstYear.renewableFractionPct).toBeGreaterThan(8.8);
  });

  it("诚实缺参：缺任一必备键 → missing_inputs 且列出键名，绝不猜默认", () => {
    const rest = { ...BASELINE };
    delete rest["region.pvEquivalentHours"];
    const res = computeTechModel(rest);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("missing_inputs");
    expect(res.missingInputs).toContain("region.pvEquivalentHours");
  });

  it("诚实非法：必备键含非有限 → invalid_inputs", () => {
    const res = computeTechModel({ ...BASELINE, "tech.chargerEfficiency": NaN });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("invalid_inputs");
    expect(res.invalidInputs).toContain("tech.chargerEfficiency");
  });

  it("储能降级：storagePower=0 → 仍成功但 storageIncluded=false、吞吐 null", () => {
    const res = computeTechModel({ ...BASELINE, "project.storagePower": 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.storageIncluded).toBe(false);
    expect(res.storage).toBeNull();
    expect(res.notes.join(" ")).toContain("储能");
  });

  it("除零不诈算：chargerEfficiency=0 → invalid_inputs（关键负荷无定义）", () => {
    const res = computeTechModel({ ...BASELINE, "tech.chargerEfficiency": 0 });
    expect(res.ok).toBe(false);
  });

  it("确定性：同快照两次输出完全相等（无时钟/随机/IO）", () => {
    expect(computeTechModel(BASELINE)).toEqual(computeTechModel(BASELINE));
  });
});
