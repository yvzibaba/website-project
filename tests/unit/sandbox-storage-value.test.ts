/**
 * R9.0 Step 1 · Storage Value Engine 纯函数单元测试。
 *
 * 被测：src/server/sandbox-storage-value.ts（独立实验模块，未接入经济层）。
 * 覆盖（创始人 Step 1 指令 §12）：正常 / 边界 / 零值 / 极端值 / 功率瓶颈 / 容量瓶颈 / 效率 /
 * SOC / 衰减 / 寿命 / 低价差 / 高价差 / 无光伏富余 / 无下网电 / 储能为 0，
 * 以及 NaN / Infinity / 负能量 / 超容量 / 超功率 / 非法 SOC / 非法效率 / 极端 spread / 极端容量。
 * 三条 Energy Flow Ledger 不变量（指令 §3）：
 *   I1  M_arb + M_pv ≤ D_max
 *   I2  M_pv/η ≤ Exp0，且 (M_pv/η) + 上网剩余 ≡ Exp0（同一度光伏不既上网又消纳）
 *   I3  与"扁平 E4"反事实的成本差 ≡ Δ_arb + Δ_pv（套利腿不重复抵扣 E4 购电量；
 *       p − p_valley/η 口径已经 ISSUE-1 裁决采纳（选 A），设计稿 §4.4 已同步修订）
 * 边际价值（指令 §10/第一批指令 §10）：测试内独立辅助计算，不接生产经济模型；
 *   分类器允许 A(内部最优)/B(范围内持续上升)/C(范围内持续下降) 三种结果，不预设 argmax 必然存在。
 *
 * 创始人裁决落档（2026-09-08，Step 1 正式收口，详见模块尾「裁决记录」与设计稿 §十六·五）：
 *   ISSUE-1 选 A —— 套利增量 = M_arb·(p − p_valley/η)，不使用 p_peak（防与扁平 E4 重复计价）；
 *   ISSUE-2 批准 margin 优先分配（两腿线性单位价值 + 共享有限 D_max ⇒ 贪心即最优）；
 *   ISSUE-3 不预设"必然存在 argmax"——边际价值测试按 A/B/C 三态如实分类断言，今后亦不得
 *     断言"必然存在内部最优容量"；
 *   ISSUE-4 保留 σ 年度代理口径（σ 不是逐时真实峰时电量，ASSUMPTION · needsProfessionalReview=true）。
 */
import { describe, expect, it } from "vitest";
import {
  energyFlowLedger,
  storageThroughputCapped,
  storageValueDelta,
  type EnergyFlowLedgerInput,
  type StorageThroughputInput,
  type StorageValueYearInput,
} from "@/server/sandbox-storage-value";

/* ─────────────────────────── 公共夹具与工具 ─────────────────────────── */

/** 相对容差比较（1e-6 相对 + 1e-9 绝对），浮点安全。 */
function close(a: number, b: number, relEps = 1e-6): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(1e-9, relEps * scale);
}
function expectClose(a: number, b: number, relEps = 1e-6): void {
  expect(close(a, b, relEps)).toBe(true);
}

/** 吞吐基线：E=400kWh / P=200kW / SOC 10–90 / H=2h / 350 天 / 6000 次·10 年 / δ=2.5%/年 / 第 1 年。 */
const TP_BASE: StorageThroughputInput = {
  storageEnergyKwh: 400,
  storagePowerKw: 200,
  socMinPct: 10,
  socMaxPct: 90,
  dischargeWindowHours: 2,
  operatingDays: 350,
  cycleLife: 6000,
  calendarLifeYears: 10,
  degradationPctPerYear: 2.5,
  yearIndex: 1,
};
/** 吞吐基线手算：w=0.8 → 容量界 320（能量封顶），功率界 400；年循环=min(350, 600)=350；D_max=112,000 kWh。 */

/** 账本基线：η=0.88 / Exp0=30 万 / Imp0=200 万 / σ=0.4 / p=0.7 / spread=0.6 / feedIn=0.35。 */
const LG_BASE: Omit<EnergyFlowLedgerInput, "dMaxKwh"> = {
  etaFraction: 0.88,
  pvSurplusKwh: 300_000,
  gridImportKwh: 2_000_000,
  peakLoadShareFraction: 0.4,
  elecPriceYuanPerKwh: 0.7,
  spreadYuanPerKwh: 0.6,
  feedInYuanPerKwh: 0.35,
};
const lg = (over: Partial<EnergyFlowLedgerInput> = {}): EnergyFlowLedgerInput => ({
  dMaxKwh: 112_000,
  ...LG_BASE,
  ...over,
});

/** 编排基线 = 吞吐基线 + 账本基线。 */
const YEAR_BASE: StorageValueYearInput = { ...TP_BASE, ...LG_BASE };

/* ─────────────────────────── A. storageThroughputCapped ─────────────────────────── */

