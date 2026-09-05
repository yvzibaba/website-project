/**
 * 沙盘中台「视图模型」（中途重构 R4 · 可视化）。
 *
 * 职责（§14 优先级 #4 可视化 / §8「图表绑定模型」）：把 R2 计算引擎吐出的纯数据
 * （`CalcResult` / `TechResult` / `TornadoResult`）**确定性地**翻译成 recharts 可直接消费的
 * 扁平数据数组 + 中文格式化指标卡。**本模块零 React、零 recharts、零网络、零时钟、零随机**，
 * 是纯粹的数据 → 视图投影，因此可像 `scoring.ts`/`sandbox-*.ts` 一样用黄金样本单测「焊死」
 * 图表数字与模型输出的一致性（宪法第 7 条：程序算，此处连"呈现"都可复算）。
 *
 * 设计取向：
 *   - **单一真源**：所有数字来自传入的引擎结果，本模块绝不重算 NPV/IRR/现金流（第 16 条防漂移）。
 *   - **诚实降级**：非有限（NaN/±Inf）与 null 一律渲染成占位「—」，绝不伪装成 0；指标算不出时
 *     summary 卡如实标「算不出 / 从不回本 / 存在多根」，与 `needsProfessionalReview` 呼应。
 *   - **货币量级友好**：中国产业项目金额跨度大，`formatMoney` 自动在 元 / 万元 / 亿元 间切换并保留符号。
 *   - 类型只用 `import type` 从 server 引擎引入（编译期擦除，不把 server-only 语义带进浏览器；
 *     沙盘链路本身纯函数、client-safe，见 sandbox-model.ts 依赖分析）。
 */

import type { CapexBreakdown, CalcResult, CalcResultOk, OpexBreakdownY1, RevenueBreakdownY1 } from "@/server/sandbox-model";
import type { TechFirstYearResult } from "@/server/sandbox-tech";
import type { TornadoResult, TornadoRow } from "@/server/sandbox-sensitivity";

/** 视图模型版本（呈现口径变化须升版记因，宪法第 13 条）。 */
export const VIEW_VERSION = "1.0.0";

/* ────────────────────────────── 中文格式化纯函数 ────────────────────────────── */

/** 非有限（含 NaN / ±Infinity）或缺失 → true；用于统一"算不出"判定。 */
function bad(x: number | null | undefined): boolean {
  return x == null || !Number.isFinite(x);
}

/**
 * 金额格式化（元）：|x|≥1e8→「X.XX 亿元」；≥1e4→「X.XX 万元」；否则「X 元」（整数不带小数）。
 * 保留负号；非有限/null → 「—」。万元/亿元统一两位小数，符合投资决策阅读习惯。
 */
export function formatMoney(yuan: number | null | undefined, digits = 2): string {
  if (bad(yuan)) return "—";
  const x = yuan as number;
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(digits)} 亿元`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(digits)} 万元`;
  return `${sign}${Number.isInteger(x) ? x.toFixed(0) : x.toFixed(digits)} 元`;
}

/** 比率（小数 0.2376 → 「23.76%」）。非有限/null → 「—」。 */
export function formatPct(fraction: number | null | undefined, digits = 2): string {
  if (bad(fraction)) return "—";
  return `${(fraction as number * 100).toFixed(digits)}%`;
}

/** 纯百分比数值（已乘 100 的 23.76 → 「23.76%」）——用于引擎已给百分数的字段。 */
export function formatPctRaw(percent: number | null | undefined, digits = 1): string {
  if (bad(percent)) return "—";
  return `${(percent as number).toFixed(digits)}%`;
}

/** 倍数（4.0035 → 「4.00×」）。非有限/null → 「—」。 */
export function formatRatio(value: number | null | undefined, digits = 2): string {
  if (bad(value)) return "—";
  return `${(value as number).toFixed(digits)}×`;
}

