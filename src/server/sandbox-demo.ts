/**
 * R8.8a「新能源重卡 + 光伏 + 储能 + 充电一体化项目」—— **可操作产业项目参数模型：映射层（纯函数）**。
 *
 * 定位（创始人 2026-09-07 裁决 R8.8a）：**这不是重新开发沙盘**。R1–R7 已经实证跑通
 *   参数 → 计算 → 技术/经济结果 → 图表 → 敏感性 → 报告 → 版本保存 的整条命脉。本模块只做一件事：
 *   把面向"懂沙盘的人"的 40 参数全量工作台，**收敛成一款只露 ~10 个关键参数的「示范项目参数模型」**，
 *   作为**用户操作层的简化入口**——10 个 headline 参数经此**纯映射层翻译成现有 40 参数键**后，
 *   原样喂给既有引擎（`buildSandboxLayers` → `runSandboxModel` → `computeTechModel`/`computeTornado`
 *   → `buildSandboxViewModel` → `buildSandboxReport`）。**不改旧模型口径、不 bump MODEL_VERSION、不新建计算引擎、零 schema 迁移。**
 *
 * ── 车队能耗三参数的映射原理（本模块唯一的"新认知"）───────────────────────────────
 *   现有引擎里，"充电能量需求"这个**命脉网关**被黄金样本焊死在：
 *       derived.dailyChargeEnergy = project.trucksPerDay × project.chargePerTruck   （基线 60×250=15000 kWh/日）
 *   而用户从"车队持有"视角思考，关心的是「重卡数量 × 单车年运营里程 × 车辆百公里电耗」。二者是
 *   **同一物理量的两种参数化**，只需把车队口径折算进既有网关，即可 0 改引擎地复用整条计算链：
 *       车队年充电量(电池侧)  = truckCount × annualMileagePerTruck × energyPer100km / 100        [kWh/年]
 *       单车日均充电量         = energyPer100km/100 × annualMileagePerTruck / DEMO_OPERATING_DAYS [kWh/车·日]
 *       → 令 project.chargePerTruck = 单车日均充电量，project.trucksPerDay = truckCount
 *       → 则 dailyChargeEnergy = truckCount × 单车日均充电量，tech 层 ×operatingDays 后 opDays 约去，
 *          年充电量精确回到「车队年充电量」，与逐时口径无关的简化年度平衡自洽。
 *   **默认态刻意校准**：truckCount=60 / mileage=70000 / energyPer100km=125 → chargePerTruck=250、trucksPerDay=60，
 *     与 R1.2 全局默认**逐字相同**，故"打开示范模型、什么都不改"= 既有黄金基线（见 sandbox-demo.test 零churn断言）。
 *
 * ── 诚实边界（宪法第 16/20 条 / R8.7 纪律，一律不得回退）────────────────────────────
 *   - 本层所有数值最终仍来自 R1.2「占位假设」参数目录：`CalcResult.needsProfessionalReview=true` 恒在，
 *     对外表述一律「沙盘推演 · 示例假设 · 待核实」，**不得作投资/并网决策依据**。
 *   - 「项目总投资」按创始人裁决**只作计算结果展示**（= `calc.capex.gross`，自下而上由设备/车队规模算出），
 *     **不作输入**；"输入总投资→反推规模"与"贷款比例/债务现金流/DSCR/股权 IRR"**全部推迟 R8.8b**（会改经济口径，高风险须人工确认）。
 *   - `classifyParameterOrigin()` 只做**展示层分类**（用户输入/系统默认/计算值/外部数据），
 *     **不改引擎 `ValueOrigin` 枚举**，复用 R8.7 已有逐值溯源（sourceUrl/asOf/evidenceKind），与"事实 vs 假设绝不混淆"同一口径。
 *   - 纯函数、无 DB / 无网络 /（除注入 now 外）无时钟 / 无随机 → 可像 scoring.ts 一样用黄金样本焊死。
 */

