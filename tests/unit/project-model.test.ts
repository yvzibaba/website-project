/**
 * 沙盘经济编排黄金样本（R2.4）——用 R1.2 基线参数**逐项手算** CAPEX/OPEX/收入/购电/现金流/评价指标，
 * 并覆盖 §4 命脉（改滑块→NPV/回收期变）与 §20 诚实降级。纯函数、无 DB。
 */
import { describe, it, expect } from "vitest";
import {
  MODEL_VERSION,
  modelCalcRef,
  computeEconomics,
  runProjectModel,
  runProjectModelBaseline,
} from "@app/kernel/server/project-model";

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

  // V1.1 批次1.2 · 主情景 A（政策免征）：计费需量 = 充电装机总功率 × 需用系数 Kc；年需量费 = 计费需量 × 元/kW·月 × 12
  "region.demandCharge": 0, // 元/kW·月（2030 前集中式充换电免需量电费条款 → 主情景 0；B/C 场景在专块测 40/44/100%Kc）
  "project.demandKc": 70, // %（需用系数，占位假设；A 场景下不计费，仅参数存在）
  "project.chargerUtilization": 35, // %（MODEL 1.3.0 起 E 层不再消费——回归利用率本义，留在快照仅证明透传无害）

  // R9.0 Step 2 · storage-scoped SVE 键（hasStorage 时必填；值 = 参数目录默认）
  "region.peakValleySpread": 0.6,
  "tech.storagePeakLoadShare": 40,
  "tech.storageSocMin": 10,
  "tech.storageSocMax": 90,
  "tech.storageDegradation": 2.5,
  "tech.storageDischargeWindowHours": 2,
};

describe("project-model · 版本与 calcRef", () => {
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

  it("E3 收入：充电5,250,000×0.9=4,725,000 + 补贴×0.05=262,500 + Δ_sto=27,491（R9.0 SVE；首年无余电上网）", () => {
    if (!res.ok) return;
    expect(res.revenueY1.charging).toBe(4725000);
    expect(res.revenueY1.pvExport).toBe(0);
    expect(res.revenueY1.operationSubsidy).toBe(262500);
    expect(res.revenueY1.storageValue).toBe(27491);
    expect(res.revenueY1.gross).toBe(5014991);
  });

  it("E4 购电成本：下网5,093,106×0.7≈3,565,174；主情景 A 需量费=0（免征条款）；税前净=收入−电量电费−OPEX=1,113,517（回摆 R9.0 黄金·批次1.2 有意重录）", () => {
    if (!res.ok) return;
    expect(res.energyCostY1).toBe(3565174); // 电量电费口径不变（需量费单列，不并入 energyCostY1）
    expect(res.demandChargeY1).toBe(0); // A 场景：demandCharge=0 → 计费需量再大费用也恒 0（政策焊点）
    expect(res.netCashFlowY1PreTax).toBe(1113517);
  });

  it("E5–E8 现金流：长度=life+1，flows[0]=−净CAPEX，flows[1]含Δ_sto税后≈835,138（A 场景无需量费扣除）", () => {
    if (!res.ok) return;
    expect(res.annualCashFlow.length).toBe(NUMERIC["finance.projectLife"] + 1);
    expect(res.annualCashFlow[0]).toBe(-3524500);
    expect(res.annualCashFlow[1]).toBe(835138); // round(1,113,517×0.75)，含 Δ_sto、无需量费（回摆 R9.0 黄金）
    // 全名义通胀 → 后续年税后净额单调上升
    expect(res.annualCashFlow[2]).toBeGreaterThan(res.annualCashFlow[1]);
  });

  it("评价指标全程序算且数值合理：NPV>0 / IRR ok≈0.2435 / 回收期 / ROI≈4.09（批次1.2 主情景 A 回摆 R9.0 口径黄金）", () => {
    if (!res.ok) return;
    expect(res.metrics.npv).toBeGreaterThan(0);
    expect(res.metrics.npv).toBeCloseTo(4448573, -1); // demandCharge=0 数学期末与接入需量费**之前**的 R9.0 口径相等（政策焊点）
    expect(res.metrics.irr.ok).toBe(true);
    expect(res.metrics.irr.value).toBeCloseTo(0.2435, 4);
    expect(res.metrics.irr.signChanges).toBe(1);
    expect(res.metrics.simplePaybackYears).toBeCloseTo(4.1, 1);
    expect(res.metrics.discountedPaybackYears).toBeGreaterThan(res.metrics.simplePaybackYears!);
    expect(res.metrics.roi.ok).toBe(true);
    expect(res.metrics.roi.value).toBeGreaterThan(2);
  });

  it("盈亏平衡充电单价 = (电量电费+需量费(=0)+OPEX)÷充电量 ≈ 0.7431（成本覆盖口径，刻意不含 Δ_sto）", () => {
    if (!res.ok) return;
    expect(res.breakEvenChargingPriceY1).toBeCloseTo(0.7431, 3);
  });
});

