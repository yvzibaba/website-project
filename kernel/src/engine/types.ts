/**
 * V2 领域契约（Domain Contract）—— 生产计算引擎的唯一输入/输出形状。
 *
 * ## 设计立场（对应宪法第 16 条「单一真源」）
 *
 * 本文件只放**契约**：类型 + 判别联合 + 常量版本号。不放任何公式、不 import 任何运行时。
 * 引擎的每个模块都从这里取形状，因此「输入是什么、输出是什么」只有一处定义。
 *
 * ## 严格的五类值域
 *
 * 每个进入计算的数都必须能回答「它是什么」：
 *
 * | 类 | 含义 | 例子 |
 * |---|---|---|
 * | `BENCHMARK` | 行业/地区基准（有来源、时点、置信度） | 山西平段电价、光伏等效小时 |
 * | `SCENARIO`  | 情景假设（客户/项目给定的条件） | 车队规模、日里程、项目期限 |
 * | `DERIVED`   | 由引擎算出的量（不得被当作输入回灌） | 年电量、峰值负荷、NPV |
 * | `ACTUAL`    | 项目落地后的实测值（回流数据） | 实际 CAPEX、实际充电量 |
 * | `UNKNOWN`   | 未核实且**不得偷填** | 缺官方价表的绝对需量电价 |
 *
 * 分类规则：`BENCHMARK` / `SCENARIO` / `ACTUAL` 是输入侧，`DERIVED` 是输出侧，
 * `UNKNOWN` 是**缺口的显式表达**——引擎遇到 UNKNOWN 时继续算可算的部分，并如实登记诊断，
 * 绝不用 0 / 全国平均 / 历史默认值悄悄补齐。
 *
 * ## 三类问题不得混为一谈（对应治理要求）
 *
 * `Diagnostic.kind` 把「模型算错了」「证据没找到」「客户没给条件」「条件自相矛盾」分开：
 *   - `CALCULATION_ERROR`  程序/公式/不变量失败 → **必须修代码**；
 *   - `EVIDENCE_MISSING`   市场参数缺证据 → **不得偷偷改公式**；
 *   - `SCENARIO_INPUT_MISSING` 客户没提供项目条件 → 提示补充或给出区间；
 *   - `CONSTRAINT_VIOLATION` 条件自相矛盾（如充电窗口装不下日需求）→ 给出可执行建议。
 */

/* ═══════════════════════════ 值域分类 ═══════════════════════════ */

export const VALUE_CLASSES = ["BENCHMARK", "SCENARIO", "DERIVED", "ACTUAL", "UNKNOWN"] as const;
export type ValueClass = (typeof VALUE_CLASSES)[number];

/**
 * 基准参数引用（报告/审计层看到的"这个数是从哪来的"）。
 *
 * `value: null` **只允许**出现在 `valueClass === "UNKNOWN"` 上——即「该参数确实存在、
 * 但业界/官方没有可核实数值」。这是显式的缺口表达，不是"忘了填"。
 * 引擎遇到 `UNKNOWN` 时按缺省处理并登记 `EVIDENCE_MISSING` 诊断，绝不用 0 顶替。
 */
export interface BenchmarkRef {
  key: string;
  label: string;
  unit: string;
  value: number | null;
  /**
   * 非数值型基准的口径文本（如分时时段表的钟点划分）。
   * 与 `value` 互斥使用：数值型填 `value`，口径型填 `textValue`。
   */
  textValue?: string;
  valueClass: ValueClass;
  /** 来源描述（人可读）。 */
  source: string;
  /** 认识论标签：FACT / ASSUMPTION / INFERENCE / PREDICTION。 */
  evidenceKind: string;
  /** 0..100 置信度。 */
  confidence: number;
  /** 数据生效起点（YYYY-MM 或 YYYY-MM-DD）。 */
  validFrom?: string;
  /** 数据失效/需重取时点。 */
  validTo?: string;
  /** 可核验来源链接（仅当为合法 http(s) 时才会被认定为 FACT 依据）。 */
  sourceUrl?: string;
  /** 口径说明（含税不含税、AC/DC、口径冲突等）。 */
  note?: string;
  /** 适用地区（"shanxi" / "national" / "global"）。 */
  regionId?: string;
}

/* ═══════════════════════════ 诊断 ═══════════════════════════ */

export const DIAGNOSTIC_KINDS = [
  "CALCULATION_ERROR",
  "EVIDENCE_MISSING",
  "SCENARIO_INPUT_MISSING",
  "CONSTRAINT_VIOLATION",
] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