import { runSandboxModel, type CalcResult } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel, type TechResult } from "@/server/sandbox-tech";
import { computeTornado, type TornadoResult } from "@/server/sandbox-sensitivity";
import { buildSandboxLayers, getRegionPack, DEFAULT_REGION_ID } from "@/server/sandbox-regions";
import type { ResolveLayers, ResolveResult, ResolvedParameter, ValueOrigin } from "@/server/parameter-engine";
import { buildSandboxViewModel, formatMoney, type SandboxViewModel } from "@/lib/sandbox-view";
import { buildSandboxReport, type ChangedParamView, type SandboxReport } from "@/lib/sandbox-report";

/* ─────────────────────────── 版本与标识 ─────────────────────────── */

/** 示范项目模型版本（映射口径/参数集变化须升版并记因，宪法第 13 条）。这是**映射层**版本，非经济内核 MODEL_VERSION（后者刻意不动）。 */
export const DEMO_MODEL_VERSION = "0.1.0";
/** 示范项目模板标识（复用既有沙盘模板常量语义，供持久化 `paramLayers` 内嵌指针、零迁移回读）。 */
export const DEMO_TEMPLATE_ID = "new-energy-heavy-truck-pv-storage-charging" as const;
/** 示范项目预设标识（露出 headline 精简集）。 */
export const DEMO_MODEL_PRESET = "demo10" as const;

/** 车队折算用的固定运营天数（= R1.2 project.operatingDays 默认；映射层内部常量，保证默认态逐字复现基线）。 */
export const DEMO_OPERATING_DAYS = 350;
/** 示范项目储能时长约定（功率 = 容量 ÷ 该值；保证用户拖"储能容量"时储能仍参与计算，且默认落回引擎默认 200kW/400kWh）。 */
export const DEMO_STORAGE_HOURS = 2;

/* ─────────────────────────── 分类器：参数来源认知标签（§7 展示层） ─────────────────────────── */

/** 用户可见的四类来源认知标签（创始人 R8.8a 指令 §7：用户输入 / 系统默认 / 计算值 / 外部数据）。 */
export const PARAM_SOURCE_CATEGORIES = ["USER_INPUT", "SYSTEM_DEFAULT", "CALCULATED", "EXTERNAL_DATA"] as const;
export type ParamSourceCategory = (typeof PARAM_SOURCE_CATEGORIES)[number];

const CATEGORY_LABEL: Record<ParamSourceCategory, string> = {
  USER_INPUT: "用户输入",
  SYSTEM_DEFAULT: "系统默认",
  CALCULATED: "计算值",
  EXTERNAL_DATA: "外部数据",
};

/** 一条参数的来源信息（分类 + 值 + 溯源 + 更新时间 + 是否用户改/被裁剪）。纯派生自引擎解析结果，不新增真源。 */
export interface ParameterOriginInfo {
  key: string;
  label: string;
  value: number | boolean | string;
  unit?: string;
  /** 四类认知标签。 */
  category: ParamSourceCategory;
  categoryLabel: string;
  /** 「外部数据」的子类：地区 / 政策；其余为 undefined。 */
  externalKind?: "地区" | "政策";
  /** 引擎原始来路（default/region/policy/user/derived），保留供调试与溯源。 */
  origin: ValueOrigin;
  /** 系统默认值（供 UI 并排显示"默认 vs 当前"）。 */
  defaultValue: number;
  /** 该值是否由用户本次显式改动（区别于程序垫入的默认）。 */
  userModified: boolean;
  /** 是否被裁剪到允许边界。 */
  clamped: boolean;
  /** 来源描述（占位假设 / 地区包名 / 政策文件名…）。 */
  source: string;
  /** R8.7 逐值可核验来源链接（仅 http(s) 才落此，缺链接的 FACT 已被引擎诚实降级）。 */
  sourceUrl?: string;
  sourceType?: string;
  /** 数据时点 / 更新时间（as-of）。 */
  asOf?: string;
  /** 认识论标签（FACT / ASSUMPTION / …）。 */
  evidenceKind: string;
  confidence: number;
  /** 是否为"带可核验来源的已核实外部数据"（§20：FACT + http(s) 链接才算数）。 */
  verified: boolean;
}