describe("R9.0 Step2 · SVE 接线锚定（手算链 + 零 churn 焊点）", () => {
  /**
   * 手算链（与 Step 1.5 离线实验、Step 1 单测、storage-value.ts 三方对齐）：
   *   SOC 窗口 w=(90−10)/100=0.8 → 容量界 E·w=320 < 功率界 P·H=200×2=400 → e_cycle=320（energy binding）
   *   cycles = min(运营350, 寿命封顶6000/10=600) = 350 → D_max,1 = 320×350 = 112,000 kWh
   *   p_valley = p − spread/2 = 0.7−0.3 = 0.4 → margin = p − p_valley/η = 0.7−0.4/0.88 ≈ 0.245455 元/kWh
   *   消纳腿：PV 492,000 < 负荷 → Exp0=0 → M_pv=0（S1 互斥，诚实 0）
   *   Δ_sto,1 = 112,000 × 0.245455 ≈ 27,490.909 → storageValue 27,491
   */
  it("y1 手算链：D_max=112,000 × margin≈0.245455 → Δ_sto=27,491、gross=5,014,991", () => {
    const res = computeEconomics(NUMERIC);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.revenueY1.storageValue).toBe(27491);
    expect(res.revenueY1.gross).toBe(5014991);
  });

  it("★storage=0 零 churn 焊点：收入/CAPEX/OPEX 回到 R2.4 口径（SVE 从未被调用）；A 场景需量费恒 0（与储能无关）", () => {
    const noStorage = computeEconomics({ ...NUMERIC, "project.storageEnergy": 0 });
    expect(noStorage.ok).toBe(true);
    if (!noStorage.ok) return;
    expect(noStorage.revenueY1.storageValue).toBe(0);
    expect(noStorage.revenueY1.gross).toBe(4987500); // R2.4 老黄金（收入侧不含需量费，零 churn）
    expect(noStorage.capex.net).toBe(3030500); // 3,190,000×0.95（无储能 CAPEX）
    expect(noStorage.opexY1.gross).toBe(331500); // 7,500+0+24,000+300,000
    expect(noStorage.demandChargeY1).toBe(0); // A 场景：免征与储能无关地恒 0
    expect(noStorage.netCashFlowY1PreTax).toBe(1090826); // 4,987,500−3,565,174−331,500
    expect(noStorage.annualCashFlow[1]).toBe(818119); // round(1,090,826×0.75)（引擎实测·批次1.2 回摆：不再扣 483,840 需量费）
    expect(noStorage.metrics.npv).toBe(4797756); // 引擎实测（回摆 R9.0 无储能口径，原 1,315,764 系扣需量费所致）
  });

  it("★spread=0 ⟹ 套利关断 ⟹ storageValue=0，A 场景 NPV 回摆 R9.0 焊点 4,277,409（批次1.2 有意重录）", () => {
    const s0 = computeEconomics({ ...NUMERIC, "region.peakValleySpread": 0 });
    expect(s0.ok).toBe(true);
    if (!s0.ok) return;
    expect(s0.metrics.npv).toBe(4277409); // 接入需量费前（model 1.1.0/R9.0）同口径黄金逐字复现——demandCharge=0 数学期末相等的反证
    expect(s0.revenueY1.storageValue).toBe(0);
  });

  it("有储能却缺 SVE 键 → missing_econ_inputs 诚实列键；无储能缺同键 → 正常成功（scoping）", () => {
    const partial: Record<string, number> = { ...NUMERIC };
    delete partial["tech.storageSocMax"]; // 删掉一个 SVE 必需键模拟缺参
    const missing = computeEconomics(partial);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe("missing_econ_inputs");
    expect(missing.missingInputs).toContain("tech.storageSocMax");
    const noStorageOk = computeEconomics({
      ...partial,
      "project.storageEnergy": 0,
    });
    expect(noStorageOk.ok).toBe(true);
  });

  it("spread 阶梯：0 → 0.6 → 1.0 → 1.5，NPV 严格单调增（margin = p(1−1/η)+spread/2η）", () => {
    const npvAt = (spread: number) => {
      const r = computeEconomics({ ...NUMERIC, "region.peakValleySpread": spread });
      expect(r.ok).toBe(true);
      return r.ok ? r.metrics.npv : NaN;
    };
    expect(npvAt(0)).toBeLessThan(npvAt(0.6));
    expect(npvAt(0.6)).toBeLessThan(npvAt(1.0));
    expect(npvAt(1.0)).toBeLessThan(npvAt(1.5));
  });

  it("电价耦合（R9.0 新语义）：elecPrice↑ → 套利 margin↓（∂margin/∂p=1−1/η<0）→ storageValue 下降", () => {
    const hi = computeEconomics({ ...NUMERIC, "region.elecPrice": 1.2 });
    expect(hi.ok).toBe(true);
    if (!hi.ok) return;
    expect(hi.revenueY1.storageValue).toBeLessThan(27491);
  });

  it("FLIP 情景（spread=1.0 + 储能造价 0.6 元/Wh）→ 储能 NPV 转正贡献（对应 Step 1.5 实验 FLIP-A）", () => {
    const flip = computeEconomics({
      ...NUMERIC,
      "region.peakValleySpread": 1.0,
      "tech.storageCapex": 0.6,
    });
    const flipZero = computeEconomics({
      ...NUMERIC,
      "region.peakValleySpread": 1.0,
      "tech.storageCapex": 0.6,
      "project.storageEnergy": 0,
    });
    expect(flip.ok && flipZero.ok).toBe(true);
    if (!flip.ok || !flipZero.ok) return;
    expect(flip.metrics.npv).toBeGreaterThan(flipZero.metrics.npv); // +70,889（引擎实测）
  });
});

