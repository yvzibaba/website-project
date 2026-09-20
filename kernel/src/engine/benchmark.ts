/**
 * Benchmark 层 —— 行业/地区**基准参数**的单一注册表（带来源、时点、置信度、适用地区）。
 *
 * ## 为什么参数系统必须分层（这是 V2 与 V1 最重要的差别之一）
 *
 * V1 把「行业基准」和「客户项目条件」混在同一批参数里，后果是：
 *   - 改一个行业成本假设，会悄悄改掉所有项目的结论，且没人知道改了哪一层；
 *   - 客户没给的条件被行业平均值填上，看起来完整、其实是假数据。
 *
 * V2 把值域拆成五类（见 `types.ts`），本文件只负责其中的 **BENCHMARK** 与 **UNKNOWN**：
 *   - `BENCHMARK`：外部世界的事实/行情（电价、设备价格、等效小时…），带来源与时点；
 *   - `UNKNOWN`  ：确实存在但**没有可核实数值**的参数（如官方价表缺失）。
 *
 * ## 诚实闸门（沿用既有证据体系的口径，不另造一套）
 *
 * 一条基准只有在提供**合法 http(s) 来源链接**时才允许标 `FACT`；否则一律 `ASSUMPTION`。
 * 这条规则在 `verifiedFact()` 里强制执行，不是靠人记得。理由：一旦「无来源的数字」被标成事实，
 * 后面所有报告的可信度都被它拉平，而且没人能事后分辨哪些是真的。
 *
 * ## 本版本的证据来源
 *
 * 与本仓库既有已核实目录（`region-facts.ts` 的山西条款级事实）**同源**：
 *   - 分时电价的**浮动比例**（峰 = 平 × 1.60、谷 = 平 × 0.45、尖峰 = 峰 × 1.20、深谷 = 谷 × 0.80）
 *     是官方条款原文 → `FACT`，可点开核验；
 *   - 集中式充换电设施**免收需量电费**（2030 年前）是官方条款原文 → 山西需量电费按 0 计 → `FACT`；
 *   - 充电服务费**实行市场调节价**（由经营者自主定价）是官方条款原文 → `FACT`；
 *     也正因为它由市场调节，**行业服务费水平的绝对值没有官方来源** → 该参数标 `UNKNOWN`。
 *
 * 反过来，官方**没有**直接给绝对值的那些（平段基价、需量电价的绝对数、光伏等效小时），
 * 一律保持 `ASSUMPTION` / `UNKNOWN`，并写清缺的是什么——绝不把"比例"折算成"绝对值"来凑数。
 */

import type { BenchmarkRef, ValueClass } from "@app/kernel/engine/types";

/** 基准注册表版本（改任一基准值/证据等级/适用地区 = 须升版，报告头会打印它）。 */
export const BENCHMARK_VERSION = "1.0.0";

/* ───────────────────────── 诚实闸门 ───────────────────────── */

/** 仅接受合法 http(s)、去空白非空、无空格的链接；其余一律回 undefined。 */
function usableUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const t = url.trim();
  if (t === "" || /\s/.test(t)) return undefined;
  return /^https?:\/\//i.test(t) ? t : undefined;
}

/** 来源元数据（与 `parameter-engine.ValueSourceMeta` 同口径，但此处是基准层自己的注册项）。 */
interface BenchmarkSeed {
  key: string;
  label: string;
  unit: string;
  value: number | null;
  textValue?: string;
  valueClass: ValueClass;
  source: string;
  evidenceKind: "FACT" | "ASSUMPTION" | "INFERENCE" | "PREDICTION";
  confidence: number;
  validFrom?: string;
  validTo?: string;
  sourceUrl?: string;
  note?: string;
  regionId?: string;
}

/**
 * 构造一条基准：`FACT` 声明若缺合法链接 → **降级为 `ASSUMPTION`**并在 note 留痕。
 * 这是"诚实闸门"，不是校验器；它永远返回一条可用记录，只是不让你把无来源的东西称事实。
 */