/**
 * 把引擎的一条 `ResolvedParameter` 翻译成用户可见的四类来源标签（**纯函数，不改引擎枚举**）。
 *
 * 判定优先级（结合"用户本次是否真的改过"这一 UI 事实，避免把程序垫入的默认误标成"用户输入"）：
 *   1) `touched=true`            → USER_INPUT（用户输入）
 *   2) 引擎 origin="derived"      → CALCULATED（计算值）
 *   3) origin="region"            → EXTERNAL_DATA / 地区
 *   4) origin="policy"            → EXTERNAL_DATA / 政策
 *   5) 其余（default 或程序垫入的 user 默认）→ SYSTEM_DEFAULT（系统默认）
 *
 * `resolved` 缺省（该键未被解析，理论上不该发生）时诚实返回 SYSTEM_DEFAULT + 空溯源，绝不抛。
 */
export function classifyParameterOrigin(
  resolved: ResolvedParameter | undefined,
  opts: { touched?: boolean; specDefault?: number; label?: string } = {},
): ParameterOriginInfo {
  const touched = opts.touched === true;
  if (!resolved) {
    return {
      key: "?",
      label: "?",
      value: NaN,
      category: "SYSTEM_DEFAULT",
      categoryLabel: CATEGORY_LABEL.SYSTEM_DEFAULT,
      origin: "default",
      defaultValue: opts.specDefault ?? NaN,
      userModified: false,
      clamped: false,
      source: "（未解析）",
      evidenceKind: "ASSUMPTION",
      confidence: 0,
      verified: false,
    };
  }
  let category: ParamSourceCategory;
  let externalKind: "地区" | "政策" | undefined;
  if (touched) category = "USER_INPUT";
  else if (resolved.origin === "derived") category = "CALCULATED";
  else if (resolved.origin === "region") {
    category = "EXTERNAL_DATA";
    externalKind = "地区";
  } else if (resolved.origin === "policy") {
    category = "EXTERNAL_DATA";
    externalKind = "政策";
  } else category = "SYSTEM_DEFAULT";

  const verified = resolved.evidenceKind === "FACT" && !!resolved.sourceUrl;
  const specDefault = resolved.value as number; // 兜底：无 spec 时用当前值占位（调用方一般会给 specDefault）

  return {
    key: resolved.key,
    label: opts.label ?? resolved.key,
    value: resolved.value,
    unit: resolved.unit,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    externalKind,
    origin: resolved.origin,
    defaultValue: opts.specDefault ?? specDefault,
    userModified: touched,
    clamped: resolved.clamped,
    source: resolved.source,
    ...(resolved.sourceUrl ? { sourceUrl: resolved.sourceUrl } : {}),
    ...(resolved.sourceType ? { sourceType: resolved.sourceType } : {}),
    ...(resolved.asOf ? { asOf: resolved.asOf } : {}),
    evidenceKind: resolved.evidenceKind,
    confidence: resolved.confidence,
    verified,
  };
}

/* ─────────────────────────── 示范项目 headline 参数目录（用户操作层单一真源） ─────────────────────────── */

/** headline 参数在**引擎里映射到的主键**（用于取解析值 / 溯源；fleet 三兄弟统一挂 trucksPerDay）。 */
export type DemoFieldId =
  | "region"
  | "truckCount"
  | "annualMileagePerTruck"
  | "energyPer100km"
  | "pvCapacity"
  | "storageEnergy"
  | "chargerUnitPower"
  | "elecPrice";

/** 一条 headline 参数的展示规格（中文标签 / 单位 / 滑杆区间 / 映射说明 / 归属分组）。 */
export interface DemoHeadlineSpec {
  id: DemoFieldId;
  label: string;
  unit?: string;
  /** 滑杆可拖区间（刻意收窄到"映射永不触发引擎裁剪"的现实包线，见文件头换算说明）。 */
  min: number;
  max: number;
  /** 引擎主键（取溯源）；region 无单一数值键，用哨兵。 */
  engineKey: string;
  /** 一句话说明（映射口径 / 数据来源），UI 折叠展示。 */
  note: string;
}

