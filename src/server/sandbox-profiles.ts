/**
 * 沙盘「企业画像」目录（中途重构 R7 · §14 优先级第 7 项「企业个性化」/ 总控「依企业画像裁剪方案」）。
 *
 * 为什么存在：R0–R6 已把「选地区 → 改参数 → 跑 → 技术/经济/风险/敏感性 → 动态报告 → AI 解释 → 保存」
 *   这条**通用**决策链端到端跑通（§17）。但同一套物理参数，对**不同性质的企业**意义完全不同——
 *   物流车队自用为主、最在意回收期；第三方充电运营商靠服务费差价、最在意 IRR/ROI；产业园区业主对冲电价、
 *   最在意绿电自用；市政公交低息长期资金、可接受更长回收；财务投资人只看回报与风险。§14 要求 V1 具备
 *   「依企业画像裁剪方案」的能力，本文件就是这块**最后一块地基**：把几类典型企业抽象成版本化画像，
 *   每类画像给出一组**参数预设起点**（`presetValues`）与**决策侧重**（`emphasis`），喂进已测死的 R1 引擎即得
 *   「这家企业视角下的当前生效值 + 该重点看哪几个指标」。
 *
 * 与既有分层的关系（§6 优先级 / 第 16 条单一真源，**零引擎改动**）：
 *   - 画像预设写进 `user` 层，但排在**用户显式改动之后**（`{...preset, ...userValues}`），
 *     故优先级链为 `default < region < policy < 画像预设 < 用户本次改动`——画像给"这类企业通常如此"的**起点**，
 *     用户仍能在其上逐项微调（正是「裁剪方案」而非「锁死方案」）。
 *   - `buildProfileLayers` 只是把 R5 的 `buildSandboxLayers` 多垫一层画像预设，地区包 bounds 仍透传进 user 层，
 *     因此**复用同一套已测死的解析 / 经济 / 敏感性内核**，不新增参数、不新增计算、不碰数据库。
 *   - 报告的「企业个性化视角」节（见 `@/lib/sandbox-report`）只从**已算好的**指标卡里**挑选与排序**，
 *     绝不重算任何数字（§7 程序算、LLM 只解释；这里连"个性化"都只是重排既有确定性结论）。
 *
 * ⚠️ 诚实边界（第 20 条 / §16 / 创始人 2026-09-05 裁决「默认数字标 ASSUMPTION 占位」）：
 *   - 画像的每一个预设值都是**示例占位假设**（取该类企业的常见量级跑通链路、未经逐条核实），
 *     故统一 `evidenceKind="ASSUMPTION"`、`confidence≤50`、`source` 带 `【示例·待核实】` 前缀，绝不当 FACT；
 *   - 本目录是**版本化的纯数据 + 纯函数**（可离线测死、可回滚），刻意**不落数据库**——对齐 R5 地区包先例
 *     （§14 参数系统/个性化优先于自动化/落库，且宪法「禁因终局宏大提前做复杂 V1」）。V1 只做少数几类**典型画像**，
 *     其余行业细分与企业自助画像留待后续；未来若要运营侧维护画像，再把本目录 seed 进库（属后续里程碑、非 R7 阻塞）。
 *   - 「通用（未设定画像）」为默认包且 `presetValues` 为空 → 不选画像时链路**与 R6 黄金基线逐字一致**（不破既有测试）。
 *
 * 命名与键：只使用 `@/server/sandbox-params` 里**已注册的键**（`project.*` / `finance.*` 等），不新增参数、
 *   只给画像层的取值偏好与决策侧重，避免与参数模板漂移（第 16 条单一真源）。
 */
import type { ResolveLayers, ValueLayer } from "@/server/parameter-engine";
import { getRegionPack, buildSandboxLayers } from "@/server/sandbox-regions";
import { SANDBOX_PARAMS } from "@/server/sandbox-params";

/** 企业画像目录版本（增删画像 / 改预设口径须升版并记原因，宪法第 13 条）。 */
export const SANDBOX_PROFILES_VERSION = "1.0.0";