export interface Diagnostic {
  kind: DiagnosticKind;
  /** 稳定机读码（测试钉桩用），如 `charger_capacity_insufficient`。 */
  code: string;
  /** 面向用户的中文说明（须过公开界面用语规范）。 */
  message: string;
  /** 相关字段路径（如 `truck.dailyMileageKm`），便于 UI 定位。 */
  field?: string;
  /** 对结论的影响（诚实：说清"这会让结果偏乐观/偏保守/无法评价"）。 */
  impact?: string;
  /** 可执行建议（如"增加充电桩数量或缩短单车周转时间"）。 */
  suggestion?: string;
  /** 数值证据（如缺口 kWh），便于前端与报告直接引用。 */
  value?: number;
  unit?: string;
}

/* ═══════════════════════════ 输入契约 ═══════════════════════════ */

/** 选址与资源条件（情景层）。 */
export interface SiteInput {
  /** 地区标识（用于取基准参数，如 "shanxi"）。 */
  regionId: string;
  /** 地区显示名。 */
  regionName: string;
  /** 纬度（度，北纬为正）——光伏几何计算必需。 */
  latitudeDeg: number;
}

/** 重卡车队（情景层 · §8）。 */
export interface TruckFleetInput {
  /** 车队规模（辆）。 */
  truckCount: number;
  /** 单车额定载重（吨）——当前仅作画像与基准校验，不进能量公式。 */
  payloadTons: number;
  /** 单车日均行驶里程（km/运营日）。 */
  dailyMileageKm: number;
  /** 年运营天数（0..365）。 */
  operatingDaysPerYear: number;
  /** 基础能耗（kWh/km，标准工况）。 */
  energyConsumptionKwhPerKm: number;
  /** 季节因子（%）：冬季低温能耗增幅峰值，按年相位正弦施加（0 = 无季节差异）。 */
  seasonalFactorPct: number;
  /** 线路因子（%）：山区/重载线路相对标准工况的能耗修正。 */
  routeFactorPct: number;
  /** 单车电池容量（kWh）。 */
  batteryCapacityKwh: number;
  /** 电量保留系数（%）：不参与日常运输、不用于充电需求计算的余量。 */
  reserveFactorPct: number;
  /** 充电窗口起点（0..24，小时）。 */
  chargingWindowStartHour: number;
  /** 充电窗口终点（小时，可 > 24 表示跨越零点，如 30 = 次日 06:00）。 */
  chargingWindowEndHour: number;
  /** 充电策略：`unmanaged` 回场即充（窗口内平铺）；`managed` 有序充电（向光伏时段倾斜）。 */
  chargingStrategy: ChargingStrategy;
}

export const CHARGING_STRATEGIES = ["unmanaged", "managed"] as const;
export type ChargingStrategy = (typeof CHARGING_STRATEGIES)[number];

/** 充电设施（情景层 · §10）。 */
export interface ChargerInput {
  /** 充电桩数量（台）。 */
  chargerCount: number;
  /** 单桩额定功率（kW）。 */
  chargerPowerKw: number;
  /** 同时率（%）：实际同时运行的功率占比（需求侧多样性系数）。 */
  simultaneousRatePct: number;
  /** 充电链路效率（%）：电网侧→电池侧的往返前段效率。 */
  chargingEfficiencyPct: number;
}

/** 换电站（情景层 · §10，可选）。 */
export interface SwapInput {
  enabled: boolean;
  /** 换电站数量。 */
  stationCount: number;
  /** 单站服务能力（次/小时）。 */
  swapServiceRatePerHour: number;
  /** 电池池规模（块）。 */
  batteryPoolCount: number;
  /** 单块电池容量（kWh）。 */
  batteryEnergyKwh: number;
  /** 单站充电功率（kW）——换电站给电池池充电的受电能力上限。 */
  chargingPowerKwPerStation: number;
  /** 换电链路损耗（%）。 */
  swapEnergyLossPct: number;
}

/** 充换电方案（情景层）：充电与换电的组合，二者至少启用一个。 */
export interface ChargingSolutionInput {
  /** `charging` 纯充电 / `swap` 纯换电 / `hybrid` 混合。 */
  mode: ChargingMode;
  charger: ChargerInput;
  swap: SwapInput;
  /** 混合模式下换电承担的需求比例（%）；`swap` 模式下恒 100。 */
  swapSharePct: number;
}

export const CHARGING_MODES = ["charging", "swap", "hybrid"] as const;
export type ChargingMode = (typeof CHARGING_MODES)[number];

