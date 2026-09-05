import {
  type ParameterSpec,
  type DerivedFn,
  type ResolveLayers,
  type ResolveResult,
  ParameterSetSchema,
  resolveParameters,
} from "@/server/parameter-engine";

/**
 * 「新能源重卡 + 光伏 + 储能 + 充电」一体化决策沙盘 —— 参数模板（中途重构 R1.2）。
 *
 * 这是《项目中途重构总控》§5「项目参数引擎」落成的一份**具体行业参数目录**：把沙盘要跑的
 * 所有关键变量声明成可解析的 `ParameterSpec[]` + 一份派生计算注册表，喂给 R1 的纯函数
 * `resolveParameters` 即可拿到「每个参数的当前生效值 + 来源 + 置信度 + 是否被覆写/裁剪」。
 *
 * ⚠️ 诚实声明（宪法第 20 条 / 重构总控 §16 + 创始人 2026-09-05 裁决）：
 *   V1 阶段本模板里的**每一个默认值都是"示例占位假设"**（量级取自行业常见公开区间，未经本项目
 *   逐条核实），因此**全部标 `evidenceKind="ASSUMPTION"`、置信度刻意压在偏低区间、`source` 一律带
 *   `【占位假设】` 前缀**。目的是先让 §17 E2E 主链「改参数→重算→图表/风险/报告联动」跑通，
 *   **绝不把这些数字当 FACT 对外表述**；后续里程碑须逐项替换为经核数据（来源可追溯 + 公式可复算）。
 *
 * 与 R2 的边界：本文件**只声明输入参数 + 少量结构性派生（聚合量）**，不含任何技术出力模型
 * 或财务评价公式（光伏年发电量、CAPEX/OPEX/NPV/IRR/回收期等都是 R2 计算引擎的职责）。
 * 这里刻意放的派生参数（如"日充电总量""充电总功率""储能时长"）是**纯输入算术**，用来在参数层
 * 直接示范 §4 命脉「改上游参数 → 下游计算值随之重算」，并给 R2 一个稳定、语义清晰的入参快照。
 *
 * 命名约定：点分命名空间 `<group>.<entity>.<metric>`，键一旦确定即为下游（R2/R4/R6）单一真源，
 * 改键名须同步下游。exposure 三档（basic/advanced/pro）决定 UI 默认露出哪层滑块（§5 分层曝光）。
 */

/** 参数模板版本（改结构/默认口径须升版并记录原因，宪法第 13 条）。 */
export const SANDBOX_PARAMS_VERSION = "1.1.0"; // 1.1.0：新增 project.chargingPrice 收益端第一杠杆（供 R2.4 编排消费）

/** 沙盘模板的稳定标识（供 R3 建项目时引用模板来源）。 */
export const SANDBOX_DEPOT_TEMPLATE = "new-energy-heavy-truck-pv-storage-charging" as const;

/** 每个占位默认共用的来源前缀——一眼可见"未经核实、非事实"（第 20 条）。 */
const A = "【占位假设·待核实】V1 取行业常见量级跑通链路，非经核事实，须逐项替换为可追溯来源";

/**
 * 构造一条 numeric 参数（本模板 99% 是 numeric）。必填项强制手写以防"忘了给值"，
 * 其余给保守缺省（editable=true、confidence=40、evidenceKind=ASSUMPTION、source=A）。
 */
function num(
  key: string,
  label: string,
  group: ParameterSpec["group"],
  exposure: ParameterSpec["exposure"],
  defaultValue: number,
  unit: string,
  extra: Partial<ParameterSpec> = {},
): ParameterSpec {
  return {
    key,
    label,
    kind: "numeric",
    group,
    exposure,
    defaultValue,
    unit,
    editable: true,
    confidence: 40,
    source: A,
    evidenceKind: "ASSUMPTION",
    ...extra,
  };
}

/* ─────────────────────────── 参数目录 ─────────────────────────── */

/**
 * 沙盘参数全集（按 §5 五组分类）。键名 = 下游单一真源。
 * 区间 min/max 给得偏宽以容纳不同地区/规模，真正的地区收窄在 R5 用 ValueLayer.bounds 表达。
 */