/**
 * 10 参数示范模型的 headline 目录（用户操作层）。`region`/`elecPrice` 属"外部数据"色彩，
 * fleet/pv/storage/charger 属"项目规模"，`项目总投资` 单列为计算结果（见 DEMO_OUTPUT_*）。
 * 注意：这里只声明**用户可见的精简集**，底层 40 参数目录（sandbox-params）一字未改、仍可展开。
 */
export const DEMO_HEADLINE_SPECS: readonly DemoHeadlineSpec[] = [
  { id: "region", label: "项目地区", engineKey: "region.elecPrice", min: 0, max: 0, note: "选地区即载入该地区默认电价 / 光照 / 补贴（示例占位·待核实）。" },
  { id: "truckCount", label: "重卡数量", unit: "辆", min: 1, max: 500, engineKey: "project.trucksPerDay", note: "车队规模；映射为「日均服务重卡数」（假定每车每日约充一次）。" },
  { id: "annualMileagePerTruck", label: "单车年运营里程", unit: "km/年", min: 30000, max: 100000, engineKey: "project.chargePerTruck", note: "与百公里电耗共同决定单车日均充电量。" },
  { id: "energyPer100km", label: "车辆百公里电耗", unit: "kWh/100km", min: 80, max: 160, engineKey: "project.chargePerTruck", note: "重卡典型区间 110–160；示例占位。" },
  { id: "pvCapacity", label: "光伏装机", unit: "kWp", min: 0, max: 20000, engineKey: "project.pvCapacity", note: "直接映射既有装机键。" },
  { id: "storageEnergy", label: "储能容量", unit: "kWh", min: 0, max: 8000, engineKey: "project.storageEnergy", note: `示范项目按 ${DEMO_STORAGE_HOURS} 小时系统联动储能功率（=容量÷${DEMO_STORAGE_HOURS}h）。` },
  { id: "chargerUnitPower", label: "充电功率(单桩)", unit: "kW", min: 60, max: 960, engineKey: "project.chargerUnitPower", note: "映射单桩额定功率；桩数沿用高级参数默认。" },
  { id: "elecPrice", label: "购电价格", unit: "元/kWh", min: 0.2, max: 1.5, engineKey: "region.elecPrice", note: "工商业综合电价；不改则取所选地区默认（外部数据）。" },
];

/** headline 参数字典（键=字段 id，供 O(1) 取标签/单位）。 */
export const DEMO_HEADLINE_BY_ID: Record<DemoFieldId, DemoHeadlineSpec> = Object.fromEntries(
  DEMO_HEADLINE_SPECS.map((s) => [s.id, s]),
) as Record<DemoFieldId, DemoHeadlineSpec>;

/** 示范项目状态：8 个可操作 headline 输入（地区 + 7 数值），总投资为输出、贷款比例推迟。 */
export interface DemoHeadlineState {
  regionId: string;
  truckCount: number;
  annualMileagePerTruck: number; // km/年·车
  energyPer100km: number; // kWh/100km
  pvCapacity: number; // kWp
  storageEnergy: number; // kWh
  chargerUnitPower: number; // kW
  elecPrice: number; // 元/kWh
}

/** 用户本次"真的动过"哪些 headline 字段（决定分类器把值记为"用户输入"还是"系统默认/外部数据"）。 */
export type DemoTouched = Partial<Record<DemoFieldId, boolean>>;

/** 示范项目默认态：**刻意对齐 R1.2 全局默认**——fleet 三兄弟折算回 trucksPerDay=60×chargePerTruck=250，
 *  镜像字段各取其引擎默认，地区=全国通用（零覆写）。故默认态解析结果 == 既有基线（黄金样本焊死）。 */
export function defaultDemoState(): DemoHeadlineState {
  return {
    regionId: DEFAULT_REGION_ID, // national：不覆写地区/政策 → 落回 R1.2 全局默认
    truckCount: 60,
    annualMileagePerTruck: 70000,
    energyPer100km: 125, // 60 × (125/100 × 70000/350) = 60 × 250 = 15000（= 基线日充电量）
    pvCapacity: 500,
    storageEnergy: 400,
    chargerUnitPower: 360,
    elecPrice: 0.7,
  };
}