/** 溯源引用（供报告标注「这组画像预设是按哪版给的」，第 7/16 条）。 */
export function profileCalcRef(): string {
  return `profiles@${SANDBOX_PROFILES_VERSION}`;
}

/** 每个画像预设共用的来源前缀——一眼可见"未经核实、非事实"（第 20 条）。 */
const SRC = (name: string) =>
  `【示例·待核实】「${name}」为典型企业画像的常见量级预设，跑通个性化链路用，非经核事实，须逐项替换为可追溯来源`;

/** 已注册参数键集合（画像预设只能落这些键，防漂移；模块加载即快照）。 */
const REGISTERED_KEYS = new Set(SANDBOX_PARAMS.map((s) => s.key));

/** 报告/解释关注的指标卡 key（与 `@/lib/sandbox-view` 的 summaryCards 对齐）。 */
export const PROFILE_METRIC_KEYS = ["npv", "irr", "payback", "roi", "breakeven"] as const;
export type ProfileMetricKey = (typeof PROFILE_METRIC_KEYS)[number];

/** 决策关注的非指标卡标签 token（报告据此把"在意绿电/自用"翻译成一句人话；未知 token 被忽略，绝不编造）。 */
export const PROFILE_FOCUS_TAGS = ["selfConsumption", "green", "cashflow", "scale", "risk"] as const;
export type ProfileFocusTag = (typeof PROFILE_FOCUS_TAGS)[number];

/** 一类企业的决策侧重：优先看哪几个指标（顺序即重要度）+ 额外关注点 + 一句话画像基调。 */
export interface ProfileEmphasis {
  /** 报告置顶解读的核心指标卡 key（引用已算好的卡值，不重算）。 */
  metricKeys: ProfileMetricKey[];
  /** 除指标外该企业类型额外在意的点（绿电自用 / 现金流 / 规模 / 风险 …）。 */
  focusTags: ProfileFocusTag[];
  /** 一句话「这类企业最在意什么」——报告的个性化基调。 */
  headline: string;
}

/** 一份企业画像 = 展示元数据 + 参数预设起点（写进 user 层之下）+ 决策侧重。 */
export interface SandboxEnterpriseProfile {
  /** 稳定标识（前端下拉值）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 一句话说明（选画像时展示）。 */
  summary: string;
  /** 诚实脚注（该画像数据性质，报告/页面标注用）。 */
  note: string;
  /** 参数预设起点：键必须是已注册参数键；值均为占位假设。空 = 不预设（通用包）。 */
  presetValues: Record<string, number | boolean | string>;
  /** 预设来源描述（诚实占位）。 */
  source: string;
  /** 预设置信度（≤50，占位假设）。 */
  confidence: number;
  /** 恒 ASSUMPTION（第 20 条：没核实的画像预设绝不当事实）。 */
  evidenceKind: "ASSUMPTION";
  /** 决策侧重。 */
  emphasis: ProfileEmphasis;
}

/* ─────────────────────────── 通用（默认 = 不预设，黄金基线逐字不变） ─────────────────────────── */

const GENERIC_PROFILE: SandboxEnterpriseProfile = {
  id: "generic",
  name: "通用（未设定画像）",
  summary: "不预置企业倾向，沿用地区/全局默认参数，报告作中性呈现。",
  note: "未选择企业画像，方案不裁剪、决策侧重保持中立。",
  presetValues: {},
  source: "无画像预设",
  confidence: 50,
  evidenceKind: "ASSUMPTION",
  emphasis: {
    metricKeys: ["npv", "irr", "payback"],
    focusTags: [],
    headline: "未设定特定企业画像，按通用口径评估整体经济性与回收。",
  },
};

/* ─────────────────────────── 五类典型企业画像（示例占位·待核实） ─────────────────────────── */