describe("V1.1 批次1.2 · 需量电价 A/B/C 三场景（计费需量=装机×Kc · A=主情景免征）", () => {
  /**
   * 口径（MODEL 1.3.0，创始人拍板）：billedDemandKw = derived.chargerTotalPower × demandKc/100；
   * demandChargeY1 = billedDemandKw × region.demandCharge(元/kW·月) × 12。A/B/C **零代码分支**，纯参数覆写：
   *   A 主情景：demandCharge=0（2030 前两部制集中式充换电免需量电费·52号文条款字面直传）
   *   B 对照：40(全国名义)/44(山西名义) 元/kW·月 × Kc=70%（2016 kW）
   *   C 压力：Kc=100% 报装/装机全额（不削峰最保守）
   * MODEL 1.5.0 起 E4 新增储能削峰抵扣（φ=tech.storagePeakShavePct%）；本组 B/C 的**绝对手算焊点刻意把 φ 钉为 0**
   * （储能抵扣关闭），使其仍是「计费需量 = 装机×Kc」公式的独立守卫、逐字节承袭 1.3.0/1.4.0 黄金；削峰腿本身由专块覆盖。
   */
  it("A 主情景：需量费恒 0，NPV 逐字回摆 R9.0（免征=数学期末相等·政策焊点）", () => {
    const a = computeEconomics(NUMERIC);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.demandChargeY1).toBe(0);
    expect(a.metrics.npv).toBe(4448573); // 与接入需量费前（model 1.1.0）黄金逐字相等
  });

  it("B 对照（全国名义 40）：2880×70%×40×12 = 967,680 元/年（手算=引擎双确认）", () => {
    const b = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": 0 });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.demandChargeY1).toBe(967680); // 2016 kW × 40 × 12
    expect(b.netCashFlowY1PreTax).toBe(145837); // 1,113,517 − 967,680
  });

  it("B 对照（山西名义 44）：2880×70%×44×12 = 1,064,448 元/年（引擎实测钉桩）", () => {
    const b = computeEconomics({ ...NUMERIC, "region.demandCharge": 44, "tech.storagePeakShavePct": 0 });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.demandChargeY1).toBe(1064448); // 2016 kW × 44 × 12（手算曾误记 1,063,411，以引擎+复算 2016×528 为准）
  });

  it("C 压力（Kc=100% 全额）：2880×100%×40×12 = 1,382,400 元/年；税前净转负如实反映", () => {
    const c = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "project.demandKc": 100, "tech.storagePeakShavePct": 0 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.demandChargeY1).toBe(1382400); // 2880 kW × 40 × 12（未削峰最保守）
    expect(c.netCashFlowY1PreTax).toBe(-268883); // 1,113,517 − 1,382,400 < 0，引擎不粉饰
  });

  it("场景排序恒 A > B > C（免征最优、全额最保守）+ B 内 demandKc 单调下降", () => {
    const npvOf = (o: Record<string, number>) => {
      const r = computeEconomics({ ...NUMERIC, "tech.storagePeakShavePct": 0, ...o });
      expect(r.ok).toBe(true);
      return r.ok ? r.metrics.npv : NaN;
    };
    const a = npvOf({});
    const b40 = npvOf({ "region.demandCharge": 40 });
    const b44 = npvOf({ "region.demandCharge": 44 });
    const c = npvOf({ "region.demandCharge": 40, "project.demandKc": 100 });
    expect(a).toBeGreaterThan(b40);
    expect(b40).toBeGreaterThan(b44); // 同 Kc 价高费多 NPV 更低
    expect(b44).toBeGreaterThan(c);
    // Kc 阶梯（B@40 下）：40% → 70% → 100% 费用单调升、NPV 单调降
    expect(npvOf({ "region.demandCharge": 40, "project.demandKc": 40 })).toBeGreaterThan(b40);
    expect(npvOf({ "region.demandCharge": 40, "project.demandKc": 90 })).toBeLessThan(b40);
  });

  it("★chargerUtilization 已退出 E 层计费（口径修正）：B@44 下利用率 5/35/90 三档 NPV 逐字相等", () => {
    const npvAt = (u: number) => {
      const r = computeEconomics({ ...NUMERIC, "region.demandCharge": 44, "project.chargerUtilization": u, "tech.storagePeakShavePct": 0 });
      expect(r.ok).toBe(true);
      return r.ok ? r.metrics.npv : NaN;
    };
    expect(npvAt(5)).toBe(npvAt(35));
    expect(npvAt(35)).toBe(npvAt(90));
    expect(npvAt(35)).toBe(-3211809); // = B@44 基准值：利用率绝不掺入计费需量（审计 P0-3 口径错位的反向守卫）
  });
});