function entry(seed: BenchmarkSeed): BenchmarkRef {
  const url = usableUrl(seed.sourceUrl);
  let evidenceKind = seed.evidenceKind;
  const notes: string[] = [];
  if (seed.note) notes.push(seed.note);
  if (evidenceKind === "FACT" && !url) {
    evidenceKind = "ASSUMPTION";
    notes.push("（未提供可核验的官方链接，已按示例值对待）");
  }
  if (seed.valueClass === "UNKNOWN" && seed.value !== null) {
    throw new Error(`基准 ${seed.key}: UNKNOWN 的 value 必须为 null`);
  }
  const out: BenchmarkRef = {
    key: seed.key,
    label: seed.label,
    unit: seed.unit,
    value: seed.value,
    valueClass: seed.valueClass,
    source: seed.source,
    evidenceKind,
    confidence: seed.confidence,
  };
  if (seed.textValue) out.textValue = seed.textValue;
  if (seed.validFrom) out.validFrom = seed.validFrom;
  if (seed.validTo) out.validTo = seed.validTo;
  if (url) out.sourceUrl = url;
  if (notes.length) out.note = notes.join("；");
  if (seed.regionId) out.regionId = seed.regionId;
  return out;
}

/* ───────────────────────── 已核实来源（山西） ───────────────────────── */

const SRC_TOU =
  "https://fgw.shanxi.gov.cn/sxfgwzwgk/sxsfgwxxgk/xxgkml/tz/202602/t20260228_10069158.shtml";
const SRC_DEMAND_FREE =
  "https://myj.shanxi.gov.cn/ztzl/bwbd/xnyzk/202607/t20260716_10177998.shtml";
const SRC_SERVICE_PRICE =
  "https://fgw.shanxi.gov.cn/sxfgwzwgk/sxsfgwxxgk/xxgkml/tz/202305/t20230511_8518805.shtml";
const SRC_PV_RADIATION = "http://www.nmic.cn/site/article/id/41255.html";

/** 通用（不分地区）的工程量/经济假设来源说明。 */
const SRC_ENGINEERING = "行业工程经验区间（本仓库未取得逐条可核验的官方价表或厂商报价单）";

/* ───────────────────────── 基准注册表 ───────────────────────── */