export const SANDBOX_PARAMETER_SPECS: readonly ParameterSpec[] = [
  // ── 地区参数（选地区后由 R5 用 region ValueLayer 覆写；此处为全国性占位默认）──
  num("region.elecPrice", "工商业综合电价", "region", "basic", 0.7, "元/kWh", { min: 0.2, max: 2.0, confidence: 45 }),
  num("region.peakValleySpread", "峰谷价差", "region", "advanced", 0.6, "元/kWh", { min: 0, max: 1.8 }),
  num("region.pvEquivalentHours", "光伏年等效利用小时数", "region", "advanced", 1200, "h", { min: 800, max: 1900 }),
  num("region.demandCharge", "需量(容量)电价", "region", "pro", 40, "元/kW·月", { min: 0, max: 80 }),
  num("region.landRent", "土地年租金", "region", "pro", 800, "元/亩·年", { min: 0, max: 5000 }),

  // ── 政策参数（R5 用 policy ValueLayer[] 覆写并带生效窗口；此处占位）──
  num("policy.constructionSubsidy", "建设补贴占总投资", "policy", "advanced", 5, "%", { min: 0, max: 30 }),
  num("policy.operationSubsidy", "充电量运营补贴", "policy", "advanced", 0.05, "元/kWh", { min: 0, max: 0.5 }),
  num("policy.feedInTariff", "余电上网电价", "policy", "pro", 0.35, "元/kWh", { min: 0, max: 0.6 }),
  num("policy.carbonPrice", "碳价", "policy", "pro", 80, "元/tCO₂", { min: 0, max: 500 }),

  // ── 项目参数（用户按自己项目直接设定，沙盘的核心滑块）──
  num("project.trucksPerDay", "日均服务重卡数", "project", "basic", 60, "辆/日", { min: 1, max: 1000, confidence: 45 }),
  num("project.chargePerTruck", "单车均充电量", "project", "basic", 250, "kWh/车·次", { min: 50, max: 600 }),
  num("project.operatingDays", "年运营天数", "project", "advanced", 350, "天/年", { min: 200, max: 366 }),
  num("project.pvCapacity", "光伏装机", "project", "basic", 500, "kWp", { min: 0, max: 20000, confidence: 45 }),
  num("project.storagePower", "储能额定功率", "project", "advanced", 200, "kW", { min: 0, max: 5000 }),
  num("project.storageEnergy", "储能额定容量", "project", "advanced", 400, "kWh", { min: 0, max: 20000 }),
  num("project.chargerCount", "充电桩数量", "project", "basic", 8, "台", { min: 1, max: 200, confidence: 45 }),
  num("project.chargerUnitPower", "单桩额定功率", "project", "advanced", 360, "kW", { min: 60, max: 960 }),
  num("project.gridCapacity", "并网报装容量", "project", "pro", 2000, "kW", { min: 100, max: 20000 }),
  num("project.chargerUtilization", "充电桩平均利用率", "project", "advanced", 35, "%", { min: 5, max: 90 }),
  // 综合充电单价：向重卡收取的电费+服务费合一价（收益端第一杠杆，R2.4 编排据此算充电收入）。
  num("project.chargingPrice", "综合充电单价(含电费+服务)", "project", "basic", 0.9, "元/kWh", { min: 0.3, max: 3.0, confidence: 45 }),
  // 布尔开关：是否配储能——验证引擎对非数值参数的透传（不进 R2 数值快照）。
  {
    key: "project.includeStorage",
    label: "是否配置储能",
    kind: "boolean",
    group: "project",
    exposure: "advanced",
    defaultValue: 1, // 布尔缺省 1=启用（值语义由 UI/计算侧按 kind 解释；不进 numeric 快照）
    editable: true,
    confidence: 50,
    source: "【占位假设】V1 默认示例项目配储能",
    evidenceKind: "ASSUMPTION",
  },

  // ── 技术/设备参数（效率与单位造价；R2 用它把规模换算成能量流与钱）──
  num("tech.pvPerformanceRatio", "光伏系统效率(PR)", "technology", "pro", 0.82, "", { min: 0.6, max: 0.95 }),
  num("tech.pvDegradation", "光伏年衰减率", "technology", "pro", 0.5, "%/年", { min: 0, max: 2 }),
  num("tech.pvCapex", "光伏单位造价", "technology", "advanced", 3.5, "元/W", { min: 2, max: 8, confidence: 45 }),
  num("tech.pvOm", "光伏年运维成本", "technology", "pro", 15, "元/kWp·年", { min: 0, max: 60 }),
  num("tech.storageRoundTripEff", "储能往返效率", "technology", "advanced", 88, "%", { min: 70, max: 98 }),
  num("tech.storageCapex", "储能单位造价", "technology", "advanced", 1.3, "元/Wh", { min: 0.6, max: 3, confidence: 45 }),
  num("tech.storageCycleLife", "储能循环寿命", "technology", "pro", 6000, "次", { min: 2000, max: 12000 }),
  num("tech.storageCalendarLife", "储能日历寿命", "technology", "pro", 10, "年", { min: 5, max: 20 }),
  num("tech.storageOm", "储能年运维成本", "technology", "pro", 12, "元/kWh·年", { min: 0, max: 40 }),
  num("tech.chargerEfficiency", "充电桩效率", "technology", "pro", 94, "%", { min: 85, max: 99 }),
  num("tech.chargerCapex", "充电桩单位造价", "technology", "advanced", 500, "元/kW", { min: 200, max: 1500 }),
  num("tech.chargerOm", "单桩年运维成本", "technology", "pro", 3000, "元/台·年", { min: 0, max: 10000 }),
  num("tech.depotFixedOpex", "电站年固定运营成本", "technology", "advanced", 300000, "元/年", { min: 0, max: 5000000 }),

  // ── 财务参数（R2 财务模型的评价口径输入）──
  num("finance.discountRate", "基准折现率", "finance", "pro", 8, "%", { min: 0, max: 30 }),
  num("finance.projectLife", "项目计算期", "finance", "advanced", 15, "年", { min: 5, max: 30, confidence: 45 }),
  num("finance.inflation", "成本年通胀率", "finance", "pro", 2, "%/年", { min: -5, max: 15 }),
  num("finance.taxRate", "企业所得税率", "finance", "pro", 25, "%", { min: 0, max: 35 }),
  num("finance.equityRatio", "资本金占比", "finance", "pro", 30, "%", { min: 20, max: 100 }),
  num("finance.loanRate", "长期贷款利率", "finance", "pro", 4.5, "%", { min: 0, max: 15 }),
  num("finance.residualValue", "期末残值率", "finance", "pro", 5, "%", { min: 0, max: 30 }),

  // ── 派生的结构性输入（纯输入算术；示范 §4「改参数→下游计算值重算」；对用户只读）──
  num("derived.dailyChargeEnergy", "日充电总量(=车数×单车电量)", "project", "advanced", 15000, "kWh/日", {
    editable: false,
    derived: true,
    dependsOn: ["project.trucksPerDay", "project.chargePerTruck"],
  }),
  num("derived.chargerTotalPower", "充电总装机功率(=桩数×单桩功率)", "project", "advanced", 2880, "kW", {
    editable: false,
    derived: true,
    dependsOn: ["project.chargerCount", "project.chargerUnitPower"],
  }),
  num("derived.storageDuration", "储能时长(=容量÷功率)", "project", "advanced", 2, "h", {
    editable: false,
    derived: true,
    dependsOn: ["project.storageEnergy", "project.storagePower"],
  }),
];