/** 光伏系统（情景层 · §12）。 */
export interface PvInput {
  /** 是否配置光伏。 */
  enabled: boolean;
  /** 装机容量（kWp）。 */
  capacityKwp: number;
  /** 倾角（度）。 */
  tiltDeg: number;
  /** 方位角（度，180 = 正南）。 */
  azimuthDeg: number;
  /**
   * 年等效利用小时（kWh/kWp·年，AC 侧）。**基准层参数**——逐时形状由几何模型给出，
   * 年总量锚定到本值（避免形状与总量各自为政）。
   */
  specificYieldKwhPerKwp: number;
  /** 年衰减率（%/年）。 */
  degradationPctPerYear: number;
}

/** 储能系统（情景层 · §13）。 */
export interface BessInput {
  enabled: boolean;
  /** 额定功率（kW）。 */
  powerKw: number;
  /** 额定容量（kWh）。 */
  energyKwh: number;
  /** 往返效率（%）。 */
  roundTripEfficiencyPct: number;
  /** SOC 下限（%）。 */
  socMinPct: number;
  /** SOC 上限（%）。 */
  socMaxPct: number;
  /** 年容量衰减（%/年）。 */
  degradationPctPerYear: number;
  /** 调度策略。 */
  strategy: BessStrategy;
  /** 初始 SOC（%，默认 50）。 */
  initialSocPct: number;
  /** 年最大等效循环次数（用于容量校核；不参与逐时调度）。 */
  maxCyclesPerYear: number;
}

export const BESS_STRATEGIES = ["arbitrage", "peak-shaving", "pv-shift"] as const;
export type BessStrategy = (typeof BESS_STRATEGIES)[number];

/** 分时电价时段定义（"HH:MM-HH:MM"）。 */
export interface TouWindowSpec {
  /** 谷段时段列表。 */
  valley: string[];
  /** 峰段时段列表。 */
  peak: string[];
}

/** 电网接入（情景层 · §14）。 */
export interface GridInput {
  /** 并网容量 / 受电容量（kW）。 */
  capacityKw: number;
  /** 实际最大受电功率限制（kW，≤ capacityKw）。 */
  importLimitKw: number;
  /** 是否允许余电上网。 */
  exportAllowed: boolean;
  /** 上网功率上限（kW）。 */
  exportLimitKw: number;
  /** 是否启用分时电价。 */
  touEnabled: boolean;
  /** 平段基准电价（元/kWh，含税全口径）——**基准层参数**。 */
  flatPriceYuanPerKwh: number;
  /** 峰段倍率（×平段）。 */
  peakMultiplier: number;
  /** 谷段倍率（×平段）。 */
  valleyMultiplier: number;
  /** 分时时段表。 */
  touWindows: TouWindowSpec;
  /** 需量（容量）电价（元/kW·月）。 */
  demandChargePerKwMonth: number;
  /** 上网电价（元/kWh）。 */
  feedInTariffYuanPerKwh: number;
}