describe("[0.84.0 · MODEL 1.5.0] · E4 储能削峰降需量（φ=tech.storagePeakShavePct · min(计费需量,储能功率×φ)）", () => {
  /**
   * 口径：毛计费需量 = 装机 2880 × Kc 70% = 2016 kW；有储能 且 demandCharge>0 时
   * 削峰量 = min(2016, storagePower×φ/100)，净计费需量 = 2016 − 削峰量，年需量费 = 净计费需量×价×12。
   * NUMERIC 的 storagePower=200。成本侧常量项（收入−电量电费−OPEX=1,113,517）在仅改 φ/demandCharge 时不变，
   * 故 demandChargeY1 与税前净均为纯算术可复核（宪法：程序算>LLM口算，此处为可手算复算的线性项）。
   */
  it("φ=50（缺键默认）@40：削峰 100 kW → 需量费 1916×40×12=919,680、税前净 193,837", () => {
    const r = computeEconomics({ ...NUMERIC, "region.demandCharge": 40 }); // NUMERIC 无 storagePeakShavePct 键 → 保守回退 50%
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.demandChargeY1).toBe(919680); // (2016 − min(2016, 200×0.5)) × 40 × 12
    expect(r.netCashFlowY1PreTax).toBe(193837); // 1,113,517 − 919,680
  });

  it("φ=50 相对 φ=0 严格降低需量费、抬高 NPV（削峰确有益，方向可判定）", () => {
    const shaved = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": 50 });
    const anchor = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": 0 });
    expect(shaved.ok && anchor.ok).toBe(true);
    if (!shaved.ok || !anchor.ok) return;
    expect(shaved.demandChargeY1).toBeLessThan(anchor.demandChargeY1); // 919,680 < 967,680
    expect(shaved.metrics.npv).toBeGreaterThan(anchor.metrics.npv); // 少交 48,000/年 → NPV 更高
  });

  it("φ=100 @40：满功率削减 200 kW → 1816×40×12=871,680", () => {
    const r = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.demandChargeY1).toBe(871680); // (2016 − 200) × 40 × 12
  });

  it("φ 越界钳制：φ=150 按 100 计、φ=−10 按 0 计（不产生负削减或超额削减）", () => {
    const hi = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": 150 });
    const lo = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": -10 });
    expect(hi.ok && lo.ok).toBe(true);
    if (!hi.ok || !lo.ok) return;
    expect(hi.demandChargeY1).toBe(871680); // 钳到 100% → 削 200 kW
    expect(lo.demandChargeY1).toBe(967680); // 钳到 0% → 无削减（= φ=0 锚点）
  });

  it("min() 上限：储能远大于计费需量时，削减量不超过毛计费需量（需量费不为负）", () => {
    const r = computeEconomics({
      ...NUMERIC,
      "region.demandCharge": 40,
      "project.storagePower": 3000,
      "project.storageEnergy": 6000,
      "tech.storagePeakShavePct": 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // min(2016, 3000) = 2016 → 净计费需量 0 → 需量费 0（不出现负值）
    expect(r.demandChargeY1).toBe(0);
  });

  it("hasStorage 门控：includeStorage=0 时无削峰抵扣（需量费回 2016×40×12=967,680）", () => {
    const r = computeEconomics({
      ...NUMERIC,
      "region.demandCharge": 40,
      "project.includeStorage": 0,
      "tech.storagePeakShavePct": 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.demandChargeY1).toBe(967680); // 关储能 → 无削峰 → 毛计费需量全额计
  });

  it("★主情景 A 零 churn 反证：免征下 φ 无论 0/50/100 需量费恒 0、NPV 逐字回摆 R9.0（政策焊点不受削峰影响）", () => {
    for (const phi of [0, 50, 100]) {
      const r = computeEconomics({ ...NUMERIC, "tech.storagePeakShavePct": phi }); // demandCharge=0（A）
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.demandChargeY1).toBe(0); // 抵扣量 ×0=0
      expect(r.metrics.npv).toBe(4448573); // 与接入需量费/削峰前逐字相等
    }
  });
});

