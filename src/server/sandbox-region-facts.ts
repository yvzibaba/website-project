import type { ValueSourceMeta } from "@/server/parameter-engine";

/**
 * 沙盘「地区 / 政策参数」的**逐值来源编目**（中途重构 R8.7 · 真实数据接入）。
 *
 * 为什么存在（§12 来源可追溯 / §16 事实与假设区分 / §20 诚实绝不虚构来源 / 总控最高优先级「商业闭环·数据真实」）：
 *   R5 的 `sandbox-regions.ts` 把山西的电价/光照/补贴等作为**层级 `source` 自由文本**给了值，但整层共用一句
 *   `【示例·待核实】`——它**无法回答「这一具体数字，出自哪份可点击核验的官方文件、截止何时」**。R8.7 把参数引擎
 *   （`ValueLayer.sources`）升级到能承载**逐值结构化溯源**后，本文件即成为「每个地区/政策默认值到底有没有硬来源、
 *   来源是什么」的**单一真源目录**：把 R8.5 的 ASSUMPTION→FACT 升级写路径、R8.6 的来源反查、以及报告「数据来源」区段，
 *   全部钉在同一份可维护的目录上，避免各处各自塞 URL 造成漂移。
 *
 * ⚠️ 本里程碑的**诚实基线（§20，创始人 2026-09-06 判断）**：
 *   在离线研发环境里，山西各项地区/政策默认值**尚未逐条比对到可直接引用、可点开核验的权威原文**（发改委 / 电网公司 /
 *   统计公报等）。因此本目录里**每一条现存条目都仍标 `evidenceKind="ASSUMPTION"`、不带 `sourceUrl`**——
 *   **绝不为凑「已接入真实数据」而编造链接或把未核实值升为 FACT**（那将违反宪法第 20 条，比维持假设更糟）。
 *   本目录交付的是**接入机制 + 可维护骨架**：一旦人工核实到权威来源，把对应条目用 `makeVerifiedFact(...)` 换成
 *   带真实 http(s) 链接的 FACT 即可**自动贯通**「地区默认→解析值溯源→`CalcResult.inputProvenance`→方案草案
 *   `sourceUrl`→R8.5 升级写路径→详情/反查可见」这条闭环，无需再改任何引擎/编排代码。
 *
 * 与参数目录的关系（§16）：只使用 `SANDBOX_PARAMS` 里**已注册的键**，且**只给溯源元数据、不重复给数值**
 *   （数值仍只在 `sandbox-regions.ts` 的 `values` 里，防双写漂移）。键合法性由 `tests/unit/sandbox-region-facts.test.ts` 守。
 */

/** 地区来源编目版本（增删条目 / 换 FACT 须升版并记原因，宪法第 13 条）。
 *  1.1.0（阶段3A）：新增**条款级** `SHANXI_CLAUSE_FACTS`（5 条政策/资源条款 FACT，全部经 makeVerifiedFact
 *   管道、带可点击权威原文）。⚠️ 诚实边界（§20 / 阶段3A 指令三、四）：条款是 FACT ≠ 模型数值是 FACT——
 *   逐值 `SHANXI_REGION_SOURCES` / `SHANXI_POLICY_SOURCES` **仍全为 ASSUMPTION**（0.55/0.7/1400/44/500
 *   等占位数值无一能被条款单独验证），三处口径冲突以 DATA_CONFLICT 原样保留、禁折算/平均/改公式。
 */
export const SANDBOX_REGION_FACTS_VERSION = "1.1.0";

/** 溯源引用（供报告标注「这组地区来源是按哪版给的」，第 7/16 条）。 */
export function regionFactsCalcRef(): string {
  return `region-facts@${SANDBOX_REGION_FACTS_VERSION}`;
}

/** 未核实条目共用的诚实说明（一眼可见"仍是假设、待替换为可点击权威来源"，第 20 条）。 */
const PENDING = "【待核实】尚无逐条可点击核验的权威原文，保持示例假设；核实后请用 makeVerifiedFact 换成本条并升 FACT";

/** 一条 ASSUMPTION 占位溯源（地区/政策值的诚实缺省形态）。 */
function pending(sourceType = "示例假设"): ValueSourceMeta {
  return { evidenceKind: "ASSUMPTION", sourceType, note: PENDING };
}