export const BENCHMARK_ENTRIES: readonly BenchmarkRef[] = [
  /* ── 电网与电价 ── */
  entry({
    key: "grid.tou.peakMultiplier",
    label: "峰段电价倍率（× 平段）",
    unit: "×",
    value: 1.6,
    valueClass: "BENCHMARK",
    source: "山西电网分时电价机制（晋发改商品发〔2026〕15号）",
    evidenceKind: "FACT",
    confidence: 95,
    validFrom: "2026-05-01",
    sourceUrl: SRC_TOU,
    regionId: "shanxi",
    note: "官方条款给出的相对浮动比例，可直接使用",
  }),
  entry({
    key: "grid.tou.valleyMultiplier",
    label: "谷段电价倍率（× 平段）",
    unit: "×",
    value: 0.45,
    valueClass: "BENCHMARK",
    source: "山西电网分时电价机制（晋发改商品发〔2026〕15号）",
    evidenceKind: "FACT",
    confidence: 95,
    validFrom: "2026-05-01",
    sourceUrl: SRC_TOU,
    regionId: "shanxi",
  }),
  entry({
    key: "grid.tou.sharpMultiplier",
    label: "尖峰电价倍率（× 峰段）",
    unit: "×",
    value: 1.2,
    valueClass: "BENCHMARK",
    source: "山西电网分时电价机制（晋发改商品发〔2026〕15号）",
    evidenceKind: "FACT",
    confidence: 95,
    validFrom: "2026-05-01",
    sourceUrl: SRC_TOU,
    regionId: "shanxi",
  }),
  entry({
    key: "grid.tou.deepValleyMultiplier",
    label: "深谷电价倍率（× 谷段）",
    unit: "×",
    value: 0.8,
    valueClass: "BENCHMARK",
    source: "山西电网分时电价机制（晋发改商品发〔2026〕15号）",
    evidenceKind: "FACT",
    confidence: 95,
    validFrom: "2026-05-01",
    sourceUrl: SRC_TOU,
    regionId: "shanxi",
  }),
  entry({
    key: "grid.touWindows.hours",
    label: "分时时段划分（谷 / 峰 钟点）",
    unit: "",
    value: null,
    textValue: "谷段 23:00-07:00；峰段 08:00-11:00 与 18:00-23:00；其余为平段",
    valueClass: "BENCHMARK",
    source: "山西分时电价的四季时段表（官方文件给出时段表，本仓库尚未把四季划分录入为结构化数据）",
    evidenceKind: "ASSUMPTION",
    confidence: 40,
    sourceUrl: SRC_TOU,
    regionId: "shanxi",
    note: "浮动比例已核实，但四季时段的具体钟点尚未结构化录入，当前用一个通用的谷/峰划分参与计算，须人工按官方时段表复核",
  }),
  entry({
    key: "grid.flatPriceYuanPerKwh",
    label: "平段基准电价（含税全口径）",
    unit: "元/kWh",
    value: 0.55,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
    validFrom: "2026-09",
    regionId: "shanxi",
    note: "官方文件只规定浮动比例、未提供绝对平段基价，因此绝对价暂无官方来源，当前以示例值参与计算，须按当地最新目录电价或结算单价核实",
  }),
  entry({
    key: "grid.demandChargePerKwMonth",
    label: "需量电费（集中式充换电设施）",
    unit: "元/kW·月",
    value: 0,
    valueClass: "BENCHMARK",
    source: "山西新能源（电动）重卡产业圈建设行动方案（交规划发〔2026〕52号）",
    evidenceKind: "FACT",
    confidence: 90,
    validFrom: "2026-09-08",
    validTo: "2030-12-31",
    sourceUrl: SRC_DEMAND_FREE,
    regionId: "shanxi",
    note: "官方原文为「2030 年前对实行两部制电价的集中式充换电设施用电免收需量（容量）电费」，故按 0 计；不属于集中式充换电设施或免征到期时须改为实际值",
  }),
  entry({
    key: "grid.demandChargeNominalYuanPerKwMonth",
    label: "需量电价名义水平（未享免征时的工商业口径）",
    unit: "元/kW·月",
    value: null,
    valueClass: "UNKNOWN",
    source: "官方无绝对数值文本（相关文件只表述折扣与免收的结构性条款）",
    evidenceKind: "ASSUMPTION",
    confidence: 20,
    regionId: "shanxi",
    note: "缺官方价表，无法给出可核实数值；如需按名义口径做对照，请由用户输入当地实际结算的需量电价",
  }),
  entry({
    key: "grid.feedInTariffYuanPerKwh",
    label: "余电上网电价",
    unit: "元/kWh",
    value: 0.35,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 30,
    regionId: "shanxi",
    note: "燃煤基准价与市场化交易均价未取得可核验来源，当前以示例值参与计算",
  }),

  /* ── 光伏 ── */
  entry({
    key: "pv.specificYieldKwhPerKwp",
    label: "光伏年等效利用小时（交流侧）",
    unit: "kWh/kWp·年",
    value: 1170,
    valueClass: "BENCHMARK",
    source: "山西省太阳能资源年际公报（分区年辐射量区间）+ 行业转引的近年实际利用小时",
    evidenceKind: "ASSUMPTION",
    confidence: 40,
    validFrom: "2026-09",
    sourceUrl: SRC_PV_RADIATION,
    regionId: "shanxi",
    note: "官方口径给的是年辐射量区间，与「等效利用小时」不是同一口径，不做折算；当前取近年实际利用小时作为示例值，须人工核实",
  }),
  entry({
    key: "pv.degradationPctPerYear",
    label: "光伏年衰减率",
    unit: "%/年",
    value: 0.55,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 45,
  }),

  /* ── 储能 ── */
  entry({
    key: "bess.roundTripEfficiencyPct",
    label: "储能往返效率（交流侧）",
    unit: "%",
    value: 90,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 50,
  }),
  entry({
    key: "bess.socMinPct",
    label: "储能 SOC 下限",
    unit: "%",
    value: 10,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 60,
  }),
  entry({
    key: "bess.socMaxPct",
    label: "储能 SOC 上限",
    unit: "%",
    value: 90,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 60,
  }),
  entry({
    key: "bess.degradationPctPerYear",
    label: "储能年容量衰减",
    unit: "%/年",
    value: 2.5,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 40,
  }),

  /* ── 重卡与充换电 ── */
  entry({
    key: "truck.energyConsumptionKwhPerKm",
    label: "重卡单位能耗（标准工况）",
    unit: "kWh/km",
    value: 1.4,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 40,
    note: "受载重、路况、气温影响较大，须按目标车型与线路实测修正",
  }),
  entry({
    key: "truck.seasonalFactorPct",
    label: "季节能耗增幅（冬季峰值）",
    unit: "%",
    value: 18,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
  }),
  entry({
    key: "truck.routeFactorPct",
    label: "线路能耗修正（山区/重载）",
    unit: "%",
    value: 10,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
  }),
  entry({
    key: "truck.reserveFactorPct",
    label: "电量保留系数",
    unit: "%",
    value: 15,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 55,
  }),
  entry({
    key: "charging.chargingEfficiencyPct",
    label: "充电链路效率（电网侧到电池侧）",
    unit: "%",
    value: 92,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 55,
  }),
  entry({
    key: "charging.simultaneousRatePct",
    label: "充电同时率",
    unit: "%",
    value: 85,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 40,
  }),
  entry({
    key: "charging.serviceFeeLevelYuanPerKwh",
    label: "充电服务费市场水平",
    unit: "元/kWh",
    value: null,
    valueClass: "UNKNOWN",
    source: "电动汽车充换电服务费实行市场调节价（晋发改商品发〔2023〕134号）",
    evidenceKind: "FACT",
    confidence: 90,
    validFrom: "2023-05-11",
    sourceUrl: SRC_SERVICE_PRICE,
    regionId: "shanxi",
    note: "官方明确服务费由经营者自主定价，故行业水平没有官方数值；本参数须由用户按自身经营策略输入",
  }),

  /* ── 投资与成本 ── */
  entry({
    key: "economics.pvCapexYuanPerW",
    label: "光伏单位投资",
    unit: "元/W",
    value: 3.2,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
    note: "未取得厂商报价单，须按实际招标价修正",
  }),
  entry({
    key: "economics.bessCapexYuanPerWh",
    label: "储能单位投资",
    unit: "元/Wh",
    value: 1.0,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
  }),
  entry({
    key: "economics.chargerCapexYuanPerKw",
    label: "充电设施单位投资",
    unit: "元/kW",
    value: 700,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
  }),
  entry({
    key: "economics.swapStationCapexYuanPerStation",
    label: "换电站单位投资",
    unit: "元/站",
    value: 4000000,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 25,
  }),
  entry({
    key: "economics.gridCapexYuanPerKw",
    label: "并网与增容单位投资",
    unit: "元/kW",
    value: 600,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 30,
  }),
  entry({
    key: "economics.civilCapexYuanPerChargerKw",
    label: "土建及其他单位投资（按充电装机）",
    unit: "元/kW",
    value: 300,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 30,
  }),
  entry({
    key: "economics.pvOpexYuanPerKwpYear",
    label: "光伏年运维",
    unit: "元/kWp·年",
    value: 60,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 40,
  }),
  entry({
    key: "economics.bessOpexYuanPerKwhYear",
    label: "储能年运维",
    unit: "元/kWh·年",
    value: 30,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
  }),
  entry({
    key: "economics.chargerOpexYuanPerKwYear",
    label: "充电设施年运维",
    unit: "元/kW·年",
    value: 40,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
  }),
  entry({
    key: "economics.siteFixedOpexYuanPerYear",
    label: "场站固定年运维",
    unit: "元/年",
    value: 200000,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 30,
  }),
  entry({
    key: "economics.landRentYuanPerYear",
    label: "土地年租金",
    unit: "元/年",
    value: 300000,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 25,
    note: "工业用地基准地价尚未取得可核验来源，须按实际租约修正",
  }),
  entry({
    key: "economics.insurancePctOfCapex",
    label: "保险及管理费率",
    unit: "%/年",
    value: 0.8,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 35,
  }),

  /* ── 财务假设 ── */
  entry({
    key: "economics.contingencyPct",
    label: "预备费率（占直接工程投资）",
    unit: "%",
    value: 3,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 40,
    note: "工程概算惯例取值，非官方价表；初步可行性阶段可用，进入投资决策前须按实际概算替换",
  }),
  entry({
    key: "economics.discountRatePct",
    label: "折现率（税后）",
    unit: "%",
    value: 6,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 40,
    note: "应取企业实际加权资本成本，当前为示例值",
  }),
  entry({
    key: "economics.inflationPct",
    label: "通胀率",
    unit: "%/年",
    value: 2,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 40,
  }),
  entry({
    key: "economics.incomeTaxPct",
    label: "企业所得税率",
    unit: "%",
    value: 25,
    valueClass: "BENCHMARK",
    source: "《中华人民共和国企业所得税法》法定税率 25%",
    evidenceKind: "FACT",
    confidence: 90,
    note: "法定税率；是否享受优惠（如高新技术、西部大开发）须按企业实际情况确认",
  }),
  entry({
    key: "economics.residualValuePct",
    label: "期末残值率",
    unit: "%",
    value: 5,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 30,
  }),
  entry({
    key: "economics.equityRatioPct",
    label: "资本金比例",
    unit: "%",
    value: 30,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 30,
  }),
  entry({
    key: "economics.loanInterestPct",
    label: "贷款利率",
    unit: "%/年",
    value: 4.5,
    valueClass: "BENCHMARK",
    source: SRC_ENGINEERING,
    evidenceKind: "ASSUMPTION",
    confidence: 30,
  }),
];