/** 年（4.2 → 「4.20 年」；null → 「从不回本」，呼应 sandbox-finance 的诚实语义）。 */
export function formatYears(years: number | null | undefined, digits = 2): string {
  if (years === null) return "从不回本";
  if (bad(years)) return "—";
  return `${(years as number).toFixed(digits)} 年`;
}

/** 能量（kWh）：≥1e8→「亿 kWh」；≥1e4→「万 kWh」；否则「kWh」带千分位。非有限 → 「—」。 */
export function formatEnergyKwh(kwh: number | null | undefined): string {
  if (bad(kwh)) return "—";
  const x = kwh as number;
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 亿kWh`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(2)} 万kWh`;
  return `${sign}${a.toFixed(0)} kWh`;
}

/* ────────────────────────────── 图表数据投影 ────────────────────────────── */

export interface CashFlowPoint {
  /** 年序：0 = 建设年（−净 CAPEX），1..N = 运营年。 */
  year: number;
  /** 当年税后净现金流（元）。 */
  flow: number;
  /** 累计净现金流（元），用于画回收期视觉。 */
  cumulative: number;
}

/** 逐年现金流 → {year, flow, cumulative}[]（累计为前缀和）。空输入 → []。 */
export function cashFlowSeries(annualCashFlow: readonly number[]): CashFlowPoint[] {
  const out: CashFlowPoint[] = [];
  let cum = 0;
  for (let i = 0; i < annualCashFlow.length; i++) {
    const f = annualCashFlow[i];
    // 非有限项按 0 计入累计以免 NaN 污染整条曲线，但仍原样保留 flow 供 tooltip 显「—」。
    cum += Number.isFinite(f) ? f : 0;
    out.push({ year: i, flow: f, cumulative: cum });
  }
  return out;
}

export interface NamedValue {
  name: string;
  value: number;
}

/** CAPEX 分解（仅三类实物分量，毛/补贴/净不进条形，另在指标卡呈现）。 */
export function capexItems(capex: CapexBreakdown): NamedValue[] {
  return [
    { name: "光伏", value: capex.pv },
    { name: "储能", value: capex.storage },
    { name: "充电桩", value: capex.charger },
  ];
}

/** 首年 OPEX 分解。 */
export function opexItems(opex: OpexBreakdownY1): NamedValue[] {
  return [
    { name: "光伏运维", value: opex.pv },
    { name: "储能运维", value: opex.storage },
    { name: "桩运维", value: opex.charger },
    { name: "场站固定", value: opex.depotFixed },
  ];
}

/** 首年收入分解。 */
export function revenueItems(rev: RevenueBreakdownY1): NamedValue[] {
  return [
    { name: "充电收入", value: rev.charging },
    { name: "余电上网", value: rev.pvExport },
    { name: "运营补贴", value: rev.operationSubsidy },
  ];
}

/** 首年"钱从哪来 / 花到哪去"总览（收入 vs 能耗成本 vs 运维成本），供分组柱状对比。 */
export function year1MoneyComparison(calc: CalcResultOk): NamedValue[] {
  return [
    { name: "收入", value: calc.revenueY1.gross },
    { name: "购电成本", value: calc.energyCostY1 },
    { name: "运维成本", value: calc.opexY1.gross },
  ];
}

/** 首年能量平衡（光伏自用 / 余电上网 / 下网用电），供占比条形/饼。 */
export function energyBalanceItems(tech: TechFirstYearResult): NamedValue[] {
  return [
    { name: "光伏自用", value: tech.selfConsumedY1Kwh },
    { name: "余电上网", value: tech.pvExportY1Kwh },
    { name: "电网下网", value: tech.gridImportY1Kwh },
  ];
}

export interface TornadoBar {
  key: string;
  label: string;
  unit: string;
  deltaPct: number;
  /** 低值相对基线的位移（lowMetric − base；null = 指标算不出，如实沉底）。 */
  deltaLow: number | null;
  /** 高值相对基线的位移（highMetric − base）。 */
  deltaHigh: number | null;
  /** 摆幅（high − low，可正可负）。 */
  swing: number | null;
  /** |摆幅| 归一化到本次最大摆幅（0–1），供画条宽。 */
  normalized: number | null;
  /** 基线指标值（元），供图表中心参考线。 */
  base: number | null;
}