/**
 * **升级接缝**：把一条来源升为可核验 FACT 的唯一入口。刻意把「§20 诚实闸门」前移到编目写入时——
 * 只有提供合法 http(s) `sourceUrl` 才产出 FACT 条目；缺链接/伪协议/含空格一律返回 `null`，
 * 调用方（人或后续 seed 脚本）据此知难而退、不得写入未核来源（宁可误拒，不可误收）。
 * 纯函数、无副作用。
 */
export function makeVerifiedFact(
  sourceUrl: string,
  opts: { sourceType?: string; asOf?: string; confidence?: number; note?: string } = {},
): ValueSourceMeta | null {
  const url = typeof sourceUrl === "string" ? sourceUrl.trim() : "";
  if (url === "" || /\s/.test(url) || !/^https?:\/\//i.test(url)) return null;
  const confidence = opts.confidence ?? 85;
  const clamped = Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.trunc(confidence))) : 85;
  const meta: ValueSourceMeta = {
    sourceUrl: url,
    evidenceKind: "FACT",
    confidence: clamped,
  };
  if (opts.sourceType) meta.sourceType = opts.sourceType;
  if (opts.asOf) meta.asOf = opts.asOf;
  if (opts.note) meta.note = opts.note;
  return meta;
}

/* ─────────────────────────── 全国通用（无覆写 → 无逐值来源） ─────────────────────────── */

/** 通用包不覆写任何地区/政策值，故无逐值来源可挂（沿用 R1.2 全局默认占位假设）。 */
export const NATIONAL_REGION_SOURCES: Readonly<Record<string, ValueSourceMeta>> = {};
export const NATIONAL_POLICY_SOURCES: readonly (Readonly<Record<string, ValueSourceMeta>> | undefined)[] = [];

/* ─────────────────────────── 山西（V1 首个候选省 · 全部待核实 = ASSUMPTION） ─────────────────────────── */

/**
 * 山西**地区层**逐值溯源（键须与 `sandbox-regions.ts` 的 `SHANXI_PACK.region.values` 对齐）。
 * 现全为 ASSUMPTION 占位（诚实基线，见文件头）。核实到权威原文后，把对应 `pending()` 换成
 * `makeVerifiedFact("https://…", { sourceType, asOf })` 即自动升 FACT 并贯通下游。
 */
export const SHANXI_REGION_SOURCES: Readonly<Record<string, ValueSourceMeta>> = {
  "region.elecPrice": pending("工商业电价·待核（省发改委/电网目录销售电价）"),
  "region.peakValleySpread": pending("峰谷价差·待核（省发改委分时电价通知）"),
  "region.pvEquivalentHours": pending("光伏等效利用小时·待核（能源局/电网消纳公报）"),
  "region.demandCharge": pending("需量(容量)电价·待核"),
  "region.landRent": pending("土地年租金·待核（工业用地基准地价）"),
};

/**
 * 山西**政策层**逐值溯源（数组下标须与 `SHANXI_PACK.policy` 一一对齐）：
 *   [0] = 已过期碳价试点（仅作 §6 过期回落演示，本就无现行来源可引，保持 ASSUMPTION）；
 *   [1] = 现行补贴/上网价层（待核）。
 */
export const SHANXI_POLICY_SOURCES: readonly (Readonly<Record<string, ValueSourceMeta>> | undefined)[] = [
  { "policy.carbonPrice": pending("碳价加计·已过期示例，无现行来源") },
  {
    "policy.constructionSubsidy": pending("建设补贴比例·待核（省市充电基础设施补贴办法）"),
    "policy.operationSubsidy": pending("运营补贴强度·待核"),
    "policy.feedInTariff": pending("余电上网电价·待核（燃煤基准价/市场化交易均价）"),
  },
];

/** 一个地区的逐值溯源集合（供 `sandbox-regions.ts` 在编排处 attach 到对应 ValueLayer）。 */
export interface RegionProvenance {
  region?: Readonly<Record<string, ValueSourceMeta>>;
  policy?: readonly (Readonly<Record<string, ValueSourceMeta>> | undefined)[];
}