/** 投资与财务假设（情景层 · §16）。 */
export interface EconomicsInput {
  /** 建设期（年）。 */
  constructionYears: number;
  /** 运营期（年）。 */
  projectLifeYears: number;
  /** 折现率（%）。 */
  discountRatePct: number;
  /** 通胀率（%/年，名义现金流放大）。 */
  inflationPct: number;
  /** 所得税率（%）。 */
  incomeTaxPct: number;
  /** 期末残值率（% of 有形资产原值）。 */
  residualValuePct: number;
  /** 资本金比例（%）；用于贷款口径与债务规模。 */
  equityRatioPct: number;
  /** 贷款利率（%/年，名义）。 */
  loanInterestPct: number;
  /** 贷款期限（年）。 */
  loanTermYears: number;
  /** 光伏单位投资（元/W）。 */
  pvCapexYuanPerW: number;
  /** 储能单位投资（元/Wh）。 */
  bessCapexYuanPerWh: number;
  /** 充电桩单位投资（元/kW）。 */
  chargerCapexYuanPerKw: number;
  /** 换电站单位投资（元/站）。 */
  swapStationCapexYuanPerStation: number;
  /** 并网/增容单位投资（元/kW）。 */
  gridCapexYuanPerKw: number;
  /** 土建及其他单位投资（元/kW 充电装机）。 */
  civilCapexYuanPerChargerKw: number;
  /** 光伏年运维（元/kWp·年）。 */
  pvOpexYuanPerKwpYear: number;
  /** 储能年运维（元/kWh·年）。 */
  bessOpexYuanPerKwhYear: number;
  /** 充电桩年运维（元/kW·年）。 */
  chargerOpexYuanPerKwYear: number;
  /** 场站固定年运维（元/年）。 */
  siteFixedOpexYuanPerYear: number;
  /** 土地年租金（元/年）。 */
  landRentYuanPerYear: number;
  /** 保险及管理费率（% of 有形资产原值·年）。 */
  insurancePctOfCapex: number;
  /** 充电服务费单价（元/kWh，向车队收取）。 */
  chargingServiceFeeYuanPerKwh: number;
  /** 换电服务费单价（元/kWh）。 */
  swapServiceFeeYuanPerKwh: number;
  /**
   * 向车队结算的**转供电价**（元/kWh）——即车队为"电本身"支付的价格，不含服务费。
   *
   * 这一项不能省：运营方向电网买电、再向车队收电费，**电费是过手成本**。
   * 如果只记购电支出、不记代收电费，那么每卖出一度电都会凭空产生一笔亏损，
   * 项目在模型里永远不赚钱——而现实中的运营方并不会自掏腰包替车队付电费。
   *
   * 口径：填 `0` 表示**平价转供**（按运营方自己的加权平均到户电价代收，不赚电费差价），
   * 这是未取得结算协议时的缺省口径；若已约定转供电价，请按约定填写。
   */
  electricityResalePriceYuanPerKwh: number;
  /** 其他服务收入（元/年，如场地、维保）。 */
  otherRevenueYuanPerYear: number;
  /** 建设补贴比例（% of 有形资产原值）。 */
  constructionSubsidyPct: number;
  /** 运营补贴强度（元/kWh 充电量）。 */
  operationSubsidyYuanPerKwh: number;
}

/** 情景**输入**（唯一权威输入形状）。 */
export interface ScenarioInput {
  /** 契约版本。 */
  schemaVersion: string;
  /** 情景名（用户可改）。 */
  name: string;
  /** 声明式场景组合（哪些设施参与本次计算）。 */
  definition: ScenarioDefinition;
  site: SiteInput;
  truck: TruckFleetInput;
  charging: ChargingSolutionInput;
  pv: PvInput;
  bess: BessInput;
  grid: GridInput;
  economics: EconomicsInput;
  /**
   * 显式声明的未知项（`参数路径 → 原因`）。引擎遇到这些字段时**不使用**其数值，
   * 而是登记 `EVIDENCE_MISSING` 诊断并按其影响继续计算（§29 不偷填）。
   */
  unknowns?: Record<string, string>;
  /** 情景备注（自由文本，不参与计算）。 */
  note?: string;
}

/**
 * 声明式场景定义（§17：**不硬编码场景名**）。
 *
 * 场景 = 一组"哪些能力参与"的开关 + 覆写。新增组合（如"光伏+换电+需量优化"）
 * 只需组合开关，不需要在引擎里加分支。
 */
export interface ScenarioDefinition {
  /** 稳定标识（如 "GT-001" / "grid-only"）。 */
  id: string;
  /** 展示名。 */
  label: string;
  /** 该场景参与计算的能力集合（按需组合，顺序无关）。 */
  components: ScenarioComponent[];
  /** 是否启用有序充电（削峰）。 */
  managedCharging: boolean;
  /** 一句话说明（用于报告"这个场景意味着什么"）。 */
  intent: string;
}

export const SCENARIO_COMPONENTS = ["PV", "BESS", "GRID", "CHARGING", "SWAP", "TOU", "DEMAND_CHARGE"] as const;
export type ScenarioComponent = (typeof SCENARIO_COMPONENTS)[number];

/* ═══════════════════════════ 输出契约 ═══════════════════════════ */

/** 15 分钟序列（长度恒为 `STEPS_PER_YEAR`）。 */
export type TimeSeries = readonly number[];

/**
 * 重卡需求结果（§8）。
 *
 * **口径总纲**：本结构全部为「需求侧」量——即**未施加设备功率与调度约束前**的
 * 理论需求，用于回答"这个项目需要多少电"。实际能交付多少由充电层（§9/§10）给出，
 * 两者在无约束时应当接近（差异仅来自跨年切边的归集方式），有约束时需求 ≥ 交付。
 * 因此 `annualEnergyDemandKwh` 与 `ChargingResult.annualGridSideKwh` **不要求逐分相等**，
 * 但不允许出现"交付 > 需求 + 溢出"这种方向性错误。
 */
