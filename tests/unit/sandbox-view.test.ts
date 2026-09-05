/**
 * 沙盘中台「视图模型」`src/lib/sandbox-view.ts` 黄金样本（中途重构 R4 可视化）。
 *
 * 覆盖两类断言：
 *   1) 纯投影：手搓 CalcResult/Tech/Tornado fixture，逐项锁死格式化与图表数据形状（含诚实降级：
 *      NaN/null → 「—」、从不回本、多根示警、失败不画脏图）。
 *   2) ★§8「图表绑定模型」实证：把**真实引擎**（runSandboxModelBaseline / computeTechModel /
 *      computeTornado）的输出喂进 buildSandboxViewModel，断言呈现数字与模型输出严格一致
 *      （现金流年数、累计=前缀和、NPV 卡着色、最敏感变量标签），证图表真绑模型非写死页面数字。
 */

import { describe, it, expect } from "vitest";
import {
  VIEW_VERSION,
  formatMoney,
  formatPct,
  formatPctRaw,
  formatRatio,
  formatYears,
  formatEnergyKwh,
  cashFlowSeries,
  capexItems,
  opexItems,
  revenueItems,
  year1MoneyComparison,
  energyBalanceItems,
  tornadoSeries,
  summaryCards,
  buildSandboxViewModel,
} from "@/lib/sandbox-view";
import type { CalcResultOk } from "@/server/sandbox-model";
import type { TechFirstYearResult } from "@/server/sandbox-tech";
import type { TornadoResult } from "@/server/sandbox-sensitivity";
import { runSandboxModelBaseline } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";

/* ───────────────────────── 手搓 fixture ───────────────────────── */

function okCalc(over: Partial<CalcResultOk> = {}): CalcResultOk {
  return {
    ok: true,
    calcRef: "model@1.0.0",
    engineVersions: { model: "1.0.0", tech: "1.0.0", finance: "1.0.0", params: "1.1.0" },
    methodology: "E1–E8",
    needsProfessionalReview: true,
    capex: { pv: 3000000, storage: 400000, charger: 310000, gross: 3710000, constructionSubsidy: 185500, net: 3524500 },
    opexY1: { pv: 60000, storage: 40000, charger: 96000, depotFixed: 140300, gross: 336300 },
    revenueY1: { charging: 4987500, pvExport: 0, operationSubsidy: 0, gross: 4987500 },
    energyCostY1: 3565174,
    netCashFlowY1PreTax: 1086026,
    annualCashFlow: [-3524500, 814519, 814519],
    breakEvenChargingPriceY1: 0.7431,
    metrics: {
      npv: 4277409,
      irr: { ok: true, value: 0.237553, signChanges: 1 },
      simplePaybackYears: 4.2,
      discountedPaybackYears: 5.28,
      roi: { ok: true, value: 4.003502 },
    },
    notes: ["透明简化"],
    ...over,
  };
}

const tech: TechFirstYearResult = {
  pvEnergyY1Kwh: 492000,
  chargeEnergyDeliveredY1Kwh: 5250000,
  acLoadY1Kwh: 5585106,
  chargingLossY1Kwh: 335106,
  selfConsumedY1Kwh: 492000,
  pvExportY1Kwh: 0,
  gridImportY1Kwh: 5093106,
  pvSelfConsumptionRatePct: 100,
  renewableFractionPct: 8.8,
};

function tornadoFixture(): TornadoResult {
  return {
    version: "1.0.0",
    calcRef: "sensitivity@1.0.0",
    metric: "npv",
    baseValue: 4277409,
    rows: [
      { key: "project.chargingPrice", label: "综合充电单价", unit: "元/kWh", deltaPct: 15, lowInput: 0.85, highInput: 1.15, baseMetric: 4277409, lowMetric: -1000000, highMetric: 9201149, swing: 10201149, normalized: 100 },
      { key: "region.elecPrice", label: "电网电价", unit: "元/kWh", deltaPct: 15, lowInput: 0.85, highInput: 1.15, baseMetric: 4277409, lowMetric: 7996796, highMetric: 278009, swing: -7718787, normalized: 75.7 },
      { key: "project.pvCapacity", label: "光伏装机", unit: "kWp", deltaPct: 20, lowInput: NaN, highInput: NaN, baseMetric: null, lowMetric: null, highMetric: null, swing: null },
    ],
    mostSensitiveKey: "project.chargingPrice",
  } as unknown as TornadoResult;
}