/** 取某地区的逐值溯源；未知 id 回落「全国通用」（与 `getRegionPack` 同口径，绝不裸抛）。 */
export function getRegionProvenance(regionId: string): RegionProvenance {
  switch (regionId) {
    case "shanxi":
      return { region: SHANXI_REGION_SOURCES, policy: SHANXI_POLICY_SOURCES };
    case "national":
    default:
      return { region: NATIONAL_REGION_SOURCES, policy: NATIONAL_POLICY_SOURCES };
  }
}

/* ─────────────────────────── 条款级 FACT 目录（阶段3A · 仅山西） ─────────────────────────── */

/**
 * 一条**条款级**已核实事实（阶段3A「只激活高可信山西 FACT」）。
 *
 * 为什么是"条款"而不是"数值"（§20 诚实边界 / 阶段3A 指令一、三、四）：
 *   阶段2 核实到的 5 条高可信数据全部是**政策条款 / 官方区间**（S/A 级原文可点击），而沙盘里的
 *   逐值默认（电价 0.55、价差 0.7、小时数 1400…）没有任何一条能被这些条款**单独**验证——
 *   政策给的是相对浮动比例、模型要绝对价差（G1 缺平段基价）；辐射是区间、模型要等效小时（口径③）。
 *   故本目录只声明「这些条款本身是真的、可点开核验」，**绝不给任何数值、绝不动 `values`**；
 *   相关参数的取值仍是 ASSUMPTION，冲突原样保留（DATA_CONFLICT），等 G1/G2 人工补数后再议。
 *
 * 诚实闸门：`meta` 一律经 `makeVerifiedFact(...)` 产出（脏 URL → null → 单测红），置信度/时点
 *   沿用阶段2 `docs/verified-data/shanxi-v1.json` 的五元组，不新增任何未经核实的声明。
 */
export interface RegionClauseFact {
  /** 稳定标识（测试钉桩 / 反查用）。 */
  id: string;
  /** 条款标题（用户可见）。 */
  title: string;
  /** 发文文号（如有）。 */
  docNo?: string;
  /** 发布机关。 */
  publisher: string;
  /** 印发/发布日期（YYYY-MM-DD，展示用；可核时点用 asOf）。 */
  publishedOn?: string;
  /** 生效口径一句话（如「自 2026-05-01 起施行」「现行有效」）。 */
  effectiveText: string;
  /** 该条款与沙盘中哪些参数相关（只表"关联"以供展示，不改变这些参数的取值/证据类型）。 */
  relatedKeys: readonly string[];
  /** 逐值溯源元数据（evidenceKind=FACT + 可点击 sourceUrl），一律经 makeVerifiedFact 产出。 */
  meta: ValueSourceMeta | null;
  /** 已知口径冲突（DATA_CONFLICT）：条款口径 ≠ 模型口径，本阶段**禁折算/平均/改公式**，原样保留。 */
  dataConflict?: { key: string; description: string };
}