export interface TruckDemandResult {
  /**
   * 年总能量需求（kWh/年，**电网/发电机侧**口径，已含充电链路效率损失）。
   *
   * 只统计落在本年日历内的部分；跨年切边量单列在 `TruckDemandComputation.yearBoundarySpillKwh`，
   * 由此保证「逐月之和 === 本字段」严格闭合。
   */
  annualEnergyDemandKwh: number;
  /** 年总能量需求（kWh/年，**电池侧**口径，未含效率损失）。 */
  annualEnergyAtBatteryKwh: number;
  /** 日均能量需求（kWh/运营日，**电网侧**口径，与 `annualEnergyDemandKwh` 同口径）。 */
  dailyEnergyDemandKwh: number;
  /** 逐月能量需求（kWh，长度 12，**电网侧**口径；逐月之和 === `annualEnergyDemandKwh`）。 */
  monthlyEnergyDemandKwh: number[];
  /** 日均能量需求（kWh/运营日，**电池侧**口径）。 */
  dailyEnergyAtBatteryKwh: number;
  /** 逐月能量需求（kWh，长度 12，**电池侧**口径）。 */
  monthlyEnergyAtBatteryKwh: number[];
  /** 年运营天数（实际生效值）。 */
  operatingDays: number;
  /** 充电窗口内可用的时长（小时）。 */
  chargingWindowHours: number;
  /** 峰值充电负荷（kW，需求侧未受限的理论峰值，按**桩输出侧**口径）。 */
  peakChargingLoadKw: number;
  /** 平均充电负荷（kW，窗口内平均，按**桩输出侧**口径）。 */
  averageChargingLoadKw: number;
  /** 15 分钟能量需求序列（kWh/步，**电池侧**口径；仅供充电层做负荷形状分配）。 */
  demandProfileKwh: TimeSeries;
  /**
   * 年末充电窗口越界、实际将在次年交付的电量（kWh/年，**电网侧**口径）。
   *
   * 单列而不并入 `annualEnergyDemandKwh`：这是"自然年切了一刀"的**口径**差异，
   * 不是"装不下"的**能力**缺陷。混在一起会让报告把口径差说成配置缺陷。
   */
  yearBoundarySpillKwh: number;
  /** 同上，但为**电池侧**口径（与 `annualEnergyAtBatteryKwh` 同口径）。 */
  yearBoundarySpillAtBatteryKwh: number;
}

/** 充换电结果（§9/§10）。 */
export interface ChargingResult {
  /** 站点侧负荷（kW，15 分钟，**电网侧口径**，已含效率损失）。 */
  loadProfileKw: TimeSeries;
  /** 年交付量合计（kWh，电池侧 = 充电交付 + 换电交付）。 */
  annualDeliveredKwh: number;
  /** 其中：充电交付到车（kWh，电池侧）——充电服务费计费口径。 */
  annualChargingDeliveredKwh: number;
  /** 其中：换电交付到车（kWh，电池侧）——换电服务费计费口径。 */
  annualSwapDeliveredKwh: number;
  /** 年电网侧取电量（kWh，含损失）。 */
  annualGridSideKwh: number;
  /** 站点装机功率（kW）。 */
  installedPowerKw: number;
  /** 有效并发功率（kW = 装机 × 同时率）。 */
  effectivePowerKw: number;
  /** 峰值负荷（kW，实际曲线峰值）。 */
  peakLoadKw: number;
  /** 站级利用率（% = 年充电量 ÷ (有效功率 × 窗口年小时数)）。 */
  utilizationPct: number;
  /** 未满足的能量（kWh/年，>0 表示配置不足）。 */
  unservedEnergyKwh: number;
  /** 换电站年服务次数。 */
  annualSwapEvents: number;
  /** 换电站年取电量（kWh，电网侧）。 */
  swapGridSideKwh: number;
  /**
   * 因**年度边界截断**而落在次年、未计入本年的电量（kWh/年）。
   *
   * 为什么单列而不并入"未满足需求"：两者含义完全不同——一个是"装不下"（配置问题，
   * 必须解决），一个是"自然年切了一刀"（口径问题，跨年那部分本来就会在次年交付）。
   * 混在一起会让报告把口径差异说成能力缺陷。
   */
  yearBoundarySpillKwh: number;
  /** 逐月站点负荷峰值（kW，长度 12，供报告展示负荷爬坡与容量校核）。 */
  monthlyPeakLoadKw: number[];
}