const FLEET_PROFILE: SandboxEnterpriseProfile = {
  id: "fleet",
  name: "物流 / 重卡车队运营商",
  summary: "自有车队自用为主，夜间集中补电、充电按内部成本结算，最在意回收期与总回报。",
  note: "车队画像预设均为示例占位假设（confidence≤50），非经核事实，须专业人工确认后方可用于决策。",
  presetValues: {
    "project.trucksPerDay": 150,
    "project.chargePerTruck": 280,
    "project.chargerCount": 12,
    "project.chargerUtilization": 25,
    "project.chargingPrice": 0.75, // 自用按内部成本价，非对外服务费
    "project.pvCapacity": 800,
    "project.includeStorage": 1,
    "finance.discountRate": 10, // 民企资金成本偏高
    "finance.projectLife": 10, // 车辆与设备折旧周期较短，倾向快回收
  },
  source: SRC("物流/重卡车队运营商"),
  confidence: 45,
  evidenceKind: "ASSUMPTION",
  emphasis: {
    metricKeys: ["payback", "npv", "roi"],
    focusTags: ["selfConsumption", "cashflow"],
    headline: "车队自用型：先看清多久回本、现金流稳不稳，绿电自用能省多少电费。",
  },
};

const OPERATOR_PROFILE: SandboxEnterpriseProfile = {
  id: "operator",
  name: "第三方充电运营商",
  summary: "面向公众经营，靠充电服务费差价盈利，高利用率、追求 IRR / ROI 与快速扩张回报。",
  note: "运营商画像预设均为示例占位假设（confidence≤50），非经核事实，须专业人工确认后方可用于决策。",
  presetValues: {
    "project.trucksPerDay": 200,
    "project.chargerCount": 20,
    "project.chargerUtilization": 55, // 经营性桩群利用率更高
    "project.chargingPrice": 1.2, // 含服务费的对外定价
    "project.pvCapacity": 500,
    "project.storagePower": 300,
    "project.storageEnergy": 600,
    "finance.discountRate": 12, // 社会资本回报要求高
    "finance.equityRatio": 40,
  },
  source: SRC("第三方充电运营商"),
  confidence: 45,
  evidenceKind: "ASSUMPTION",
  emphasis: {
    metricKeys: ["irr", "roi", "npv"],
    focusTags: ["scale", "cashflow"],
    headline: "运营商视角：内部收益率与回报率决定能不能投、能不能复制扩张。",
  },
};

const PARK_PROFILE: SandboxEnterpriseProfile = {
  id: "park",
  name: "产业园区 / 工商业业主",
  summary: "屋顶光伏自发自用 + 配套充电，核心是对冲电价、提升绿电渗透，看重长期净现值。",
  note: "园区业主画像预设均为示例占位假设（confidence≤50），非经核事实，须专业人工确认后方可用于决策。",
  presetValues: {
    "project.pvCapacity": 2000, // 大量屋顶资源，光伏装机偏高
    "project.trucksPerDay": 40,
    "project.chargerCount": 6,
    "project.chargingPrice": 0.65, // 主要供园区内部车辆，价低
    "project.includeStorage": 1,
    "project.storagePower": 250,
    "project.storageEnergy": 500,
    "finance.discountRate": 8, // 业主自有低成本资金
    "finance.projectLife": 20, // 厂房长周期，可摊到更久
  },
  source: SRC("产业园区/工商业业主"),
  confidence: 45,
  evidenceKind: "ASSUMPTION",
  emphasis: {
    metricKeys: ["npv", "payback", "irr"],
    focusTags: ["selfConsumption", "green"],
    headline: "业主自用型：光伏绿电自用比例越高、电价对冲越强，长期净现值越可观。",
  },
};

const TRANSIT_PROFILE: SandboxEnterpriseProfile = {
  id: "transit",
  name: "公交 / 市政集团",
  summary: "定点定线、夜间谷电集中充电，规模大但利用率低，低息长期资金、可接受较长回收并兼顾绿色指标。",
  note: "市政公交画像预设均为示例占位假设（confidence≤50），非经核事实，须专业人工确认后方可用于决策。",
  presetValues: {
    "project.trucksPerDay": 120,
    "project.chargePerTruck": 300, // 大型公交电池容量更大
    "project.chargerCount": 30,
    "project.chargerUtilization": 20, // 夜间集中、白天在场，日均利用率低
    "project.chargingPrice": 0.7,
    "project.pvCapacity": 1000,
    "project.includeStorage": 0, // 场站多依谷电、未必配储能
    "finance.discountRate": 5, // 公共 / 低成本长期资金
    "finance.projectLife": 25,
  },
  source: SRC("公交/市政集团"),
  confidence: 45,
  evidenceKind: "ASSUMPTION",
  emphasis: {
    metricKeys: ["payback", "npv"],
    focusTags: ["green", "scale"],
    headline: "市政视角：资金成本低、可容长回收，重点在规模保障与绿色示范效益。",
  },
};