/** 山西**条款级**已核实事实（顺序即 UI 展示顺序；元数据全部经 makeVerifiedFact 管道）。 */
export const SHANXI_CLAUSE_FACTS: readonly RegionClauseFact[] = [
  {
    id: "shanxi-tou-2026-15",
    title: "山西电网分时电价机制（峰平谷/尖峰/深谷浮动比例 + 四季时段表）",
    docNo: "晋发改商品发〔2026〕15号",
    publisher: "山西省发展和改革委员会",
    publishedOn: "2026-02-28",
    effectiveText: "自 2026-05-01 起执行（四季时段表；峰=平×1.60、谷=平×0.45、尖峰=峰×1.20、深谷=谷×0.80）",
    relatedKeys: ["region.peakValleySpread", "region.elecPrice"],
    meta: makeVerifiedFact("https://fgw.shanxi.gov.cn/sxfgwzwgk/sxsfgwxxgk/xxgkml/tz/202602/t20260228_10069158.shtml", {
      sourceType: "政府政策文件（S级）",
      asOf: "2026-05-01",
      confidence: 95,
      note: "分时电价浮动比例与四季时段表为官方条款；未提供绝对平段基价（缺口 G1）。",
    }),
    dataConflict: {
      key: "region.peakValleySpread",
      description:
        "DATA_CONFLICT：政策给「相对平段的浮动比例」（峰=平×1.60/谷=平×0.45），模型 spread 是全口径绝对价差（元/kWh）——缺平段基价（G1）不得折算，本阶段保留冲突、禁平均/禁改公式。",
    },
  },
  {
    id: "shanxi-tnd-4th-cycle",
    title: "山西电网第四监管周期输配电价及有关事项（需量电费 90% 折扣、增量配电网充换电免容（需量）电费）",
    publisher: "山西省发展改革委（依据国家发改委发改价格〔2026〕1077号）",
    publishedOn: "2026 年",
    effectiveText: "自 2026-08-01 起（第四监管周期；月用电量≥260kWh/kVA 需量电费打 9 折）",
    relatedKeys: ["region.demandCharge"],
    meta: makeVerifiedFact("https://mpower.in-en.com/html/power-2477102.shtml", {
      sourceType: "权威行业转引（A级，另见山西晚报转载）",
      asOf: "2026-08-01",
      confidence: 85,
      note: "结构性条款（折扣/免收）为真；绝对需量电价数值无官方文本（缺口 G2）。",
    }),
    dataConflict: {
      key: "region.demandCharge",
      description:
        "DATA_CONFLICT：条款是结构性优惠（90% 折扣/免收），模型 demandCharge 是绝对需量电价（元/kW·月）——无官方价表文本（G2）不得折算，本阶段保留冲突。",
    },
  },
  {
    id: "shanxi-charging-service-2023-134",
    title: "电动汽车充换电服务费实行市场调节价（服务费由经营者自主定价）",
    docNo: "晋发改商品发〔2023〕134号",
    publisher: "山西省发展和改革委员会",
    publishedOn: "2023-05-11",
    effectiveText: "现行有效（充电服务费不实行政府定价，由市场调节）",
    relatedKeys: ["project.chargingPrice"],
    meta: makeVerifiedFact("https://fgw.shanxi.gov.cn/sxfgwzwgk/sxsfgwxxgk/xxgkml/tz/202305/t20230511_8518805.shtml", {
      sourceType: "政府政策文件（S级）",
      asOf: "2026-09-08",
      confidence: 90,
      note: "为模型「充电服务价=用户可自定的经营决策」提供政策依据；不提供具体服务费数值。",
    }),
  },
  {
    id: "shanxi-nev-truck-2026-52",
    title: "山西新能源（电动）重卡产业圈建设行动方案（11 部门联合印发）",
    docNo: "交规划发〔2026〕52号",
    publisher: "山西省交通运输厅等 11 部门",
    publishedOn: "2026-06-12",
    effectiveText: "现行有效（「2030 年前对实行两部制电价的集中式充换电设施用电免收需量（容量）电费」）",
    relatedKeys: ["region.demandCharge"],
    meta: makeVerifiedFact("https://myj.shanxi.gov.cn/ztzl/bwbd/xnyzk/202607/t20260716_10177998.shtml", {
      sourceType: "政府专题原文（S级）",
      asOf: "2026-09-08",
      confidence: 90,
      note: "免收需量电费条款为官方原文核实；属政策支持事实，不代表沙盘已按免收计价。",
    }),
  },
  {
    id: "shanxi-pv-resource-nmic",
    title: "山西省太阳能资源年际公报（分区辐射量：山西北部 ≥6300、南部 5040–6300 MJ/m²·年）",
    publisher: "山西省气象局（中国气象局公报）",
    publishedOn: "2020 公报",
    effectiveText: "气候区间口径（辐射量区间保留，不折算为单一数值）",
    relatedKeys: ["region.pvEquivalentHours"],
    meta: makeVerifiedFact("http://www.nmic.cn/site/article/id/41255.html", {
      sourceType: "官方统计公报（S级）",
      asOf: "2026-09-08",
      confidence: 80,
      note: "辐射区间为官方数据；等效利用小时为另一口径（2025 实际约 1170h，C 级转引）。",
    }),
    dataConflict: {
      key: "region.pvEquivalentHours",
      description:
        "DATA_CONFLICT：官方给「年辐射量区间（MJ/m²·年）」，模型要「等效利用小时数」——辐射≠并网实际小时（2025 实际约 1170h 仅 C 级），区间保留、禁折算成单一 FACT。",
    },
  },
];

/** 取某地区的条款级事实；未知 id / 全国通用 → 空列表（绝不裸抛）。 */
export function getRegionClauseFacts(regionId: string): readonly RegionClauseFact[] {
  switch (regionId) {
    case "shanxi":
      return SHANXI_CLAUSE_FACTS;
    default:
      return [];
  }
}