/**
 * 龙卷风数据 → 相对基线的位移条（保持引擎给的 |swing| 降序）。
 * base = tornado.baseValue；行内缺失（swing=null）如实保留 null，交给 UI 排尾显「—」。
 */
export function tornadoSeries(tornado: TornadoResult): TornadoBar[] {
  const base = tornado.baseValue;
  return tornado.rows.map((r: TornadoRow) => ({
    key: r.key,
    label: r.label,
    unit: r.unit ?? "",
    deltaPct: r.deltaPct,
    deltaLow: r.lowMetric != null && base != null ? r.lowMetric - base : null,
    deltaHigh: r.highMetric != null && base != null ? r.highMetric - base : null,
    swing: r.swing,
    normalized: r.normalized ?? null,
    base,
  }));
}

/* ────────────────────────────── 指标卡 ────────────────────────────── */

export type Tone = "pos" | "neg" | "warn" | "muted";

export interface MetricCard {
  key: string;
  label: string;
  value: string;
  tone: Tone;
  hint?: string;
}

/** 从 CalcResult 抽出四张核心指标卡 + 盈亏平衡单价（全部程序算，LLM 不参与，§7）。
 *  `discountRate`（小数）可选，仅用于 IRR 卡的着色分档（≥折现率绿、<折现率黄），不改任何数值。 */
export function summaryCards(calc: CalcResultOk, discountRate?: number): MetricCard[] {
  const m = calc.metrics;

  const npvCard: MetricCard = {
    key: "npv",
    label: "净现值 NPV",
    value: formatMoney(m.npv),
    tone: bad(m.npv) ? "muted" : m.npv >= 0 ? "pos" : "neg",
    hint: bad(m.npv) ? "折现率/现金流异常，算不出" : m.npv < 0 ? "按此参数集项目净值为负" : undefined,
  };

  let irrValue = "—";
  let irrTone: Tone = "muted";
  let irrHint: string | undefined;
  if (m.irr.ok && typeof m.irr.value === "number") {
    irrValue = formatPct(m.irr.value);
    const beatsDiscount = discountRate == null || m.irr.value >= discountRate;
    irrTone = beatsDiscount ? "pos" : "warn";
    if (m.irr.multipleRootsPossible) irrHint = "现金流符号多次变化，可能存在多个 IRR 根，谨慎解读";
  } else {
    irrHint = `算不出（${m.irr.reason ?? "unknown"}）`;
  }
  const irrCard: MetricCard = { key: "irr", label: "内部收益率 IRR", value: irrValue, tone: irrTone, hint: irrHint };

  const pb = m.discountedPaybackYears;
  const paybackCard: MetricCard = {
    key: "payback",
    label: "动态回收期",
    value: formatYears(pb),
    tone: pb === null ? "neg" : bad(pb) ? "muted" : "pos",
    hint: m.simplePaybackYears != null ? `静态回收约 ${m.simplePaybackYears.toFixed(2)} 年` : undefined,
  };

  const roiCard: MetricCard = {
    key: "roi",
    label: "投资回报率 ROI",
    value: roiValue(m.roi),
    tone: m.roi.ok ? "pos" : "muted",
    hint: m.roi.ok ? undefined : `算不出（${m.roi.reason ?? "unknown"}）`,
  };

  const beCard: MetricCard = {
    key: "breakeven",
    label: "盈亏平衡充电单价",
    value: calc.breakEvenChargingPriceY1 == null ? "—" : `${calc.breakEvenChargingPriceY1.toFixed(4)} 元/kWh`,
    tone: calc.breakEvenChargingPriceY1 == null ? "muted" : "muted",
    hint: "首年覆盖购电+运维所需最低充电单价（简化口径，仅供参考）",
  };

  return [npvCard, irrCard, paybackCard, roiCard, beCard];
}

