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

/** 地区来源编目版本（增删条目 / 换 FACT 须升版并记原因，宪法第 13 条）。 */
export const SANDBOX_REGION_FACTS_VERSION = "1.0.0";

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
