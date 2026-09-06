/**
 * 沙盘「地区 / 政策参数包」目录（中途重构 R5）——《项目中途重构总控》§6「地区 / 政策」在参数层的落地。
 *
 * 为什么存在：R1/R1.2 把「地区电价 / 光照 / 补贴」等声明成了**全国性的宽区间占位默认**，并在文件头
 * 明确留下一句「真正的地区收窄在 R5 用 region ValueLayer 表达」。本文件就是那份兑现：为每个可选地区
 * 预置一组 `region` + `policy[]` 的 `ValueLayer`（默认值 + 允许覆写区间 bounds + 生效窗口），
 * 喂进已测死的 R1 `resolveParameters` 即得「选了这个地区后各参数的当前生效值 + 来源」。
 *
 * 与 R4 工作台的关系：用户「选地区」= 挑一份 pack → 其 region/policy 层垫在 user 层之下（§6 优先级
 * `user > policy > region > 全局默认`），于是**改地区 → 电价/光照/补贴默认变 → 经济结果变 → 图表变**
 * （§4 命脉的「地区」入口）。pack 里带的 `bounds` 会把滑杆可拖区间收窄到该省合理范围（§6「用户区间内覆写」）。
 *
 * ⚠️ 诚实边界（宪法第 20 条 / §16 / 创始人 2026-09-05 裁决「先山西 1 省跑通、数字标占位假设」）：
 *   - V1 只做 **1 个真实候选省（山西）+ 1 个「全国通用」兜底包**，其余省份留待后续横向扩展；
 *   - 山西包里的每一个数字**仍是"示例占位假设"**（量级取自公开常见区间、未经本项目逐条核实），
 *     故每层一律 `evidenceKind="ASSUMPTION"`、`confidence≤50`、`source` 带 `【示例·待核实】` 前缀——
 *     与 R1.2「默认即假设」同一口径，**绝不当 FACT 对外表述**，报告/图表据此标注需专业人工确认；
 *   - 本目录是**版本化的纯数据 + 纯函数**（可离线测死、可回滚），刻意**不落数据库**：地区默认先以代码目录
 *     形态存在（对齐 §14「参数系统 / 地区政策」优先于自动化 / 落库，且宪法「禁因终局宏大提前做复杂 V1」）。
 *     未来若要运营侧自助改地区默认，再把本目录 seed 进 Region 表（属后续里程碑，非 R5 阻塞项）。
 *
 * 命名与键：只使用 R1.2 `SANDBOX_PARAMS` 里**已注册的键**（如 `region.elecPrice`、`policy.feedInTariff`），
 * pack 不新增参数、只给地区/政策层的取值与区间，避免与参数目录漂移（第 16 条单一真源）。
 */
import type { ResolveLayers, ValueLayer } from "@/server/parameter-engine";
import { SHANXI_REGION_SOURCES, SHANXI_POLICY_SOURCES } from "@/server/sandbox-region-facts";

/**
 * 地区参数包目录版本（增删地区 / 改默认口径须升版并记原因，宪法第 13 条）。
 * 1.1.0（R8.7）：山西 region/policy 层挂上来自 `sandbox-region-facts` 的**逐值结构化溯源** `sources`
 *   （数值一字未改，现全为诚实 ASSUMPTION 占位；核实到权威原文后仅改编目即自动升 FACT 并贯通下游）。
 */
export const SANDBOX_REGIONS_VERSION = "1.1.0";

/** 溯源引用（供报告标注「这组地区默认是按哪版给的」，第 7/16 条）。 */
export function regionCalcRef(): string {
  return `regions@${SANDBOX_REGIONS_VERSION}`;
}

/** 每个地区默认共用的来源前缀——一眼可见"未经核实、非事实"（第 20 条）。 */
const SRC = "【示例·待核实】V1 取该省公开常见量级跑通链路，非经核事实，须逐项替换为可追溯来源";

/** 一份「地区 / 政策参数包」= 展示元数据 + region 层 + 若干 policy 层（各带生效窗口）。 */
export interface SandboxRegionPack {
  /** 稳定标识（前端下拉值 / 持久化引用）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 一句话说明（选地区时展示）。 */
  summary: string;
  /** 诚实脚注（该包数据性质，报告/页面标注用）。 */
  note: string;
  /** 地区默认层（电价 / 光照 / 需量 / 地价 + 收窄的覆写区间 bounds）。 */
  region: ValueLayer;
  /** 政策默认层列表（可空；按给定顺序后者覆盖前者，但都要过有效期——§6）。 */
  policy: ValueLayer[];
}

/* ─────────────────────────── 全国通用（兜底 = R1.2 全局默认，零覆写） ─────────────────────────── */

/** 通用包：不覆写任何地区/政策值，`resolveSandbox` 落回 R1.2 全局默认（与 R2/R4 黄金基线逐字一致）。 */
const NATIONAL_PACK: SandboxRegionPack = {
  id: "national",
  name: "全国通用",
  summary: "不预置地区差异，采用沙盘全局默认参数（示例占位）。",
  note: "所有取值即沙盘默认占位假设，未做任何地区收窄。",
  region: { values: {} },
  policy: [],
};

/* ─────────────────────────── 山西（V1 首个候选省） ─────────────────────────── */