/* ───────────────────────── 查询 ───────────────────────── */

/** 地区匹配优先级：精确地区 > 全国通用 > 全局。 */
const GENERIC_REGIONS = new Set(["national", "global", ""]);

/**
 * 取一条基准（按地区择优）。同一 key 若同时存在地区专属与通用条目，**地区专属胜**。
 * 找不到 → undefined（调用方负责降级并登记诊断，绝不返回 0 冒充）。
 */
export function getBenchmark(key: string, regionId?: string): BenchmarkRef | undefined {
  const candidates = BENCHMARK_ENTRIES.filter((e) => e.key === key);
  if (candidates.length === 0) return undefined;
  if (regionId) {
    const exact = candidates.find((e) => e.regionId === regionId);
    if (exact) return exact;
  }
  const generic = candidates.find((e) => !e.regionId || GENERIC_REGIONS.has(e.regionId));
  return generic ?? candidates[0];
}

/**
 * 取数值型基准。**UNKNOWN（value === null）一律返回 undefined**——
 * 调用方必须把它当成"没有这个数"，而不是"这是 0"。
 */
export function benchmarkNumber(key: string, regionId?: string): number | undefined {
  const e = getBenchmark(key, regionId);
  if (!e) return undefined;
  return e.value === null ? undefined : e.value;
}