/** 纯映射：单车日均充电量 [kWh/车·日]（车队口径 → 网关 chargePerTruck）。任一入参非有限 → NaN（调用方负责）。 */
export function fleetChargePerTruckDaily(
  energyPer100km: number,
  annualMileagePerTruck: number,
  operatingDays: number = DEMO_OPERATING_DAYS,
): number {
  return (energyPer100km / 100) * (annualMileagePerTruck / operatingDays);
}

/** 纯映射：车队年充电量（电池侧）[kWh/年] = 车数 × 年里程 × 百公里电耗 ÷ 100。 */
export function fleetAnnualChargeEnergy(state: DemoHeadlineState): number {
  return (state.truckCount * state.annualMileagePerTruck * state.energyPer100km) / 100;
}

/**
 * **映射层核心纯函数**：示范项目状态 → 现有 40 参数引擎的 user 覆写键值（不含地区/政策垫底层）。
 * 只翻译"用户真的动过"的字段（fleet 三兄弟任一被触碰则成对垫入 trucksPerDay+chargePerTruck，
 * 储能被触碰则联动 storagePower）；未动的字段不覆写 → 保留地区/系统默认、并被分类器如实归类。
 * 纯函数、无副作用，供单元黄金样本直接测死"改哪个键、值多少"。
 */
export function demoUserValues(
  state: DemoHeadlineState,
  touched: DemoTouched = {},
): Record<string, number> {
  const values: Record<string, number> = {};

  const fleetTouched =
    touched.truckCount === true ||
    touched.annualMileagePerTruck === true ||
    touched.energyPer100km === true;
  if (fleetTouched) {
    values["project.trucksPerDay"] = state.truckCount;
    values["project.chargePerTruck"] = fleetChargePerTruckDaily(
      state.energyPer100km,
      state.annualMileagePerTruck,
    );
  }

  if (touched.pvCapacity === true) values["project.pvCapacity"] = state.pvCapacity;

  if (touched.storageEnergy === true) {
    values["project.storageEnergy"] = state.storageEnergy;
    values["project.storagePower"] =
      state.storageEnergy > 0 ? state.storageEnergy / DEMO_STORAGE_HOURS : 0;
  }

  if (touched.chargerUnitPower === true) values["project.chargerUnitPower"] = state.chargerUnitPower;

  if (touched.elecPrice === true) values["region.elecPrice"] = state.elecPrice;

  return values;
}

/* ─────────────────────────── 一次完整推演的装配（供面板 / 测试消费） ─────────────────────────── */

/** headline 参数的来源信息行（分类 + 值 + 溯源），面板与报告共用。 */
export interface DemoHeadlineInfo {
  spec: DemoHeadlineSpec;
  /** 当前展示值（fleet 镜像字段用其"车队口径"原值，而非折算后的引擎网关值）。 */
  displayValue: number;
  origin: ParameterOriginInfo;
}

/** 示范项目的计算输出（总投资等"结果而非输入"，一律 CALCULATED 类，来自引擎不重算）。 */
export interface DemoOutputs {
  totalInvestmentGross: number; // = calc.capex.gross（元）
  totalInvestmentGrossLabel: string;
  totalInvestmentNet: number; // = calc.capex.net（补贴后）
  annualChargeEnergyKwh: number; // 车队口径年充电量（展示用，纯输入算术）
  dailyChargeEnergyKwh: number; // 引擎派生网关值（应 ≈ 年充电量 ÷ 运营天数）
}

export interface DemoScenarioResult {
  demoVersion: string;
  templateId: typeof DEMO_TEMPLATE_ID;
  preset: typeof DEMO_MODEL_PRESET;
  state: DemoHeadlineState;
  touched: DemoTouched;
  regionName: string;
  userValues: Record<string, number>;
  layers: Omit<ResolveLayers, "derived">;
  resolved: ResolveResult;
  calc: CalcResult;
  tech: TechResult | null;
  tornado: TornadoResult;
  vm: SandboxViewModel;
  report: SandboxReport;
  headlines: DemoHeadlineInfo[];
  outputs: DemoOutputs;
}