/** 光伏结果（§12）。 */
export interface PvResult {
  /** 15 分钟出力（kW，AC 侧）。 */
  outputProfileKw: TimeSeries;
  /** 年发电量（kWh）。 */
  annualGenerationKwh: number;
  /** 逐月发电量（kWh，长度 12）。 */
  monthlyGenerationKwh: number[];
  /** 年自发自用量（kWh）。 */
  selfConsumedKwh: number;
  /** 年上网量（kWh）。 */
  exportedKwh: number;
  /** 年弃光量（kWh）。 */
  curtailedKwh: number;
  /** 自用率（%）。 */
  selfConsumptionPct: number;
  /** 充电负荷的光伏覆盖率（% = 自用量 ÷ 充电取电量）。 */
  chargingCoveragePct: number;
}

/** 储能结果（§13）。 */
export interface BessResult {
  /** 充电功率序列（kW，正 = 从母线取电）。 */
  chargeProfileKw: TimeSeries;
  /** 放电功率序列（kW，正 = 向母线送电）。 */
  dischargeProfileKw: TimeSeries;
  /** SOC 序列（%）。 */
  socProfilePct: TimeSeries;
  /** 年充电量（kWh，交流侧）。 */
  annualChargeKwh: number;
  /** 年放电量（kWh，交流侧）。 */
  annualDischargeKwh: number;
  /** 年等效循环次数。 */
  equivalentCycles: number;
  /** 年价差套利收益（元）。 */
  arbitrageBenefitYuan: number;
  /** 年需量削峰收益（元）。 */
  demandChargeSavingYuan: number;
  /** 年末 SOC（%）。 */
  finalSocPct: number;
  /** SOC 越界次数（必须为 0，否则为不变量失败）。 */
  socViolations: number;
}

/** 电网结果（§14）。 */
export interface GridResult {
  /** 逐时下网电量（kWh/步）。 */
  importProfileKwh: TimeSeries;
  /** 逐时上网电量（kWh/步）。 */
  exportProfileKwh: TimeSeries;
  /** 逐时到户电价（元/kWh）。 */
  priceProfileYuanPerKwh: TimeSeries;
  /** 逐时弃光（kWh/步）。 */
  curtailmentProfileKwh: TimeSeries;
  /** 年下网电量（kWh）。 */
  annualImportKwh: number;
  /** 年上网电量（kWh）。 */
  annualExportKwh: number;
  /** 年电量电费（元）。 */
  annualEnergyCostYuan: number;
  /** 年上网收入（元）。 */
  annualExportRevenueYuan: number;
  /** 年需量电费（元）。 */
  annualDemandChargeYuan: number;
  /** 年电网侧总成本（元 = 电量电费 + 需量电费 − 上网收入）。 */
  annualGridCostYuan: number;
  /** 加权平均到户电价（元/kWh；无下网电量 → null）。 */
  weightedAveragePriceYuanPerKwh: number | null;
  /** 逐月最大下网需量（kW，长度 12）——需量电费的计费依据。 */
  monthlyPeakImportKw: number[];
  /** 电网容量是否成为约束（是否有因受限而未满足的能量）。 */
  capacityConstrained: boolean;
}

/** 能量平衡不变量校验结果（§15/§33）。 */
export interface EnergyBalanceInvariant {
  /** 是否全部通过。 */
  ok: boolean;
  /** 违反守恒的时段数。 */
  violationCount: number;
  /** 最大绝对偏差（kWh/步）。 */
  maxAbsDeviationKwh: number;
  /** 判定容差（kWh/步）。 */
  toleranceKwh: number;
  /** 首个违反时段的详情（供定位，最多 3 条）。 */
  samples: Array<{ step: number; lhsKwh: number; rhsKwh: number; deviationKwh: number }>;
  /** 年总能量口径的守恒偏差（kWh/年）。 */
  annualDeviationKwh: number;
}