/**
 * 山西包（示例占位，量级取自公开常见区间、未经核实）：
 *   - 电价：山西作为煤电大省，工商业综合电价与需量电价普遍低于全国占位默认；峰谷价差较明显。
 *   - 光照：山西北部（大同领跑者基地一带）年等效利用小时数高于全国占位默认（分布式光伏资源较好）。
 *   - 补贴 / 上网：建设补贴、运营补贴、余电上网电价均给到「山西常见量级」的示例值。
 *   - 覆写区间（bounds）：把电价 / 光照等滑杆收窄到该省合理范围，兑现 §6「用户可在允许范围内覆写」。
 *   - 生效窗口：现行政策给一个长期在效窗口；另附一条**已过期**的碳交易试点示例，用来实证 §6「过期政策不得当现行默认」（落回全局默认 + 留痕）。
 */
const SHANXI_PACK: SandboxRegionPack = {
  id: "shanxi",
  name: "山西",
  summary: "煤电大省：工商业电价偏低、峰谷价差明显、北部光照较好（示例占位·待核实）。",
  note: "山西各默认值仍为示例占位假设（confidence≤50），非经核事实，须专业人工确认后方可用于决策。",
  region: {
    values: {
      "region.elecPrice": 0.55,
      "region.peakValleySpread": 0.7,
      "region.pvEquivalentHours": 1400,
      "region.demandCharge": 44,
      "region.landRent": 500,
    },
    sources: SHANXI_REGION_SOURCES,
    source: SRC,
    confidence: 45,
    evidenceKind: "ASSUMPTION",
    // §6 用户区间内覆写：把关键地区参数在该省收窄到合理范围（比 R1.2 全国宽区间更紧）。
    bounds: {
      "region.elecPrice": { min: 0.35, max: 0.9 },
      "region.pvEquivalentHours": { min: 1100, max: 1650 },
    },
  },
  policy: [
    {
      // 已过期示例：仅它提供「碳价加计」，一旦过期即被引擎跳过、落回全局默认（§6 硬约束，测试实证）。
      values: { "policy.carbonPrice": 120 },
      sources: SHANXI_POLICY_SOURCES[0],
      source: "【示例·已过期·待核实】山西某碳交易试点激励（窗口已过，仅作 §6 过期回落演示）",
      confidence: 40,
      evidenceKind: "ASSUMPTION",
      effectiveFrom: new Date("2021-01-01T00:00:00.000Z"),
      effectiveUntil: new Date("2023-12-31T00:00:00.000Z"),
    },
    {
      // 现行（长期在效）示例政策层。
      values: {
        "policy.constructionSubsidy": 10,
        "policy.operationSubsidy": 0.08,
        "policy.feedInTariff": 0.33,
      },
      sources: SHANXI_POLICY_SOURCES[1],
      source: SRC,
      confidence: 45,
      evidenceKind: "ASSUMPTION",
      effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
      effectiveUntil: new Date("2099-12-31T00:00:00.000Z"),
    },
  ],
};

/* ─────────────────────────── 目录与便捷入口（纯函数） ─────────────────────────── */

/** 全部地区包（顺序即 UI 下拉顺序；「全国通用」恒为首个 = 默认）。 */
export const SANDBOX_REGIONS: readonly SandboxRegionPack[] = [NATIONAL_PACK, SHANXI_PACK];

/** 默认地区标识（不选地区时 = 全国通用 = R1.2 全局默认，保证与既有黄金基线逐字一致）。 */
export const DEFAULT_REGION_ID = NATIONAL_PACK.id;

/** 合法地区 id 集合（供 UI 与测试遍历）。 */
export const SANDBOX_REGION_IDS: readonly string[] = SANDBOX_REGIONS.map((p) => p.id);

/** 取某个地区包；未知 id 诚实回落到「全国通用」，绝不裸抛（对齐 Scout/引擎「永不裸抛」范式）。 */
export function getRegionPack(id: string | null | undefined): SandboxRegionPack {
  return SANDBOX_REGIONS.find((p) => p.id === id) ?? NATIONAL_PACK;
}

/** 供 UI 渲染下拉/切换按钮的精简选项列表。 */
export function listRegionOptions(): { id: string; name: string; summary: string }[] {
  return SANDBOX_REGIONS.map((p) => ({ id: p.id, name: p.name, summary: p.summary }));
}

/**
 * 组装「选了这个地区 + 用户覆写」后喂给 `resolveSandbox` / `runSandboxModel` / `computeTornado` 的分层。
 * 这是把 R5 地区包接进 R4 工作台与 R2 引擎的唯一接缝：region/policy 层垫底，user 层在上（§6 优先级）。
 *
 * **地区限幅落到用户层**：R1 引擎按"命中层自身的 bounds"裁剪覆写，故把本省 `region.bounds` 透传到 user 层，
 * 才真正兑现 §6「某省对电价覆写限幅更严、用户只能在允许区间内覆写」——用户改电价会被裁到该省上下界。
 *
 * `now`（判政策生效/过期的时钟）语义：**显式注入以离线测死政策过期分支**（§6）。缺省取真实当前时间——
 * 因为 R1 引擎在 `now` 省略时回落到极早时间（epoch 0），会把本目录里「2024 起生效」的现行政策误判为
 * "尚未生效"。故本接缝默认按"此刻"评估政策窗口，测试则传固定 `now` 保证确定性。
 */
export function buildSandboxLayers(
  regionId: string,
  userValues: Record<string, number | boolean | string> = {},
  now?: Date,
): Omit<ResolveLayers, "derived"> {
  const pack = getRegionPack(regionId);
  const user: ValueLayer = { values: userValues };
  if (pack.region.bounds) user.bounds = pack.region.bounds; // §6 地区限幅约束用户覆写
  return {
    region: pack.region,
    policy: pack.policy,
    user,
    now: now ?? new Date(),
  };
}