const INVESTOR_PROFILE: SandboxEnterpriseProfile = {
  id: "investor",
  name: "财务投资人 / 基金",
  summary: "不直接运营，只评估回报与风险；高折现率、短计算期，紧盯 IRR / NPV 与盈亏平衡安全垫。",
  note: "投资人画像预设均为示例占位假设（confidence≤50），非经核事实，须专业人工确认后方可用于决策。",
  presetValues: {
    "finance.discountRate": 15, // 股权回报门槛高
    "finance.projectLife": 8, // 基金存续期短，看重早期回收
    "finance.equityRatio": 40,
  },
  source: SRC("财务投资人/基金"),
  confidence: 40,
  evidenceKind: "ASSUMPTION",
  emphasis: {
    metricKeys: ["irr", "npv", "breakeven"],
    focusTags: ["risk"],
    headline: "投资人视角：IRR 是否跨过回报门槛、NPV 有多厚、盈亏平衡单价离现价多远。",
  },
};

/* ─────────────────────────── 目录与便捷入口（纯函数） ─────────────────────────── */

/**
 * 全部画像（顺序即 UI 下拉顺序；「通用（未设定画像）」恒为首个 = 默认，保证不选画像时与既有黄金基线逐字一致）。
 * 注：`Object.freeze` 语义由 `readonly` 类型 + 从不原地改保证；导出为只读数组防调用方篡改。
 */
export const SANDBOX_PROFILES: readonly SandboxEnterpriseProfile[] = [
  GENERIC_PROFILE,
  FLEET_PROFILE,
  OPERATOR_PROFILE,
  PARK_PROFILE,
  TRANSIT_PROFILE,
  INVESTOR_PROFILE,
];

/** 默认画像标识（不选画像 = 通用 = 无预设 → 与 R6 黄金基线逐字一致）。 */
export const DEFAULT_PROFILE_ID = GENERIC_PROFILE.id;

/** 合法画像 id 集合（供 UI 与测试遍历）。 */
export const SANDBOX_PROFILE_IDS: readonly string[] = SANDBOX_PROFILES.map((p) => p.id);

/** 取某个画像；未知 id 诚实回落到「通用」，绝不裸抛（对齐 Scout / 地区包 / 引擎「永不裸抛」范式）。 */
export function getEnterpriseProfile(id: string | null | undefined): SandboxEnterpriseProfile {
  return SANDBOX_PROFILES.find((p) => p.id === id) ?? GENERIC_PROFILE;
}

/** 供 UI 渲染下拉/切换按钮的精简选项列表。 */
export function listProfileOptions(): { id: string; name: string; summary: string; headline: string }[] {
  return SANDBOX_PROFILES.map((p) => ({
    id: p.id,
    name: p.name,
    summary: p.summary,
    headline: p.emphasis.headline,
  }));
}

/**
 * 把 R5 的「地区包分层」再垫一层「企业画像预设」，交给 `resolveSandbox` / `runSandboxModel` / `computeTornado`。
 * 这是把 R7 画像接进 R4 工作台与 R2 引擎的唯一接缝：
 *   region/policy（地区默认，来自 R5）垫底 → 画像 `presetValues` → 用户本次显式改动 依次覆盖在上（§14 #7 + §6 优先级）。
 *
 * 关键保证：
 *   - **通用画像 / 无预设 → 与 `buildSandboxLayers` 逐字等价**（不挂 source，user 层 values 只含用户改动），
 *     因此不选画像时既有黄金基线绝不受影响；
 *   - **画像不越过用户改动**：`{...preset, ...userValues}` 令用户同键覆写恒胜画像预设（"裁剪"而非"锁死"）；
 *   - **地区限幅仍透传**：沿用 R5 把本省 `region.bounds` 垫进 user 层的做法，画像预设与用户覆写同受地区上下界约束；
 *   - `now` 语义与 R5 一致：显式注入以离线测死政策分支，缺省取真实当前时间（避免引擎 epoch0 误判现行政策未生效）。
 */