/** 年度现金流与评价指标（§16）。 */
export interface EconomicsResult {
  capex: {
    pvYuan: number;
    bessYuan: number;
    chargerYuan: number;
    swapYuan: number;
    gridYuan: number;
    civilYuan: number;
    contingencyYuan: number;
    grossYuan: number;
    subsidyYuan: number;
    netYuan: number;
  };
  opexY1: {
    pvYuan: number;
    bessYuan: number;
    chargerYuan: number;
    siteFixedYuan: number;
    landYuan: number;
    insuranceYuan: number;
    grossYuan: number;
  };
  revenueY1: {
    chargingServiceYuan: number;
    swapServiceYuan: number;
    electricityResaleYuan: number;
    operationSubsidyYuan: number;
    otherYuan: number;
    grossYuan: number;
  };
  /** 首年运营成本合计（元）= 购电成本 + OPEX）。 */
  costY1Yuan: number;
  /** 首年税前净现金流（元）。 */
  netCashFlowY1PreTaxYuan: number;
  /**
   * 逐年税后净现金流（元）。
   *
   * 长度 = `constructionYears + projectLifeYears`；下标 `0..constructionYears-1` 为建设期
   * （负值 = 资本支出摊分），其后为运营期各年。期末残值计入最后一个运营年。
   */
  annualCashFlowYuan: number[];
  /**
   * 逐年税后净现金流（元，**资本金口径**，已扣利息与还本）。长度同 `annualCashFlowYuan`。
   *
   * 与 `annualCashFlowYuan` 一样逐分量化：留档即真源，审计方可以只拿这两条
   * 现金流数组，独立复算出全部 NPV/IRR/回收期，无需重跑模型。
   */
  equityCashFlowYuan: number[];
  metrics: {
    npvYuan: number;
    irr: { ok: boolean; valuePct?: number; reason?: string };
    simplePaybackYears: number | null;
    discountedPaybackYears: number | null;
    roiRatio: { ok: boolean; value?: number; reason?: string };
    /**
     * 全生命周期度电成本（元/kWh）——**自有成本口径**：
     * 分子 = 净投资 + 运营期运维成本的现值；分母 = 交付电量的现值。
     *
     * 为什么不含购电成本：转供电费是**过手成本**（车队另付、运营方代收），
     * 把它算进来会让"度电成本"与"服务费单价"无法直接比较——而这两者正是最该放在一起看的。
     */
    lcoeYuanPerKwh: number | null;
    /**
     * **资本金口径**（含贷款利息与还本），回答"我自己出的这笔钱回报如何"。
     *
     * 与上面的全投资口径并列而非替代：全投资口径衡量"这个项目本身值不值得做"（与融资结构无关），
     * 资本金口径衡量"按这个融资方案，股东的钱划不划算"。两者混用会得出错误结论——
     * 例如把"全投资资本支出"和"还本付息"同时计入现金流，会把同一笔钱扣两次。
     */
    equity: {
      /** 资本金净现值（元）。 */
      npvYuan: number;
      /** 资本金内部收益率。 */
      irr: { ok: boolean; valuePct?: number; reason?: string };
      /** 资本金静态回收期（年）。 */
      simplePaybackYears: number | null;
    };
  };
  /** 静态投资回收期内的累计净现金流（元，逐年，供报告画图）。 */
  cumulativeCashFlowYuan: number[];
}

/** 敏感性（tornado）一根条。 */
export interface SensitivityBar {
  /** 变量标识。 */
  key: string;
  /** 展示名。 */
  label: string;
  /** 基准值。 */
  baseValue: number;
  unit: string;
  /** 下调后的 NPV（元）。 */
  npvAtLow: number;
  /** 上调后的 NPV（元）。 */
  npvAtHigh: number;
  /** 下行扰动幅度（%）。 */
  deltaLowPct: number;
  /** 上行扰动幅度（%）。 */
  deltaHighPct: number;
  /** 摆幅（元 = |npvAtHigh − npvAtLow|），用于排序。 */
  swingYuan: number;
}

/** 风险条目（§18）。 */
export interface RiskItem {
  id: string;
  title: string;
  /** 高/中/低。 */
  severity: "high" | "medium" | "low";
  /** 触发依据（必须引用具体数值或诊断码，不许空泛）。 */
  basis: string;
  /** 缓解建议。 */
  mitigation: string;
}

/** 决策结果（§18）。 */
export interface DecisionResult {
  /** 项目是否可行（基于硬约束 + 经济门槛）。 */
  feasibility: {
    feasible: boolean;
    /** 判定为不可行的原因（空数组 = 可行）。 */
    blockers: string[];
    /** 通过/未通过的判据逐条列出（可审计）。 */
    checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
  };
  /** 推荐配置（本情景是否被推荐 + 理由）。 */
  recommendation: {
    recommended: boolean;
    /** 一句话推荐语。 */
    headline: string;
    /** 逐条理由（每条必须带数值）。 */
    reasons: string[];
    /** 不推荐时的原因。 */
    concerns: string[];
  };
  /** 关键驱动（按敏感性摆幅排序的展示文本）。 */
  keyDrivers: Array<{ key: string; label: string; swingYuan: number; text: string }>;
  /** 敏感性分析（tornado）。 */
  sensitivity: SensitivityBar[];
  /** 风险清单。 */
  risks: RiskItem[];
  /** 必须人工确认的关键假设（低置信 / ASSUMPTION 输入）。 */
  criticalAssumptions: Array<{
    key: string;
    label: string;
    value: number | string;
    unit?: string;
    /** 认识论标签。 */
    evidenceKind: string;
    confidence: number;
    /** 若不成立会怎样。 */
    impactIfWrong: string;
  }>;
  /** 程序生成的决策解释（可追溯，非 LLM）——回答"为什么推荐这个方案"。 */
  explanation: {
    summary: string;
    paragraphs: string[];
    /** 结论溯源链（输入 → 公式 → 情景 → 引擎版本）。 */
    traceability: {
      engineVersion: string;
      modelVersion: string;
      scenarioId: string;
      benchmarkVersion: string;
      /** 关键结论引用的具体数值。 */
      cited: Array<{ label: string; value: number; unit: string }>;
    };
  };
}