function fmtStateValue(spec: DemoHeadlineSpec, v: number): string {
  const digits = spec.unit === "元/kWh" ? 2 : Number.isInteger(v) ? 0 : 2;
  return v.toFixed(digits);
}

/**
 * 装配一次示范项目推演：映射 → 既有分层 → 既有引擎 → 技术/敏感性 → 视图模型 → 动态报告。
 * **全程复用 R1–R7 纯函数，本函数自身不做任何经济/技术计算**（§7 程序算、§16 单一真源）。
 * `now` 显式注入以离线测死政策过期分支（§6）；缺省取此刻（现行政策长期在效，UI 交互稳定）。
 */
export function computeDemoScenario(
  state: DemoHeadlineState,
  touched: DemoTouched = {},
  now?: Date,
): DemoScenarioResult {
  const userValues = demoUserValues(state, touched);
  const layers = buildSandboxLayers(state.regionId, userValues, now);
  const resolved = resolveSandbox(layers);
  const calc = runSandboxModel(layers);
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({ layers });
  const discountRate = (resolved.numeric["finance.discountRate"] ?? 8) / 100;
  const vm = buildSandboxViewModel({
    calc,
    tech: tech && tech.ok ? tech.firstYear : null,
    tornado,
    discountRate,
  });

  const pack = getRegionPack(state.regionId);

  // headline 来源行：镜像字段用其车队/装机"原值"展示，网关值(dailyCharge 等)另入 outputs。
  const touchedOf = (id: DemoFieldId): boolean => touched[id] === true;
  const fleetAny =
    touchedOf("truckCount") || touchedOf("annualMileagePerTruck") || touchedOf("energyPer100km");

  const valueFor = (id: DemoFieldId): number => {
    switch (id) {
      case "truckCount":
        return state.truckCount;
      case "annualMileagePerTruck":
        return state.annualMileagePerTruck;
      case "energyPer100km":
        return state.energyPer100km;
      case "pvCapacity":
        return state.pvCapacity;
      case "storageEnergy":
        return state.storageEnergy;
      case "chargerUnitPower":
        return state.chargerUnitPower;
      case "elecPrice":
        return state.elecPrice;
      case "region":
        return 0;
    }
  };

  const headlines: DemoHeadlineInfo[] = DEMO_HEADLINE_SPECS.map((spec) => {
    const rp = resolved.params[spec.engineKey];
    // 地区行：无单一数值语义，用"是否载入地区包"决定分类（通用=系统默认，选省=外部数据）。
    if (spec.id === "region") {
      const isNational = state.regionId === DEFAULT_REGION_ID;
      const base = classifyParameterOrigin(resolved.params["region.elecPrice"], { touched: false });
      const category: ParamSourceCategory = isNational ? "SYSTEM_DEFAULT" : "EXTERNAL_DATA";
      return {
        spec,
        displayValue: 0,
        origin: {
          ...base,
          key: "demo.region",
          label: spec.label,
          value: pack.name,
          unit: undefined,
          category,
          categoryLabel: CATEGORY_LABEL[category],
          externalKind: isNational ? undefined : "地区",
          userModified: !isNational,
        },
      };
    }
    const isFleetMirror =
      spec.id === "truckCount" ||
      spec.id === "annualMileagePerTruck" ||
      spec.id === "energyPer100km";
    const touchedFlag = isFleetMirror ? fleetAny : touchedOf(spec.id);
    const specDefault = defaultDemoState()[spec.id as keyof DemoHeadlineState] as unknown as number;
    return {
      spec,
      displayValue: valueFor(spec.id),
      origin: classifyParameterOrigin(rp, {
        touched: touchedFlag ?? false,
        specDefault,
        label: spec.label,
      }),
    };
  });

  // 报告"用户改动清单"：只列被触碰的 headline（键名取中文标签，值取展示值，单位取规格）。
  const changedParams: ChangedParamView[] = DEMO_HEADLINE_SPECS.filter(
    (s) => s.id !== "region" && (s.id === "truckCount" || s.id === "annualMileagePerTruck" || s.id === "energyPer100km" ? fleetAny : touchedOf(s.id)),
  ).map((s) => ({
    key: `demo.${s.id}`,
    label: s.label,
    value: fmtStateValue(s, valueFor(s.id)),
    unit: s.unit,
  }));

  const report = buildSandboxReport({
    vm,
    regionName: `${pack.name}（示范项目）`,
    changedParams,
    discountRatePct: discountRate * 100,
  });

  const capexGross = calc.ok ? calc.capex.gross : NaN;
  const capexNet = calc.ok ? calc.capex.net : NaN;
  const outputs: DemoOutputs = {
    totalInvestmentGross: capexGross,
    totalInvestmentGrossLabel: formatMoney(capexGross),
    totalInvestmentNet: capexNet,
    annualChargeEnergyKwh: fleetAnnualChargeEnergy(state),
    dailyChargeEnergyKwh: resolved.numeric["derived.dailyChargeEnergy"] ?? NaN,
  };

  return {
    demoVersion: DEMO_MODEL_VERSION,
    templateId: DEMO_TEMPLATE_ID,
    preset: DEMO_MODEL_PRESET,
    state,
    touched,
    regionName: pack.name,
    userValues,
    layers,
    resolved,
    calc,
    tech,
    tornado,
    vm,
    report,
    headlines,
    outputs,
  };
}