describe("R3.5 一致性审计 · 套利/削峰分账 · 毛需量=0 边界 · 版本溯源（不改口径，仅钉守卫）", () => {
  /**
   * 本块不引入任何新计算，只把「R3 储能削峰」审计的三条结论固化成回归守卫：
   *   ① 套利腿（SVE，记在收入侧 revenueY1.storageValue）与削峰腿（φ，记在成本侧 demandChargeY1）
   *      分属两条不同的账 → φ 变动绝不改动收入侧，故**同一笔钱不被计两遍**（无 RMB 重复计价）。
   *   ② 但也正因分属两账，二者**不共享同一块电池的 SOC/能量预算** → 削峰量与套利吞吐彼此独立、
   *      互不扣减。这是沙盘口径的**已知偏乐观**（provisional），须待 S1 逐时调度（Path B）收口，
   *      本审计如实以「storageValue 对 φ 恒定不变」这一断言把该结构性事实钉死、不粉饰。
   *   ③ 毛计费需量=0（Kc=0 或装机=0）时，削减 min(0, ·)=0、净需量 max(0,0−0)=0 → 需量费恒 0 且**绝不为负**。
   */

  it("T1 套利腿(收入侧)与削峰腿(成本侧)分账：φ 0→100 只动 demandChargeY1，revenueY1.storageValue/gross 逐字不变", () => {
    const base = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": 0 });
    const full = computeEconomics({ ...NUMERIC, "region.demandCharge": 40, "tech.storagePeakShavePct": 100 });
    expect(base.ok && full.ok).toBe(true);
    if (!base.ok || !full.ok) return;
    // 成本侧：削峰确降需量费（967,680 → 871,680）
    expect(full.demandChargeY1).toBeLessThan(base.demandChargeY1);
    // 收入侧：套利腿 Δ_sto 与 φ 无关，逐字相等 → 削减的那块钱没有被重复计成收入（无 RMB 双计）
    expect(full.revenueY1.storageValue).toBe(base.revenueY1.storageValue);
    expect(full.revenueY1.gross).toBe(base.revenueY1.gross);
    // 二者都不为 0（确保这是「有储能套利 + 有需量削峰」的真实并存态，而非双双归零的假绿）
    expect(base.revenueY1.storageValue).toBeGreaterThan(0);
    // 结构性事实固化：正因两账不共享能量预算，削峰永不侵蚀套利吞吐 → 该沙盘口径偏乐观（待 S1 收口）
    expect(full.revenueY1.storageValue).toBe(27491); // = NUMERIC 基线 Δ_sto（SVE·与 demandCharge/φ 皆无关）
  });

  it("T2 毛计费需量=0 边界：Kc=0 或装机=0 → 需量费恒 0 且绝不为负（即便 φ=100、storagePower>demand）", () => {
    for (const override of [
      { "project.demandKc": 0 }, // 需用系数 0 → 毛需量 = 2880×0 = 0
      { "derived.chargerTotalPower": 0 }, // 装机 0 → 毛需量 = 0
    ]) {
      const r = computeEconomics({
        ...NUMERIC,
        "region.demandCharge": 40,
        "project.storagePower": 3000,
        "project.storageEnergy": 6000,
        "tech.storagePeakShavePct": 100,
        ...override,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.demandChargeY1).toBe(0); // min(0, 削减)=0、净需量≥0 → 不为负
      expect(r.demandChargeY1).toBeGreaterThanOrEqual(0);
    }
  });

  it("T3 版本溯源：calcRef 动态、engineVersions 恰 5 键、model 语义化且 ≥ 1.5.0 floor（不钉精确值）、Path-B 主干版本未被 R3 误升", () => {
    const r = computeEconomics({ ...NUMERIC, "region.demandCharge": 40 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // calcRef 由 modelCalcRef() 动态派生，非硬编码字面量
    expect(r.calcRef).toBe(modelCalcRef());
    // engineVersions 恰为这 5 个键，不多不少（防有人偷偷塞进 ENGINE_VERSION 或漏 storage 溯源）
    expect(Object.keys(r.engineVersions).sort()).toEqual(["finance", "model", "params", "storage", "tech"]);
    // model 版本语义化 + floor 单调不回退（改常量升版即绿，倒退才红——遵 MEMORY「勿钉精确值」纪律）
    expect(r.engineVersions.model).toMatch(/^\d+\.\d+\.\d+$/);
    const [maj, min, pat] = r.engineVersions.model.split(".").map(Number);
    expect(maj * 1_000_000 + min * 1_000 + pat).toBeGreaterThanOrEqual(1_005_000); // ≥ 1.5.0
    // R3 只动沙盘 E4/参数，绝不触碰 Path-B 引擎主干版本：finance 原语版本仍是 1.0.0（复用而非重造财务数学）
    expect(r.engineVersions.finance).toBe("1.0.0");
    // storage 溯源键存在且语义化（SVE 版本，仅元数据；削峰不冒充储能内核升版）
    expect(r.engineVersions.storage).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("V1.1 批次1.4 · includeStorage 真接线（F-2h：假开关转正·MODEL 1.4.0）", () => {
  /**
   * 编排层把布尔以 0/1 门控值注入经济快照副本（resolve 层「布尔不进 numeric」契约不变）；
   * computeEconomics 消费 `project.includeStorage !== 0`：置 0 → 储能 CAPEX/OPEX/SVE 套利整腿归零。
   * 向后兼容：纯函数直调**无该键** = 按目录默认（开）处理 → 既有黄金数值逐字节不变。
   */
  it("开关=关（runProjectModel 用户覆写）→ 逐字复现无储能焊点 NPV 4,797,756 + 储能三腿归零 + 诚实注记", () => {
    const off = runProjectModel({ user: { values: { "project.includeStorage": 0 } } });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.metrics.npv).toBe(4797756); // == 容量/功率物理置 0 的 R9.0 无储能焊点（开关真门控铁证）
    expect(off.capex.storage).toBe(0);
    expect(off.opexY1.storage).toBe(0);
    expect(off.revenueY1.storageValue).toBe(0);
    expect(off.notes.some((n) => n.includes("「是否配置储能」开关=关"))).toBe(true);
    // 容量/功率仍在（设备规格占位），却不再「关了照样算储能」
    expect(off.energyCostY1).toBeGreaterThan(0); // 充电负荷照算，只砍储能腿
  });

  it("computeEconomics 直调：门控键=0 → 与 storageEnergy=0 数值逐字相等（E 层门控本体）", () => {
    const off = computeEconomics({ ...NUMERIC, "project.includeStorage": 0 });
    const zero = computeEconomics({ ...NUMERIC, "project.storageEnergy": 0 });
    expect(off.ok && zero.ok).toBe(true);
    if (!off.ok || !zero.ok) return;
    expect(off.metrics.npv).toBe(zero.metrics.npv);
    expect(off.capex.storage).toBe(0);
    expect(off.revenueY1.storageValue).toBe(0);
  });

  it("★向后兼容：快照缺该键 = 目录默认（开）→ 基线黄金 4,448,573 逐字节不变；显式 1 亦然", () => {
    const noKey = computeEconomics(NUMERIC); // 历史纯函数调用方（批次1.4 前快照无此键）
    const on = computeEconomics({ ...NUMERIC, "project.includeStorage": 1 });
    expect(noKey.ok && on.ok).toBe(true);
    if (!noKey.ok || !on.ok) return;
    expect(noKey.metrics.npv).toBe(4448573); // 基线原值，零 churn
    expect(on.metrics.npv).toBe(4448573);
    expect(on.notes.some((n) => n.includes("开关=关"))).toBe(false);
  });

  it("布尔 false 覆写经编排层同样落 0（值语义 number|boolean 双兼容）", () => {
    const off = runProjectModel({
      user: { values: { "project.includeStorage": false as unknown as number } },
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.metrics.npv).toBe(4797756);
  });
});

describe("★§4 命脉：改滑块 → 经济结果整链重算", () => {
  const base = runProjectModelBaseline();
  it("调高综合充电单价 → 净现金流与 NPV 上升", () => {
    const bumped = runProjectModel({
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
    const costly = runProjectModel({ user: { values: { "region.elecPrice": 1.0 } } });
    expect(base.ok && costly.ok).toBe(true);
    if (!base.ok || !costly.ok) return;
    expect(costly.energyCostY1).toBeGreaterThan(base.energyCostY1);
    expect(costly.metrics.npv).toBeLessThan(base.metrics.npv);
  });

  it("光伏装机置 0 → 光伏 CAPEX/收入分量归 0（改上游参数→下游结构变）", () => {
    const noPv = runProjectModel({ user: { values: { "project.pvCapacity": 0 } } });
    expect(noPv.ok).toBe(true);
    if (!noPv.ok || !base.ok) return;
    expect(noPv.capex.pv).toBe(0);
    expect(noPv.revenueY1.charging).toBeGreaterThan(0); // 仍是充电站
    // 无光伏 → 全部下网 → 购电成本更高 → NPV 显著下降
    expect(noPv.metrics.npv).toBeLessThan(base.metrics.npv);
  });

  it("storagePower=0 → 按无储能降级（储能 CAPEX/OPEX 归 0，仍成功）", () => {
    const noStorage = runProjectModel({ user: { values: { "project.storagePower": 0 } } });
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