function roiValue(roi: CalcResultOk["metrics"]["roi"]): string {
  if (roi.ok && typeof roi.value === "number") {
    // ROI 引擎给的是倍数（inflow/capex）→ 百分比更直观。
    return formatPct(roi.value);
  }
  return "—";
}

/* ────────────────────────────── 总装配 ────────────────────────────── */

export interface SandboxViewModel {
  viewVersion: string;
  ok: boolean;
  /** 引擎整体失败时的诚实信息（供 UI 出错误卡，不画脏图）。 */
  error?: { reason: string; detail: string; missingInputs?: string[]; invalidInputs?: string[] };
  calcRef?: string;
  engineVersions?: CalcResultOk["engineVersions"];
  needsProfessionalReview?: boolean;
  notes?: string[];
  cards?: MetricCard[];
  cashFlow?: CashFlowPoint[];
  capex?: NamedValue[];
  opex?: NamedValue[];
  revenue?: NamedValue[];
  year1Money?: NamedValue[];
  energyBalance?: NamedValue[];
  tornado?: TornadoBar[];
  mostSensitiveLabel?: string | null;
  meta?: {
    projectLifeYears: number;
    capexNetLabel: string;
    capexGrossLabel: string;
    subsidyLabel: string;
    opexY1Label: string;
    revenueY1Label: string;
    pvSelfConsumptionLabel: string;
    renewableFractionLabel: string;
  };
}

export interface ViewModelInput {
  calc: CalcResult;
  /** 可选技术能量结果（能量平衡图用）；缺省则跳过该图，不影响经济图。 */
  tech?: TechFirstYearResult | null;
  /** 可选敏感性龙卷风（基线锚定，§14 #8）。 */
  tornado?: TornadoResult | null;
  /** 折现率（小数，供 IRR 卡判正负着色；缺省不着色分档）。 */
  discountRate?: number;
}

/**
 * 组装整套视图模型。`calc.ok=false`（tech_error / missing / invalid）时只回诚实错误卡，
 * 不产出任何脏图表数据——UI 据此显示「参数不足以出图」而非画半张错图。
 */
export function buildSandboxViewModel(input: ViewModelInput): SandboxViewModel {
  const { calc, tech, tornado } = input;

  if (!calc.ok) {
    return {
      viewVersion: VIEW_VERSION,
      ok: false,
      calcRef: calc.calcRef,
      error: {
        reason: calc.reason,
        detail: calc.detail,
        missingInputs: calc.missingInputs,
        invalidInputs: calc.invalidInputs,
      },
    };
  }

  return {
    viewVersion: VIEW_VERSION,
    ok: true,
    calcRef: calc.calcRef,
    engineVersions: calc.engineVersions,
    needsProfessionalReview: calc.needsProfessionalReview,
    notes: calc.notes,
    cards: summaryCards(calc, input.discountRate),
    cashFlow: cashFlowSeries(calc.annualCashFlow),
    capex: capexItems(calc.capex),
    opex: opexItems(calc.opexY1),
    revenue: revenueItems(calc.revenueY1),
    year1Money: year1MoneyComparison(calc),
    energyBalance: tech ? energyBalanceItems(tech) : undefined,
    tornado: tornado ? tornadoSeries(tornado) : undefined,
    mostSensitiveLabel: tornado
      ? tornado.rows.find((r) => r.key === tornado.mostSensitiveKey)?.label ?? null
      : undefined,
    meta: {
      projectLifeYears: calc.annualCashFlow.length - 1,
      capexNetLabel: formatMoney(calc.capex.net),
      capexGrossLabel: formatMoney(calc.capex.gross),
      subsidyLabel: formatMoney(calc.capex.constructionSubsidy),
      opexY1Label: formatMoney(calc.opexY1.gross),
      revenueY1Label: formatMoney(calc.revenueY1.gross),
      pvSelfConsumptionLabel: tech ? formatPctRaw(tech.pvSelfConsumptionRatePct) : "—",
      renewableFractionLabel: tech ? formatPctRaw(tech.renewableFractionPct) : "—",
    },
  };
}