/** 示范项目初始态（默认、无改动、地区=全国通用）→ 与既有黄金基线逐字一致。 */
export function demoBaseline(): DemoScenarioResult {
  return computeDemoScenario(defaultDemoState(), {}, new Date("2026-01-01T00:00:00.000Z"));
}

/**
 * 序列化：把示范项目状态随既有 `paramLayers`（z.record 不透明、`toEngineLayers` 只读 region/policy/user/now）
 * 一并持久化——**零 schema 迁移**（对齐 R8.6 存 sandboxSource 指针进 JSON 的打法）。返回的分层里额外挂一个
 * `demo` 顶层块（引擎与落库列都原样透传、不消费），供面板重开时还原"10 参数简化视图"的滑杆位与 touched。
 */
export function serializeDemoLayers(
  scenario: DemoScenarioResult,
): Omit<ResolveLayers, "derived"> & {
  demo: { version: string; templateId: string; preset: string; state: DemoHeadlineState; touched: DemoTouched };
} {
  return {
    ...scenario.layers,
    demo: {
      version: DEMO_MODEL_VERSION,
      templateId: DEMO_TEMPLATE_ID,
      preset: DEMO_MODEL_PRESET,
      state: scenario.state,
      touched: scenario.touched,
    },
  };
}

/** 反序列化：从持久化的 `paramLayers` 里取回示范项目状态；无 `demo` 块 → null（如普通 40 参数项目）。 */
export function deserializeDemoState(layers: unknown): {
  state: DemoHeadlineState;
  touched: DemoTouched;
} | null {
  if (!layers || typeof layers !== "object") return null;
  const demo = (layers as { demo?: unknown }).demo as
    | { state?: Partial<DemoHeadlineState>; touched?: DemoTouched }
    | undefined;
  if (!demo || !demo.state) return null;
  const base = defaultDemoState();
  const s = demo.state;
  return {
    state: {
      regionId: typeof s.regionId === "string" ? s.regionId : base.regionId,
      truckCount: numOr(s.truckCount, base.truckCount),
      annualMileagePerTruck: numOr(s.annualMileagePerTruck, base.annualMileagePerTruck),
      energyPer100km: numOr(s.energyPer100km, base.energyPer100km),
      pvCapacity: numOr(s.pvCapacity, base.pvCapacity),
      storageEnergy: numOr(s.storageEnergy, base.storageEnergy),
      chargerUnitPower: numOr(s.chargerUnitPower, base.chargerUnitPower),
      elecPrice: numOr(s.elecPrice, base.elecPrice),
    },
    touched: demo.touched ?? {},
  };
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