/* ───────────────────────── 格式化黄金值 ───────────────────────── */

describe("sandbox-view · 中文格式化纯函数", () => {
  it("VIEW_VERSION 语义化版本串", () => {
    expect(VIEW_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("formatMoney 元/万元/亿元 三档切换 + 边界（1e4→万元、1e8→亿元）", () => {
    expect(formatMoney(999)).toBe("999 元");
    expect(formatMoney(10000)).toBe("1.00 万元"); // 恰 1e4 落万元
    expect(formatMoney(3524500)).toBe("352.45 万元");
    expect(formatMoney(120000000)).toBe("1.20 亿元"); // 恰 1e8 落亿元
    expect(formatMoney(100000000)).toBe("1.00 亿元");
  });

  it("formatMoney 负号保留、整数不带小数（<1e4 时）、非有限/null→—", () => {
    expect(formatMoney(-3524500)).toBe("-352.45 万元");
    expect(formatMoney(500)).toBe("500 元");
    expect(formatMoney(NaN)).toBe("—");
    expect(formatMoney(Infinity)).toBe("—");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
  });

  it("formatPct 小数→百分数；formatPctRaw 已乘100值→百分数", () => {
    expect(formatPct(0.237553)).toBe("23.76%");
    expect(formatPct(-0.05)).toBe("-5.00%");
    expect(formatPct(NaN)).toBe("—");
    expect(formatPctRaw(100)).toBe("100.0%");
    expect(formatPctRaw(8.8)).toBe("8.8%");
    expect(formatPctRaw(null)).toBe("—");
  });

  it("formatRatio 倍数；formatYears null→从不回本（诚实）非有限→—", () => {
    expect(formatRatio(4.0035)).toBe("4.00×");
    expect(formatRatio(null)).toBe("—");
    expect(formatYears(5.28)).toBe("5.28 年");
    expect(formatYears(null)).toBe("从不回本");
    expect(formatYears(NaN)).toBe("—");
  });

  it("formatEnergyKwh 万/亿 kWh 切换 + 非有限", () => {
    expect(formatEnergyKwh(492000)).toBe("49.20 万kWh");
    expect(formatEnergyKwh(120000000)).toBe("1.20 亿kWh");
    expect(formatEnergyKwh(500)).toBe("500 kWh");
    expect(formatEnergyKwh(null)).toBe("—");
  });
});

/* ───────────────────────── 图表数据投影 ───────────────────────── */

describe("sandbox-view · 图表数据投影", () => {
  it("cashFlowSeries 累计=前缀和、year 从 0 递增、空→[]", () => {
    const s = cashFlowSeries([-100, 60, 60]);
    expect(s).toEqual([
      { year: 0, flow: -100, cumulative: -100 },
      { year: 1, flow: 60, cumulative: -40 },
      { year: 2, flow: 60, cumulative: 20 },
    ]);
    expect(cashFlowSeries([])).toEqual([]);
  });

  it("cashFlowSeries 非有限项计入累计按 0（不污染曲线）但 flow 原样留", () => {
    const s = cashFlowSeries([100, NaN, 50]);
    expect(s[1].flow).toBeNaN();
    expect(s[2].cumulative).toBe(150);
  });

  it("capexItems 仅三类实物分量（排除 gross/补贴/net）", () => {
    expect(capexItems(okCalc().capex)).toEqual([
      { name: "光伏", value: 3000000 },
      { name: "储能", value: 400000 },
      { name: "充电桩", value: 310000 },
    ]);
  });

  it("opexItems/revenueItems 分量与顺序", () => {
    const c = okCalc();
    expect(opexItems(c.opexY1).map((x) => x.name)).toEqual(["光伏运维", "储能运维", "桩运维", "场站固定"]);
    expect(revenueItems(c.revenueY1)).toEqual([
      { name: "充电收入", value: 4987500 },
      { name: "余电上网", value: 0 },
      { name: "运营补贴", value: 0 },
    ]);
  });

  it("year1MoneyComparison = 收入 / 购电成本 / 运维成本", () => {
    expect(year1MoneyComparison(okCalc())).toEqual([
      { name: "收入", value: 4987500 },
      { name: "购电成本", value: 3565174 },
      { name: "运维成本", value: 336300 },
    ]);
  });

  it("energyBalanceItems = 自用 / 上网 / 下网", () => {
    expect(energyBalanceItems(tech)).toEqual([
      { name: "光伏自用", value: 492000 },
      { name: "余电上网", value: 0 },
      { name: "电网下网", value: 5093106 },
    ]);
  });

  it("tornadoSeries 相对基线位移 = metric − base；缺失行保留 null", () => {
    const bars = tornadoSeries(tornadoFixture());
    expect(bars[0]).toMatchObject({ key: "project.chargingPrice", deltaLow: -5277409, deltaHigh: 4923740, swing: 10201149, normalized: 100, base: 4277409 });
    expect(bars[1]!.deltaHigh).toBeCloseTo(278009 - 4277409, 0);
    // 第三行指标算不出：delta/ swing / normalized 全 null，绝不冒充
    expect(bars[2]).toMatchObject({ deltaLow: null, deltaHigh: null, swing: null, normalized: null });
  });
});

/* ───────────────────────── 指标卡 ───────────────────────── */

describe("sandbox-view · 指标卡着色与诚实", () => {
  it("NPV>0 → pos；NPV<0 → neg；NPV=NaN → muted 且提示算不出", () => {
    const cards = summaryCards(okCalc());
    expect(cards.find((c) => c.key === "npv")).toMatchObject({ tone: "pos", value: "427.74 万元" });
    expect(summaryCards(okCalc({ metrics: { ...okCalc().metrics, npv: -1000 } })).find((c) => c.key === "npv")!.tone).toBe("neg");
    const nanCard = summaryCards(okCalc({ metrics: { ...okCalc().metrics, npv: NaN } })).find((c) => c.key === "npv")!;
    expect(nanCard).toMatchObject({ tone: "muted", value: "—" });
    expect(nanCard.hint).toContain("算不出");
  });

  it("IRR：无折现率→pos；低于折现率→warn；多根→示警；算不出→muted+reason", () => {
    expect(summaryCards(okCalc()).find((c) => c.key === "irr")).toMatchObject({ tone: "pos", value: "23.76%" });
    expect(summaryCards(okCalc(), 0.30).find((c) => c.key === "irr")!.tone).toBe("warn"); // IRR 0.2376 < 30%
    const multi = okCalc();
    multi.metrics = { ...multi.metrics, irr: { ok: true, value: 0.23, signChanges: 2, multipleRootsPossible: true } };
    expect(summaryCards(multi).find((c) => c.key === "irr")!.hint).toContain("多个 IRR 根");
    const noIrr = okCalc();
    noIrr.metrics = { ...noIrr.metrics, irr: { ok: false, reason: "no_sign_change", signChanges: 0 } };
    const c = summaryCards(noIrr).find((c) => c.key === "irr")!;
    expect(c).toMatchObject({ tone: "muted", value: "—" });
    expect(c.hint).toContain("no_sign_change");
  });

  it("回收期 null→从不回本(neg)；ROI 非 ok→muted；盈亏平衡单价格式化到 4 位", () => {
    const noPay = okCalc();
    noPay.metrics = { ...noPay.metrics, discountedPaybackYears: null };
    expect(summaryCards(noPay).find((c) => c.key === "payback")).toMatchObject({ value: "从不回本", tone: "neg" });
    const noRoi = okCalc();
    noRoi.metrics = { ...noRoi.metrics, roi: { ok: false, reason: "no_investment" } };
    expect(summaryCards(noRoi).find((c) => c.key === "roi")).toMatchObject({ value: "—", tone: "muted" });
    expect(summaryCards(okCalc()).find((c) => c.key === "breakeven")!.value).toBe("0.7431 元/kWh");
  });
});

/* ───────────────────────── 总装配 ───────────────────────── */

describe("sandbox-view · buildSandboxViewModel 装配", () => {
  it("引擎失败（ok:false）→ 只回诚实错误、不产出任何脏图表", () => {
    const vm = buildSandboxViewModel({
      calc: { ok: false, calcRef: "model@1.0.0", reason: "missing_econ_inputs", detail: "缺键", missingInputs: ["finance.taxRate"] } as never,
    });
    expect(vm.ok).toBe(false);
    expect(vm.error?.reason).toBe("missing_econ_inputs");
    expect(vm.error?.missingInputs).toEqual(["finance.taxRate"]);
    expect(vm.cards).toBeUndefined();
    expect(vm.cashFlow).toBeUndefined();
  });

  it("ok 装配全部数据集；tech/tornado 缺省时对应块为 undefined", () => {
    const vm = buildSandboxViewModel({ calc: okCalc() });
    expect(vm.ok).toBe(true);
    expect(vm.cards).toHaveLength(5);
    expect(vm.cashFlow).toHaveLength(3);
    expect(vm.capex).toHaveLength(3);
    expect(vm.energyBalance).toBeUndefined(); // 未传 tech
    expect(vm.tornado).toBeUndefined(); // 未传 tornado
    expect(vm.needsProfessionalReview).toBe(true);
  });

  it("meta：计算期 = 现金流长度 − 1；货币标签来自模型", () => {
    const vm = buildSandboxViewModel({ calc: okCalc(), tech });
    expect(vm.meta?.projectLifeYears).toBe(2); // flows 长 3 → 2 年期
    expect(vm.meta?.capexNetLabel).toBe("352.45 万元");
    expect(vm.meta?.revenueY1Label).toBe("498.75 万元");
    expect(vm.meta?.renewableFractionLabel).toBe("8.8%");
  });
});

/* ──────────── ★§8 图表绑定模型实证（真实引擎输出喂视图） ──────────── */

describe("sandbox-view · ★§8 图表绑定真实模型输出", () => {
  it("真实 runSandboxModelBaseline + computeTechModel + computeTornado → 视图数字与模型严格一致", () => {
    const calc = runSandboxModelBaseline();
    expect(calc.ok).toBe(true);
    if (!calc.ok) return;
    const techRes = computeTechModel(resolveSandbox().numeric);
    const tornado = computeTornado();
    const vm = buildSandboxViewModel({ calc, tech: techRes.ok ? techRes.firstYear : null, tornado, discountRate: 0.08 });

    // 现金流年数 = 引擎 flows 长度（非硬编码）；累计末值 = flows 前缀和
    expect(vm.cashFlow).toHaveLength(calc.annualCashFlow.length);
    const sum = calc.annualCashFlow.reduce((a, b) => a + b, 0);
    expect(vm.cashFlow!.at(-1)!.cumulative).toBeCloseTo(sum, 0);

    // NPV 卡着色与引擎符号一致（基线 NPV>0）
    expect(vm.cards!.find((c) => c.key === "npv")!.tone).toBe("pos");
    // 卡片显示值 = 对引擎 NPV 的格式化（图表绑模型，非另一套数）
    expect(vm.cards!.find((c) => c.key === "npv")!.value).toBe(formatMoney(calc.metrics.npv));

    // 最敏感变量标签来自 tornado（基线下为综合充电单价），视图如实透出
    expect(vm.mostSensitiveLabel).toBe(tornado.rows[0]!.label);
    expect(vm.tornado).toHaveLength(tornado.rows.length);

    // 能量平衡图数据 = 真实 tech firstYear 分量
    if (techRes.ok) {
      expect(vm.energyBalance).toEqual([
        { name: "光伏自用", value: techRes.firstYear.selfConsumedY1Kwh },
        { name: "余电上网", value: techRes.firstYear.pvExportY1Kwh },
        { name: "电网下网", value: techRes.firstYear.gridImportY1Kwh },
      ]);
    }
  });

  it("改参数（充电单价↑）→ 视图 NPV 卡随引擎重算而升（§4 命脉在呈现层的体现）", async () => {
    const { runSandboxModel } = await import("@/server/sandbox-model");
    const base = runSandboxModelBaseline();
    const hi = runSandboxModel({ user: { values: { "project.chargingPrice": 1.2 } } });
    expect(base.ok && hi.ok).toBe(true);
    if (!base.ok || !hi.ok) return;

    expect(hi.metrics.npv).toBeGreaterThan(base.metrics.npv);

    const vmBase = buildSandboxViewModel({ calc: base });
    const vmHi = buildSandboxViewModel({ calc: hi });
    // 视图呈现值 = 对各自引擎 NPV 的格式化（不是写死数字）：更高的 NPV 呈现更大的金额
    expect(vmHi.cards!.find((c) => c.key === "npv")!.value).toBe(formatMoney(hi.metrics.npv));
    expect(vmHi.cashFlow!.at(-1)!.cumulative).toBeGreaterThan(vmBase.cashFlow!.at(-1)!.cumulative);
  });
});