/** 该基准是否已被显式标记为未知（缺口），供诊断层区分「缺证据」与「缺输入」。 */
export function isBenchmarkUnknown(key: string, regionId?: string): boolean {
  const e = getBenchmark(key, regionId);
  return !!e && e.valueClass === "UNKNOWN";
}

/**
 * 生成一份**本次计算实际引用**的基准快照（键 → 带来源的引用）。
 * 报告与持久化层存它，用于回答"这组数是按哪一版行情算出来的"。
 */
export function benchmarkSnapshot(keys: readonly string[], regionId?: string): Record<string, BenchmarkRef> {
  const out: Record<string, BenchmarkRef> = {};
  for (const k of keys) {
    const e = getBenchmark(k, regionId);
    if (e) out[k] = e;
  }
  return out;
}

/** 列出某地区可见的全部基准（含通用），供基准管理页/审计使用。 */
export function listBenchmarks(regionId?: string): BenchmarkRef[] {
  const out: BenchmarkRef[] = [];
  const seen = new Set<string>();
  for (const e of BENCHMARK_ENTRIES) {
    if (e.regionId && regionId && e.regionId !== regionId && !GENERIC_REGIONS.has(e.regionId)) continue;
    if (seen.has(e.key)) continue;
    const best = getBenchmark(e.key, regionId);
    if (best && !seen.has(best.key)) {
      seen.add(best.key);
      out.push(best);
    }
  }
  return out;
}

/** 汇总覆盖率：本次计算实际用到、且**证据等级为 FACT** 的基准占比（报告"数据可信度"用）。 */
export function evidenceCoverage(snapshot: Record<string, BenchmarkRef>): {
  total: number;
  fact: number;
  unknown: number;
  factPct: number;
  meanConfidence: number;
} {
  const all = Object.values(snapshot);
  const fact = all.filter((e) => e.evidenceKind === "FACT").length;
  const unknown = all.filter((e) => e.valueClass === "UNKNOWN").length;
  const conf = all.length ? all.reduce((s, e) => s + e.confidence, 0) / all.length : 0;
  return {
    total: all.length,
    fact,
    unknown,
    factPct: all.length ? Math.round((fact / all.length) * 1000) / 10 : 0,
    meanConfidence: Math.round(conf),
  };
}