describe("storageThroughputCapped · 功率与容量双封顶", () => {
  it("能量封顶：容量界 < 功率界 → binding=energy", () => {
    const r = storageThroughputCapped(TP_BASE); // 320 < 400
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding).toBe("energy");
    expectClose(r.energyBoundPerCycleKwh, 320);
    expectClose(r.powerBoundPerCycleKwh, 400);
    expectClose(r.perCycleDischargeKwh, 320);
  });

  it("功率封顶：功率界 < 容量界 → binding=power（不能只看容量）", () => {
    const r = storageThroughputCapped({ ...TP_BASE, storagePowerKw: 100 }); // 200 < 320
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding).toBe("power");
    expectClose(r.perCycleDischargeKwh, 200);
    expectClose(r.dMaxKwh, 200 * 350);
  });

  it("两者相等 → binding=balanced（SOC 全窗使 400=400）", () => {
    const r = storageThroughputCapped({ ...TP_BASE, socMinPct: 0, socMaxPct: 100 }); // 400 = 400
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding).toBe("balanced");
    expectClose(r.perCycleDischargeKwh, 400);
  });
});

describe("storageThroughputCapped · SOC 窗口", () => {
  it("正常窗口 w=(max−min)/100", () => {
    const r = storageThroughputCapped(TP_BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.socWindowFraction, 0.8);
    expectClose(r.energyBoundPerCycleKwh, 400 * 0.8);
  });

  it("全窗 0–100 → w=1；窄窗 40–60 → w=0.2", () => {
    const full = storageThroughputCapped({ ...TP_BASE, socMinPct: 0, socMaxPct: 100 });
    const narrow = storageThroughputCapped({ ...TP_BASE, socMinPct: 40, socMaxPct: 60 });
    if (!full.ok || !narrow.ok) throw new Error("应成功");
    expectClose(full.socWindowFraction, 1);
    expectClose(narrow.socWindowFraction, 0.2);
    expectClose(narrow.perCycleDischargeKwh, 80);
  });

  it("异常 SOC 一律拒绝：min<0 / max>100 / min=max / min>max / NaN", () => {
    for (const bad of [
      { socMinPct: -1, socMaxPct: 90 },
      { socMinPct: 10, socMaxPct: 101 },
      { socMinPct: 50, socMaxPct: 50 },
      { socMinPct: 60, socMaxPct: 40 },
      { socMinPct: NaN, socMaxPct: 90 },
      { socMinPct: 10, socMaxPct: Infinity },
    ]) {
      const r = storageThroughputCapped({ ...TP_BASE, ...bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_soc");
    }
  });
});

describe("storageThroughputCapped · 衰减", () => {
  it("D_max 随年份不增（严格递减，δ=2.5）", () => {
    let prev = Infinity;
    for (let y = 1; y <= 15; y++) {
      const r = storageThroughputCapped({ ...TP_BASE, yearIndex: y });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expectClose(r.capacityFadeFactor, (1 - 2.5 / 100) ** (y - 1));
      expect(r.dMaxKwh).toBeLessThanOrEqual(prev + 1e-9);
      expect(r.dMaxKwh).toBeLessThan(prev); // 严格递减
      prev = r.dMaxKwh;
    }
  });

  it("δ=0 时逐年不衰减（D_max 恒定）", () => {
    const y1 = storageThroughputCapped({ ...TP_BASE, degradationPctPerYear: 0, yearIndex: 1 });
    const y10 = storageThroughputCapped({ ...TP_BASE, degradationPctPerYear: 0, yearIndex: 10 });
    if (!y1.ok || !y10.ok) throw new Error("应成功");
    expectClose(y1.dMaxKwh, y10.dMaxKwh);
  });

  it("δ=100 的 JS 语义：第 1 年 0^0=1 满容量、第 2 年起归零（不产生 NaN）", () => {
    const y1 = storageThroughputCapped({ ...TP_BASE, degradationPctPerYear: 100, yearIndex: 1 });
    const y2 = storageThroughputCapped({ ...TP_BASE, degradationPctPerYear: 100, yearIndex: 2 });
    if (!y1.ok || !y2.ok) throw new Error("应成功");
    expectClose(y1.dMaxKwh, 112_000);
    expectClose(y2.dMaxKwh, 0);
  });

  it("非法衰减拒绝：δ<0 / δ>100 / NaN", () => {
    for (const d of [-0.1, 100.1, NaN]) {
      const r = storageThroughputCapped({ ...TP_BASE, degradationPctPerYear: d });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_degradation");
    }
  });
});

describe("storageThroughputCapped · 循环/日历寿命", () => {
  it("寿命折算封顶：cycleLife=700·10 年 → 70 次/年", () => {
    const r = storageThroughputCapped({ ...TP_BASE, cycleLife: 700 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.annualCycles, 70);
    expectClose(r.dMaxKwh, 320 * 70);
  });

  it("运营天数封顶：cycles=min(天数, 寿命折算)", () => {
    const r = storageThroughputCapped({ ...TP_BASE, operatingDays: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.annualCycles, 100);
  });

  it("超过寿命上限后不得继续增加循环价值：cycleLife 7000 与 7e6 的 D_max 相同", () => {
    const a = storageThroughputCapped({ ...TP_BASE, cycleLife: 7000 }); // 700 > 350
    const b = storageThroughputCapped({ ...TP_BASE, cycleLife: 7_000_000 }); // 700000 > 350
    if (!a.ok || !b.ok) throw new Error("应成功");
    expectClose(a.annualCycles, 350);
    expectClose(a.dMaxKwh, b.dMaxKwh);
    expect(a.dMaxKwh).toBe(b.dMaxKwh); // 完全一致（同一封顶）
  });

  it("寿命参数非有限/非法 → 不启用寿命折算（沿用 S4 口径），仍由运营天数封顶", () => {
    for (const over of [
      { cycleLife: Infinity, calendarLifeYears: 10 },
      { cycleLife: NaN, calendarLifeYears: 10 },
      { cycleLife: 6000, calendarLifeYears: Infinity },
      { cycleLife: 6000, calendarLifeYears: 0 },
      { cycleLife: 6000, calendarLifeYears: -5 },
    ]) {
      const r = storageThroughputCapped({ ...TP_BASE, ...over });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expectClose(r.annualCycles, 350);
    }
  });
});

describe("storageThroughputCapped · 零值/非法输入", () => {
  it("storageEnergy=0 或 storagePower=0 → no_storage（合法归零分支）", () => {
    for (const over of [{ storageEnergyKwh: 0 }, { storagePowerKw: 0 }]) {
      const r = storageThroughputCapped({ ...TP_BASE, ...over });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("no_storage");
    }
  });

  it("负能量/非有限容量功率 → 拒绝", () => {
    for (const over of [
      { storageEnergyKwh: -5 },
      { storagePowerKw: -1 },
      { storageEnergyKwh: NaN },
      { storagePowerKw: Infinity },
    ]) {
      const r = storageThroughputCapped({ ...TP_BASE, ...over });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(["no_storage", "invalid_input"]).toContain(r.reason);
      }
    }
  });

  it("其他非法输入：H≤0 / 天数≤0 / 年序<1", () => {
    for (const [over, reason] of [
      [{ dischargeWindowHours: 0 }, "invalid_window"],
      [{ dischargeWindowHours: -2 }, "invalid_window"],
      [{ operatingDays: 0 }, "invalid_operating_days"],
      [{ yearIndex: 0 }, "invalid_year"],
      [{ yearIndex: NaN }, "invalid_year"],
    ] as const) {
      const r = storageThroughputCapped({ ...TP_BASE, ...over });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    }
  });
});

/* ─────────────────────────── B. energyFlowLedger ─────────────────────────── */

describe("energyFlowLedger · 基线分配", () => {
  it("基线：消纳 margin(0.3023) > 套利 margin(0.2455) → D_max=112,000 被消纳腿吃满（margin 高者先占）", () => {
    const r = energyFlowLedger(lg());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.mPvKwh, 112_000);
    expectClose(r.mArbKwh, 0);
    expect(r.arbOpen).toBe(true);
    expect(r.pvOpen).toBe(true);
    // pv margin = p − feedIn/η = 0.7 − 0.35/0.88 = 0.302272…；arb margin = p − p_valley/η = 0.7 − 0.4/0.88 = 0.245454…
    expectClose(r.pvUnitMarginYuanPerKwh, 0.7 - 0.35 / 0.88);
    expectClose(r.arbUnitMarginYuanPerKwh, 0.7 - 0.4 / 0.88);
    expect(r.pvUnitMarginYuanPerKwh).toBeGreaterThan(r.arbUnitMarginYuanPerKwh);
    expectClose(r.dPvYuan, 112_000 * (0.7 - 0.35 / 0.88));
    expectClose(r.dArbYuan, 0);
    expectClose(r.dStoYuan, r.dArbYuan + r.dPvYuan);
  });

  it("高价差 spread=1.0：套利 margin(0.4727) 反超消纳(0.3023) → 套利先占满 D_max（分配可翻转，非硬编码）", () => {
    const r = energyFlowLedger(lg({ spreadYuanPerKwh: 1.0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.arbUnitMarginYuanPerKwh, 0.7 - 0.2 / 0.88);
    expect(r.arbUnitMarginYuanPerKwh).toBeGreaterThan(r.pvUnitMarginYuanPerKwh);
    expectClose(r.mArbKwh, 112_000);
    expectClose(r.mPvKwh, 0);
    expectClose(r.dArbYuan, 112_000 * (0.7 - 0.2 / 0.88));
    expectClose(r.dPvYuan, 0);
  });

  it("D_max 充足时：两腿都吃满——套利受峰时时间片 σ·Imp0 约束，消纳受 η·Exp0 约束", () => {
    const r = energyFlowLedger(lg({ dMaxKwh: 5_000_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.mArbKwh, 0.4 * 2_000_000); // 时间片 80 万
    expectClose(r.mPvKwh, 0.88 * 300_000); // 剩余预算充足 → 受 η·Exp0 封顶
    expectClose(r.pvDivertedKwh, 300_000); // 截走光伏 = Exp0（全部）
    expectClose(r.pvExportAfterKwh, 0);
    expectClose(r.dPvYuan, 264_000 * (0.7 - 0.35 / 0.88));
  });
});

describe("energyFlowLedger · Energy Flow Ledger 不变量（指令 §3）", () => {
  const GRID: Array<Partial<EnergyFlowLedgerInput>> = [];
  for (const dMax of [0, 1_000, 112_000, 5_000_000, 1e12])
    for (const exp0 of [0, 100_000, 300_000, 1e7])
      for (const imp0 of [0, 50_000, 2_000_000, 1e7])
        for (const sigma of [0, 0.4, 1])
          for (const eta of [0.6, 0.88])
            for (const spread of [0.2, 0.6])
              for (const feedIn of [0.1, 0.35])
                GRID.push({ dMaxKwh: dMax, pvSurplusKwh: exp0, gridImportKwh: imp0, peakLoadShareFraction: sigma, etaFraction: eta, spreadYuanPerKwh: spread, feedInYuanPerKwh: feedIn });

  it("I1：M_arb + M_pv ≤ D_max（同一循环预算不重复占用）——全网格", () => {
    for (const g of GRID) {
      const r = energyFlowLedger(lg(g));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.mArbKwh + r.mPvKwh).toBeLessThanOrEqual(g.dMaxKwh! + 1e-6);
    }
  });

  it("I2：M_pv/η ≤ Exp0 且 截走+剩余上网 ≡ Exp0（一度光伏只有一个去向）——全网格", () => {
    for (const g of GRID) {
      const r = energyFlowLedger(lg(g));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pvDivertedKwh).toBeLessThanOrEqual(g.pvSurplusKwh! + 1e-6);
      expectClose(r.pvDivertedKwh + r.pvExportAfterKwh, g.pvSurplusKwh!);
    }
  });

  it("I3：与扁平 E4 反事实的成本差恒等于 Δ_arb+Δ_pv（套利腿不重复抵扣 E4 购电量）", () => {
    // 反事实账本（E4 保持 Imp0×p 不变）：
    //   baseline = Imp0·p
    //   withStorage = (Imp0−mArb−mPv)·p + (mArb/η)·p_valley + (mPv/η)·feedIn
    //   savings = baseline − withStorage ≡ mArb·(p − p_valley/η) + mPv·(p − feedIn/η) = Δ_sto
    const scenarios: Array<Partial<EnergyFlowLedgerInput>> = [
      {},
      { dMaxKwh: 5_000_000 },
      { dMaxKwh: 3_000_000, pvSurplusKwh: 1_000_000 },
      { dMaxKwh: 50_000, pvSurplusKwh: 10_000, gridImportKwh: 20_000 },
      { dMaxKwh: 1e6, etaFraction: 0.7, spreadYuanPerKwh: 1.0, feedInYuanPerKwh: 0.2 },
      { dMaxKwh: 800_000, peakLoadShareFraction: 1 },
      { dMaxKwh: 800_000, peakLoadShareFraction: 0 },
    ];
    for (const s of scenarios) {
      const r = energyFlowLedger(lg(s));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const p = s.elecPriceYuanPerKwh ?? LG_BASE.elecPriceYuanPerKwh;
      const imp0 = s.gridImportKwh ?? LG_BASE.gridImportKwh;
      const baseline = imp0 * p;
      const withStorage =
        (imp0 - r.mArbKwh - r.mPvKwh) * p +
        r.arbitrageGridDrawKwh * r.valleyPriceYuanPerKwh +
        r.pvDivertedKwh * (s.feedInYuanPerKwh ?? LG_BASE.feedInYuanPerKwh);
      expectClose(baseline - withStorage, r.dStoYuan);
      // 并显式证明：若按设计稿 §4.4 的 p_peak 口径记账，将多出 mArb·(p_peak−p) —— 即重复计算。
      if (r.mArbKwh > 0) {
        const docFormula = r.mArbKwh * (r.peakPriceYuanPerKwh - r.valleyPriceYuanPerKwh / (s.etaFraction ?? LG_BASE.etaFraction));
        expect(docFormula).toBeGreaterThan(r.dArbYuan + 1e-6);
      }
    }
  });

  it("账后能量不为负：gridPurchaseAfter ≥ 0（含套利损耗）——全网格", () => {
    for (const g of GRID) {
      const r = energyFlowLedger(lg(g));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.gridPurchaseAfterKwh).toBeGreaterThanOrEqual(-1e-6);
      expect(r.pvExportAfterKwh).toBeGreaterThanOrEqual(-1e-6);
      expect(r.dArbYuan).toBeGreaterThanOrEqual(0);
      expect(r.dPvYuan).toBeGreaterThanOrEqual(0);
      expect(r.dStoYuan).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("energyFlowLedger · 峰谷价差", () => {
  it("spread=0 → 套利关闭（p−p/η<0）；消纳腿不受影响", () => {
    const r = energyFlowLedger(lg({ spreadYuanPerKwh: 0, dMaxKwh: 5_000_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arbOpen).toBe(false);
    expectClose(r.mArbKwh, 0);
    expect(r.pvOpen).toBe(true);
    expect(r.dPvYuan).toBeGreaterThan(0);
  });

  it("低价差 0.05：0.7 − 0.675/0.88 < 0 → 套利诚实关断（不硬凑收益）", () => {
    const r = energyFlowLedger(lg({ spreadYuanPerKwh: 0.05 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arbOpen).toBe(false);
    expectClose(r.dArbYuan, 0);
  });

  it("负价差 → 套利关闭", () => {
    const r = energyFlowLedger(lg({ spreadYuanPerKwh: -0.6 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arbOpen).toBe(false);
    expectClose(r.dStoYuan, r.dPvYuan);
  });

  it("价差扫描 0.1→1.5：总收益严格不降（margin 优先=最优分配对 margin 单调）；三个 regime 显式验证", () => {
    const at = (s: number) => {
      const r = energyFlowLedger(lg({ dMaxKwh: 1_000_000, gridImportKwh: 10_000_000, peakLoadShareFraction: 0.5, spreadYuanPerKwh: s }));
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("应成功");
      return r;
    };
    let prev = -Infinity;
    for (let s = 0.1; s <= 1.5001; s += 0.1) {
      const r = at(s);
      expect(r.dStoYuan).toBeGreaterThanOrEqual(prev - 1e-6); // 最优目标值随 arb margin 单调不减
      prev = r.dStoYuan;
    }
    // regime 1（低价差 0.1 < 开启阈 0.168）：套利关断，全预算给消纳
    const r1 = at(0.1);
    expect(r1.arbOpen).toBe(false);
    expectClose(r1.mArbKwh, 0);
    expectClose(r1.mPvKwh, Math.min(1_000_000, 0.88 * 300_000));
    // regime 2（0.5：套利开但 margin 仍低于消纳）：消纳先占 26.4 万，套利吃剩余预算
    const r2 = at(0.5);
    expect(r2.arbOpen).toBe(true);
    expectClose(r2.mPvKwh, 264_000);
    expectClose(r2.mArbKwh, 1_000_000 - 264_000);
    // regime 3（0.8 ≥ 0.7 交叉点）：套利 margin 反超 → 先占满预算，消纳被挤出
    const r3 = at(0.8);
    expectClose(r3.mArbKwh, 1_000_000);
    expectClose(r3.mPvKwh, 0);
  });

  it("极端 spread=100（谷价为负）：结果有限且满足不变量（负谷价=市场付钱充电，域约束属参数引擎）", () => {
    const r = energyFlowLedger(lg({ dMaxKwh: 1_000_000, gridImportKwh: 10_000_000, peakLoadShareFraction: 0.5, spreadYuanPerKwh: 100 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number.isFinite(r.dArbYuan)).toBe(true);
    expect(r.mArbKwh).toBeLessThanOrEqual(0.5 * 10_000_000 + 1e-6);
    expectClose(r.mArbKwh + r.mPvKwh <= 1_000_000 + 1e-6 ? r.mArbKwh : NaN, r.mArbKwh); // I1 自检不崩
    expect(r.dArbYuan).toBeGreaterThan(0);
  });
});

describe("energyFlowLedger · 光伏消纳", () => {
  it("无光伏富余 Exp0=0 → 消纳腿 0，套利腿照常", () => {
    const r = energyFlowLedger(lg({ pvSurplusKwh: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.mPvKwh, 0);
    expectClose(r.dPvYuan, 0);
    expect(r.mArbKwh).toBeGreaterThan(0);
  });

  it("feedIn 越低消纳价值不降（未封顶扫描 0.6→0.05）；feedIn≥p·η 时消纳关断", () => {
    let prev = -Infinity;
    for (let f = 0.6; f >= 0.0499; f -= 0.05) {
      const r = energyFlowLedger(lg({ dMaxKwh: 1_000_000, pvSurplusKwh: 10_000_000, gridImportKwh: 10_000_000, peakLoadShareFraction: 0, feedInYuanPerKwh: f }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      if (prev > -Infinity) expect(r.dPvYuan).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = r.dPvYuan;
    }
    const closed = energyFlowLedger(lg({ feedInYuanPerKwh: 0.7 })); // 0.7−0.7/0.88<0
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.pvOpen).toBe(false);
    expectClose(closed.dPvYuan, 0);
  });

  it("消纳不能吸收超过 η·Exp0：D_max 充足时 mPv=η·Exp0（I2 的正向形式）", () => {
    const r = energyFlowLedger(lg({ dMaxKwh: 9_000_000, pvSurplusKwh: 500_000, gridImportKwh: 10_000_000, peakLoadShareFraction: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.mPvKwh, 0.88 * 500_000);
    expectClose(r.pvDivertedKwh, 500_000);
    expectClose(r.pvExportAfterKwh, 0);
  });
});

describe("energyFlowLedger · 效率", () => {
  it("公式实锤：margins 确含 /η（p−p_valley/η 与 p−feedIn/η），Δ=电量×margin（实现内不是测试模拟）", () => {
    const r = energyFlowLedger(lg({ dMaxKwh: 5_000_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.arbUnitMarginYuanPerKwh, 0.7 - (0.7 - 0.3) / 0.88);
    expectClose(r.pvUnitMarginYuanPerKwh, 0.7 - 0.35 / 0.88);
    expectClose(r.dArbYuan, r.mArbKwh * r.arbUnitMarginYuanPerKwh);
    expectClose(r.dPvYuan, r.mPvKwh * r.pvUnitMarginYuanPerKwh);
  });

  it("η 下降 → 储能净收益不增（全扫描含腿关断，单调不增）", () => {
    const etas = [0.98, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.58, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];
    let prev = Infinity;
    for (const eta of etas) {
      const r = energyFlowLedger(lg({ dMaxKwh: 1_000_000, gridImportKwh: 10_000_000, peakLoadShareFraction: 0.5, pvSurplusKwh: 10_000_000, etaFraction: eta }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.dStoYuan).toBeLessThanOrEqual(prev + 1e-6);
      prev = r.dStoYuan;
    }
    expect(prev === 0).toBe(true); // η=0.3 时两腿全关（关断腿=0×负margin=-0，数值恒等 0，故用 === 断言）
  });

  it("η=1 时套利 margin=p−p_valley=spread/2（扁平 E4 口径的解析形式）", () => {
    const r = energyFlowLedger(lg({ etaFraction: 1 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.arbUnitMarginYuanPerKwh, 0.3);
  });

  it("非法效率拒绝：η=0 / 负 / >1 / NaN / Infinity", () => {
    for (const eta of [0, -0.5, 1.2, NaN, Infinity]) {
      const r = energyFlowLedger(lg({ etaFraction: eta }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_eta");
    }
  });
});

describe("energyFlowLedger · σ 时间片与跨腿互斥", () => {
  it("σ=0：套利时间片为 0（即使 margin>0 也不运行），消纳可用全部下网片", () => {
    const r = energyFlowLedger(lg({ dMaxKwh: 5_000_000, peakLoadShareFraction: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arbOpen).toBe(true);
    expectClose(r.mArbKwh, 0);
    expectClose(r.mPvKwh, Math.min(5_000_000, 0.88 * 300_000, 1 * 2_000_000));
  });

  it("σ=1：全部下网算峰时，消纳腿电量片为 0（两腿时间片不相交）", () => {
    const r = energyFlowLedger(lg({ dMaxKwh: 5_000_000, peakLoadShareFraction: 1 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.mArbKwh, Math.min(5_000_000, 2_000_000));
    expectClose(r.mPvKwh, 0);
  });

  it("非法 σ 拒绝：<0 / >1 / NaN", () => {
    for (const s of [-0.1, 1.1, NaN]) {
      const r = energyFlowLedger(lg({ peakLoadShareFraction: s }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_share");
    }
  });
});

describe("energyFlowLedger · 零值/负能量/非法输入", () => {
  it("无下网电 Imp0=0：两腿皆 0，Δ_sto=0", () => {
    const r = energyFlowLedger(lg({ gridImportKwh: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.mArbKwh, 0);
    expectClose(r.mPvKwh, 0);
    expectClose(r.dStoYuan, 0);
  });

  it("Exp0=0 且 Imp0=0：全零无 NaN", () => {
    const r = energyFlowLedger(lg({ pvSurplusKwh: 0, gridImportKwh: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.dStoYuan, 0);
  });

  it("D_max=0（合法零吞吐）→ 两腿 0；D_max<0 → 拒绝", () => {
    const zero = energyFlowLedger(lg({ dMaxKwh: 0 }));
    expect(zero.ok).toBe(true);
    if (!zero.ok) return;
    expectClose(zero.dStoYuan, 0);
    const neg = energyFlowLedger(lg({ dMaxKwh: -1 }));
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.reason).toBe("invalid_dmax");
  });

  it("负能量（Exp0/Imp0<0）拒绝；负电价/负上网价拒绝；价差非有限拒绝", () => {
    for (const [over, reason] of [
      [{ pvSurplusKwh: -1 }, "invalid_energy"],
      [{ gridImportKwh: -100 }, "invalid_energy"],
      [{ elecPriceYuanPerKwh: -0.7 }, "invalid_prices"],
      [{ feedInYuanPerKwh: -0.1 }, "invalid_prices"],
      [{ spreadYuanPerKwh: NaN }, "invalid_prices"],
      [{ elecPriceYuanPerKwh: NaN }, "invalid_prices"],
    ] as const) {
      const r = energyFlowLedger(lg(over));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    }
  });
});

/* ─────────────────────────── C. storageValueDelta 编排 ─────────────────────────── */

describe("storageValueDelta · 编排", () => {
  it("正常编排：吞吐→账本贯通，Δ_sto=Δ_arb+Δ_pv（基线夹具消纳 margin 更高 → 消纳腿先占）", () => {
    const r = storageValueDelta(YEAR_BASE);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.included) throw new Error("应纳入计算");
    expectClose(r.throughput.dMaxKwh, 112_000);
    expectClose(r.ledger.mPvKwh, 112_000);
    expectClose(r.ledger.mArbKwh, 0);
    expectClose(r.dStoYuan, r.dArbYuan + r.dPvYuan);
    expect(r.dPvYuan).toBeGreaterThan(0);
    expectClose(r.dArbYuan, 0);
  });

  it("storage=0（E=0 或 P=0）→ included:false + 全零（最重要回退分支）", () => {
    for (const over of [{ storageEnergyKwh: 0 }, { storagePowerKw: 0 }]) {
      const r = storageValueDelta({ ...YEAR_BASE, ...over });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.included).toBe(false);
      expect(r.dArbYuan).toBe(0);
      expect(r.dPvYuan).toBe(0);
      expect(r.dStoYuan).toBe(0);
      expect(Number.isFinite(r.dStoYuan)).toBe(true);
      if (!r.included) expect(r.reason).toContain("no_storage");
    }
  });

  it("非法输入安全归零：非法 SOC / 非法 η / 非法 σ → included:false + 全零", () => {
    for (const over of [
      { socMinPct: 90, socMaxPct: 10 },
      { etaFraction: 0 },
      { peakLoadShareFraction: 2 },
      { dischargeWindowHours: -1 },
    ]) {
      const r = storageValueDelta({ ...YEAR_BASE, ...over });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.included).toBe(false);
      expect(r.dStoYuan).toBe(0);
    }
  });

  it("衰减贯穿编排：逐年 Δ_sto 不增（其他条件固定）", () => {
    let prev = Infinity;
    for (let y = 1; y <= 15; y++) {
      const r = storageValueDelta({ ...YEAR_BASE, yearIndex: y });
      expect(r.ok).toBe(true);
      if (!r.ok || !r.included) throw new Error("应纳入");
      expect(r.dStoYuan).toBeLessThanOrEqual(prev + 1e-6);
      prev = r.dStoYuan;
    }
  });

  it("寿命贯穿编排：cycleLife 7000 与 7e6 的 Δ_sto 完全一致（超寿命不加价值）", () => {
    const a = storageValueDelta({ ...YEAR_BASE, cycleLife: 7000 });
    const b = storageValueDelta({ ...YEAR_BASE, cycleLife: 7_000_000 });
    if (!a.ok || !b.ok || !a.included || !b.included) throw new Error("应纳入");
    expect(a.dStoYuan).toBe(b.dStoYuan);
  });

  it("不变量经编排仍成立（抽样子网格）", () => {
    for (const e of [0, 400, 4000, 40000]) {
      for (const imp0 of [0, 2_000_000]) {
        for (const exp0 of [0, 300_000, 3_000_000]) {
          const r = storageValueDelta({ ...YEAR_BASE, storageEnergyKwh: e, gridImportKwh: imp0, pvSurplusKwh: exp0 });
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          if (!r.included) {
            expect(r.dStoYuan).toBe(0);
            continue;
          }
          expect(r.ledger.mArbKwh + r.ledger.mPvKwh).toBeLessThanOrEqual(r.throughput.dMaxKwh + 1e-6);
          expect(r.ledger.pvDivertedKwh).toBeLessThanOrEqual(exp0 + 1e-6);
          expect(r.dStoYuan).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

/* ─────────────────────────── D. 边际价值（测试内辅助，不接生产经济模型） ─────────────────────────── */

/** 容量响应分类：A=内部最优 / B=范围内持续上升 / C=范围内持续下降（不预设 argmax 必然存在）。 */
function classifyCapacityResponse(values: number[]): "A_interior_peak" | "B_no_interior_still_increasing" | "C_no_interior_still_decreasing" {
  let maxIdx = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[maxIdx]) maxIdx = i;
  if (maxIdx === 0) return "C_no_interior_still_decreasing";
  if (maxIdx === values.length - 1) return "B_no_interior_still_increasing";
  return "A_interior_peak";
}

/** 测试辅助"价值函数"：Δ_sto（纯函数）− 线性成本代理 E×costPerKwh。非生产口径，仅验边际逻辑。 */
function valueAtCapacity(eCapKwh: number, costPerKwh: number): number {
  const r = storageValueDelta({ ...YEAR_BASE, storageEnergyKwh: eCapKwh });
  const dSto = r.ok && r.included ? r.dStoYuan : 0;
  return dSto - eCapKwh * costPerKwh;
}

describe("边际价值 · 三种容量响应都能正确表达（不预设 argmax）", () => {
  const sweep = (costPerKwh: number, from: number, to: number, step: number): number[] => {
    const out: number[] = [];
    for (let e = from; e <= to + 1e-9; e += step) out.push(valueAtCapacity(e, costPerKwh));
    return out;
  };

  it("A：成本适中 → 功率封顶使收益饱和，该扫描范围内呈内部最优（E*≈500；此为该情景的实测形态，非必然形态，ISSUE-3）", () => {
    const values = sweep(60, 0, 4000, 100);
    expect(classifyCapacityResponse(values)).toBe("A_interior_peak");
    // 最优点在功率封顶拐点 E=E_bound/w=400/0.8=500 处
    expect(values[5]).toBeGreaterThan(values[4]);
    expect(values[5]).toBeGreaterThan(values[6]);
  });

  it("B：成本≈0 且范围未饱和 → 范围内持续上升，如实报告'未发现内部最优点'", () => {
    const values = sweep(0, 0, 300, 50);
    expect(classifyCapacityResponse(values)).toBe("B_no_interior_still_increasing");
  });

  it("C：成本过高 → 范围内持续下降，如实报告'未发现内部最优点'", () => {
    const values = sweep(200, 0, 4000, 100);
    expect(classifyCapacityResponse(values)).toBe("C_no_interior_still_decreasing");
    expect(values[0]).toBe(0); // E=0 → 无收益无成本
  });

  it("边际值定义：Marginal(E)=value(E+ΔE)−value(E)，且边际在饱和后转负（A 情形）", () => {
    const dE = 25;
    const m450 = valueAtCapacity(450 + dE, 60) - valueAtCapacity(450, 60);
    const m550 = valueAtCapacity(550 + dE, 60) - valueAtCapacity(550, 60);
    expect(m450).toBeGreaterThan(0); // 饱和前边际为正（收益斜率 84.64 − 成本 60 > 0）
    expect(m550).toBeLessThan(0); // 饱和后边际为负（只有成本在涨，−60×ΔE）
  });
});

/* ─────────────────────────── E. 单位与量纲 ─────────────────────────── */

describe("单位检查", () => {
  it("kWh 与 kW·h 同量纲可比：E=400kWh(w=1) 与 P=200kW×2h=400kWh 相等 → balanced", () => {
    const r = storageThroughputCapped({ ...TP_BASE, socMinPct: 0, socMaxPct: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binding).toBe("balanced");
    expectClose(r.energyBoundPerCycleKwh, 400);
    expectClose(r.powerBoundPerCycleKwh, 400);
  });

  it("元/kWh × kWh = 元：Δ_arb 数值上等于 电量×单价（无系数错位）", () => {
    const r = energyFlowLedger(lg());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.dArbYuan, r.mArbKwh * r.arbUnitMarginYuanPerKwh, 1e-12);
    expectClose(r.dPvYuan, r.mPvKwh * r.pvUnitMarginYuanPerKwh, 1e-12);
  });

  it("价格分解 元/kWh：p_valley=0.4 / p_peak=1.0（p=0.7, spread=0.6）", () => {
    const r = energyFlowLedger(lg());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.valleyPriceYuanPerKwh, 0.4);
    expectClose(r.peakPriceYuanPerKwh, 1.0);
  });

  it("年吞吐量纲：kWh/次 × 次/年 × 无量纲衰减 = kWh/年", () => {
    const r = storageThroughputCapped({ ...TP_BASE, yearIndex: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectClose(r.dMaxKwh, r.perCycleDischargeKwh * r.annualCycles * r.capacityFadeFactor, 1e-12);
    expectClose(r.dMaxKwh, 320 * 350 * (1 - 0.025) ** 2);
  });
});

/* ─────────────────────────── F. 健壮性扫描（NaN / ±Infinity 全字段注入） ─────────────────────────── */

describe("健壮性扫描 · 全字段 NaN/±Infinity 注入不产生 NaN/Infinity/负值", () => {
  const NUMERIC_KEYS = [
    "storageEnergyKwh",
    "storagePowerKw",
    "socMinPct",
    "socMaxPct",
    "dischargeWindowHours",
    "operatingDays",
    "cycleLife",
    "calendarLifeYears",
    "degradationPctPerYear",
    "yearIndex",
    "etaFraction",
    "pvSurplusKwh",
    "gridImportKwh",
    "peakLoadShareFraction",
    "elecPriceYuanPerKwh",
    "spreadYuanPerKwh",
    "feedInYuanPerKwh",
  ] as const;

  /** 注入坏值后的通用断言：要么安全归零，要么 included 且全部有限/非负/满足不变量。 */
  function assertSafe(r: ReturnType<typeof storageValueDelta>, input: StorageValueYearInput): void {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number.isFinite(r.dStoYuan)).toBe(true);
    expect(Number.isFinite(r.dArbYuan)).toBe(true);
    expect(Number.isFinite(r.dPvYuan)).toBe(true);
    expect(r.dStoYuan).toBeGreaterThanOrEqual(0);
    expect(r.dArbYuan).toBeGreaterThanOrEqual(0);
    expect(r.dPvYuan).toBeGreaterThanOrEqual(0);
    if (!r.included) {
      expect(r.dArbYuan).toBe(0);
      expect(r.dPvYuan).toBe(0);
      expect(r.dStoYuan).toBe(0);
    } else {
      expect(Number.isFinite(r.throughput.dMaxKwh)).toBe(true);
      expect(Number.isFinite(r.ledger.mArbKwh)).toBe(true);
      expect(r.ledger.mArbKwh + r.ledger.mPvKwh).toBeLessThanOrEqual(r.throughput.dMaxKwh + 1e-6);
      expect(r.ledger.pvDivertedKwh).toBeLessThanOrEqual(input.pvSurplusKwh + 1e-6);
    }
  }

  it("NaN 注入全字段（17 键）→ 永不 NaN/负值", () => {
    for (const key of NUMERIC_KEYS) {
      const input = { ...YEAR_BASE, [key]: NaN } as StorageValueYearInput;
      assertSafe(storageValueDelta(input), input);
    }
  });

  it("+Infinity / −Infinity 注入全字段 → 永不 Infinity/负值（寿命键的 Infinity 按设计=不限）", () => {
    for (const key of NUMERIC_KEYS) {
      for (const bad of [Infinity, -Infinity]) {
        const input = { ...YEAR_BASE, [key]: bad } as StorageValueYearInput;
        assertSafe(storageValueDelta(input), input);
      }
    }
  });

  it("极端容量 E=1e9：结果有限且受功率/时间片/Exp0 封顶", () => {
    const r = storageValueDelta({ ...YEAR_BASE, storageEnergyKwh: 1e9 });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.included) throw new Error("应纳入");
    expectClose(r.throughput.perCycleDischargeKwh, 400); // 功率封顶 P·H=400
    expectClose(r.throughput.dMaxKwh, 400 * 350);
    expectClose(r.ledger.mPvKwh, 400 * 350); // 消纳 margin 更高 → 先占满 D_max（140,000 < η·Exp0=264,000）
    expect(r.ledger.mPvKwh).toBeLessThanOrEqual(0.88 * 300_000 + 1e-6);
    expectClose(r.ledger.mArbKwh, 0);
  });

  it("超功率配超小容量：E=1e-6 → D_max 微小但有限，Δ 有限非负", () => {
    const r = storageValueDelta({ ...YEAR_BASE, storageEnergyKwh: 1e-6 });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.included) throw new Error("应纳入");
    expect(r.throughput.dMaxKwh).toBeGreaterThan(0);
    expect(r.throughput.dMaxKwh).toBeLessThan(1);
    expect(r.dStoYuan).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.dStoYuan)).toBe(true);
  });
});