/** 一次完整计算的产物。 */
export interface CalculationResult {
  ok: true;
  /** 计算引用（= `calc@<ENGINE_VERSION>`），用于追溯。 */
  calcRef: string;
  engineVersion: string;
  modelVersion: string;
  /**
   * 模型构成（各子模型版本号的连接串，如 `time@1.0.0+truck@1.0.0+…`）。
   *
   * 与 `modelVersion` 分工：`modelVersion` 是**给人看的语义版本**，本字段是**给审计看的构成明细**。
   * 任一子模型升版都会在这里出现，因此"结果为什么变了"不必靠猜。
   */
  modelComposition: string;
  /**
   * **本次计算的输入快照**（原样留档）。
   *
   * 为什么把输入放进结果里：报告要能"用同一份输入完整复算"。如果输入散落在数据库各处、
   * 而结果只记一个 `inputHash`，那么半年后有人问"这个数是怎么来的"时，哈希只能证明
   * "输入变过"，不能回答"当时输入是什么"。留档一份输入是让结论**可被推翻也可被重演**的最低成本。
   */
  inputSnapshot: ScenarioInput;
  /** 情景名与定义 id（报告头用）。 */
  scenarioId: string;
  scenarioLabel: string;
  /** 输入快照的**内容哈希**（同一输入 → 同一哈希 → 可复算校验）。 */
  inputHash: string;
  /** 时间轴口径。 */
  timeStepMinutes: number;
  stepsPerYear: number;
  /** 基准参数版本与本次实际引用的基准快照（键 → 带来源的引用）。 */
  benchmarkVersion: string;
  benchmarkSnapshot: Record<string, BenchmarkRef>;
  truckDemand: TruckDemandResult;
  charging: ChargingResult;
  pv: PvResult;
  bess: BessResult;
  grid: GridResult;
  invariant: EnergyBalanceInvariant;
  economics: EconomicsResult;
  decision: DecisionResult;
  /** 诊断清单（三类问题分列，不得混谈）。 */
  diagnostics: Diagnostic[];
  /** 恒为 true：结论需要专业人工确认（诚实边界）。 */
  needsProfessionalReview: true;
  /** 计算耗时（毫秒，供性能观测；不参与任何结论）。 */
  elapsedMs?: number;
}

export interface CalculationFailure {
  ok: false;
  calcRef: string;
  /** 致命失败原因。 */
  reason: "invalid_input" | "invariant_violation" | "calculation_error";
  detail: string;
  diagnostics: Diagnostic[];
}

export type CalculationOutcome = CalculationResult | CalculationFailure;

/* ═══════════════════════════ 报告 ═══════════════════════════ */

export type ReportSectionKind = "paragraph" | "key-values" | "bullets" | "table";

export interface ReportSection {
  /** 段标识（稳定，供 UI 锚点）。 */
  id: string;
  title: string;
  kind: ReportSectionKind;
  paragraphs?: string[];
  items?: Array<{ label: string; value: string; hint?: string }>;
  bullets?: string[];
  table?: { columns: string[]; rows: string[][] };
}

export interface DecisionReport {
  reportVersion: string;
  title: string;
  /** 报告头：可复算所需的一切。 */
  provenance: {
    scenarioId: string;
    scenarioLabel: string;
    engineVersion: string;
    modelVersion: string;
    benchmarkVersion: string;
    inputHash: string;
    timeStepMinutes: number;
    generatedAtIso: string;
  };
  /** 输入快照（可完整复算）。 */
  inputSnapshot: ScenarioInput;
  sections: ReportSection[];
  /** 常驻免责声明（不得省略）。 */
  disclaimer: string;
}

/** 报告契约版本。 */
export const REPORT_VERSION = "1.0.0";
/** 情景输入契约版本。 */
export const SCENARIO_SCHEMA_VERSION = "1.0.0";