export function buildProfileLayers(
  profileId: string,
  regionId: string,
  userValues: Record<string, number | boolean | string> = {},
  now?: Date,
): Omit<ResolveLayers, "derived"> {
  const profile = getEnterpriseProfile(profileId);
  // 通用画像：完全交回 R5 接缝，行为逐字不变（黄金基线守护）。
  if (profile.id === DEFAULT_PROFILE_ID || Object.keys(profile.presetValues).length === 0) {
    return buildSandboxLayers(regionId, userValues, now);
  }
  const pack = getRegionPack(regionId);
  const values = { ...profile.presetValues, ...userValues }; // 画像预设垫底，用户改动在上
  const user: ValueLayer = {
    values,
    source: profile.source,
    confidence: profile.confidence,
    evidenceKind: profile.evidenceKind,
  };
  if (pack.region.bounds) user.bounds = pack.region.bounds; // 沿用 §6 地区限幅
  return {
    region: pack.region,
    policy: pack.policy,
    user,
    now: now ?? new Date(),
  };
}

/**
 * 判断某参数是否「由当前画像预设、且用户本次未改动」——供工作台把该值标为「画像默认」徽章、
 * 与用户「已改」区分开（引擎只会把二者都报成 origin="user"，故这层区分在应用侧用数据算，绝不臆测）。
 * 通用画像恒返回 false（无预设）。
 */
export function isProfileDefault(
  profileId: string,
  key: string,
  userOverrides: Record<string, unknown>,
): boolean {
  const profile = getEnterpriseProfile(profileId);
  if (profile.id === DEFAULT_PROFILE_ID) return false;
  return key in profile.presetValues && !(key in userOverrides);
}

/** 校验画像目录自身（供单测调用；也作运行期防漂移的显式断言入口，返回问题清单，空=健康）。 */
export function validateProfileCatalog(): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  if (SANDBOX_PROFILES[0]?.id !== DEFAULT_PROFILE_ID) {
    issues.push("默认（通用）画像必须是目录首个，以保证不选画像=黄金基线");
  }
  for (const p of SANDBOX_PROFILES) {
    if (seen.has(p.id)) issues.push(`画像 id 重复：${p.id}`);
    seen.add(p.id);
    if (p.evidenceKind !== "ASSUMPTION") issues.push(`${p.id}: 画像预设必须标 ASSUMPTION（第 20 条）`);
    if (typeof p.confidence !== "number" || p.confidence > 50) {
      issues.push(`${p.id}: 画像置信度须 ≤50（占位假设，不可当事实）`);
    }
    for (const [key, val] of Object.entries(p.presetValues)) {
      if (!REGISTERED_KEYS.has(key)) issues.push(`${p.id}: 预设键 ${key} 未在参数模板注册（会与单一真源漂移）`);
      if (typeof val !== "number" && typeof val !== "boolean" && typeof val !== "string") {
        issues.push(`${p.id}.${key}: 预设值类型非法`);
      }
    }
    for (const mk of p.emphasis.metricKeys) {
      if (!(PROFILE_METRIC_KEYS as readonly string[]).includes(mk)) {
        issues.push(`${p.id}: 侧重指标 key ${mk} 不属于已知指标卡集合`);
      }
    }
    for (const ft of p.emphasis.focusTags) {
      if (!(PROFILE_FOCUS_TAGS as readonly string[]).includes(ft)) {
        issues.push(`${p.id}: 关注点 token ${ft} 不属于已知 focusTags 集合`);
      }
    }
  }
  return issues;
}