/** 派生参数键集合（供 UI 标只读 + 测试遍历）。 */
export const SANDBOX_DERIVED_KEYS = [
  "derived.dailyChargeEnergy",
  "derived.chargerTotalPower",
  "derived.storageDuration",
] as const;

/* ─────────────────────────── 派生计算注册表 ─────────────────────────── */

/**
 * 派生计算注册表（§5「计算值」）。键与 `SANDBOX_DERIVED_KEYS` 一一对应。
 * 每个函数只读已解析的**基础值数值快照**、返回该键的计算结果；除零/缺依赖等异常一律
 * 返回 `undefined` → 引擎诚实回落占位默认 + note（绝不裸抛、绝不用假值污染下游，§16/§20）。
 */
export const SANDBOX_DERIVED: Record<string, DerivedFn> = {
  "derived.dailyChargeEnergy": (r) => {
    const trucks = r["project.trucksPerDay"];
    const perTruck = r["project.chargePerTruck"];
    if (trucks == null || perTruck == null) return undefined;
    return trucks * perTruck;
  },
  "derived.chargerTotalPower": (r) => {
    const count = r["project.chargerCount"];
    const unit = r["project.chargerUnitPower"];
    if (count == null || unit == null) return undefined;
    return count * unit;
  },
  "derived.storageDuration": (r) => {
    const energy = r["project.storageEnergy"];
    const power = r["project.storagePower"];
    if (energy == null || power == null || power === 0) return undefined; // 功率 0 → 时长无定义，诚实降级
    return energy / power;
  },
};

/* ─────────────────────────── 便捷入口（给 R2 的稳定接缝） ─────────────────────────── */

/** 校验后的参数集合（模块加载即校验，脏定义在 import 期就炸，绝不静默带病解析）。 */
export const SANDBOX_PARAMS: readonly ParameterSpec[] = ParameterSetSchema.parse(
  SANDBOX_PARAMETER_SPECS,
);

/**
 * 解析沙盘参数：注入地区/政策/用户三层覆写 + 本模板的派生注册表，返回引擎的 `ResolveResult`。
 * 这就是 R2 计算引擎应当消费的「当前生效值」唯一真源（§4/§16）：改任一输入 → 这里重解析 →
 * 派生值重算 → 交 R2 重算经济 → 图表/报告联动。默认已挂上 `SANDBOX_DERIVED`，调用方只传覆写层。
 */
export function resolveSandbox(layers: Omit<ResolveLayers, "derived"> = {}): ResolveResult {
  return resolveParameters(SANDBOX_PARAMS, {
    derived: SANDBOX_DERIVED,
    ...layers,
  });
}

/** 无覆写的基线解析（默认参数全量生效）——供冒烟/默认视图/文档示例。 */
export function resolveSandboxBaseline(): ResolveResult {
  return resolveSandbox();
}
