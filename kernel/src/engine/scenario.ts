/**
 * 情景层（Scenario）—— 把"要不要装光伏、要不要上储能、是不是换电"这类**组合选择**
 * 表达成**声明式数据**，而不是 `if (scenarioName === "光伏+储能")` 这样的分支。
 *
 * ## 为什么必须声明式（这是本层存在的唯一理由）
 *
 * 客户的组合是开放的：纯电网、光伏+充电、光伏+储能+有序充电、纯换电、换电+光伏…
 * 如果每加一种组合就要在引擎里加一个分支，那么：
 *   - 组合数会指数增长，分支永远追不上客户问法；
 *   - 每个分支都要单独测试，且很容易出现"某个分支忘了算某项成本"的静默错误。
 *
 * 声明式的做法是把组合拆成**能力开关**（`ScenarioComponent[]`），再让**同一个**计算路径
 * 按开关取值。于是"新增一种组合"= 改一行数据，引擎一行代码都不动。
 *
 * ## 三层分工
 *
 * | 层 | 谁提供 | 例子 |
 * |---|---|---|
 * | 基准层 | 本仓库的 `benchmark.ts`（带来源/时点/置信度） | 峰谷倍率、单位投资、等效小时 |
 * | 情景层 | 本文件的 seed + 用户在界面上的填写 | 车队规模、日里程、装机容量、服务费 |
 * | 结果层 | `engine.ts` 编排产出 | 年电量、峰荷、NPV |
 *
 * 本文件**只做**两件事：① 给基准层参数一个可运行的缺省值；② 把组件开关落到各子输入的
 * `enabled` / `touEnabled` / `demandChargePerKwMonth` 上。**不做任何物理计算**。
 *
 * ## 关于"不得偷填"的一条硬规则
 *
 * 山西的充电服务费实行**市场调节价**（`benchmark.ts` 里明确标为 `UNKNOWN`），没有官方水平值。
 * 因此 `chargingServiceFeeYuanPerKwh` 在本文件中**是必填项、没有默认值**：
 * 它属于"经营者自己的定价决策"，不是"可以去查的行情"。缺了它就让调用方显式声明，
 * 而不是悄悄给一个 0.4 元/kWh 让它看起来像个完整方案。
 */

import { benchmarkNumber, getBenchmark } from "@app/kernel/engine/benchmark";
import {
  SCENARIO_COMPONENTS,
  SCENARIO_SCHEMA_VERSION,
} from "@app/kernel/engine/types";
import type {
  BessInput,
  BessStrategy,
  ChargerInput,
  ChargingMode,
  ChargingSolutionInput,
  Diagnostic,
  EconomicsInput,
  GridInput,
  PvInput,
  ScenarioComponent,
  ScenarioDefinition,
  ScenarioInput,
  SiteInput,
  SwapInput,
  TruckFleetInput,
} from "@app/kernel/engine/types";

export const SCENARIO_BUILDER_VERSION = "1.0.0";

/**
 * 储能调度策略随「是否配置光伏」的映射规则。
 *
 * 抽成函数而不是内联两句 `has("PV") ? … : …`，是为了让**自动推荐层复用同一条规则**：
 * 推荐器在启用/停用光伏时会重建储能策略，如果两处各写一份判断，迟早出现
 * 「构造器给 pv-shift、推荐器给 peak-shaving」的分裂——而这种分裂**不会报错**，
 * 只表现为同一个配置算出两个不同的数。凡是"同一件事的两处判断"，都必须收成一处。
 */
export function bessStrategyFor(hasPv: boolean): BessStrategy {
  return hasPv ? "pv-shift" : "peak-shaving";
}

/* ═══════════════════════════ 组件开关 ═══════════════════════════ */

const COMPONENT_SET = new Set<string>(SCENARIO_COMPONENTS);

/** 去重 + 去非法项 + 稳定排序（顺序无关，保证同一组开关哈希一致）。 */
export function normalizeComponents(components: readonly string[]): ScenarioComponent[] {
  const seen = new Set<string>();
  const out: ScenarioComponent[] = [];
  for (const c of SCENARIO_COMPONENTS) {
    // 按官方顺序遍历，保证输出顺序确定（不依赖输入顺序 → 输入哈希稳定）
    if (components.includes(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** 非法组件名（会登记诊断，但不中断计算）。 */
function illegalComponents(components: readonly string[]): string[] {
  return components.filter((c) => !COMPONENT_SET.has(c));
}

/**
 * 规整一个场景定义：组件去重排序、补齐校验。
 *
 * 校验规则（**只做逻辑一致性校验，不做业务偏好判断**）：
 *   - 至少要有 `GRID`（没有电网的站点不是本项目要解的问题）；
 *   - `SWAP` 与 `CHARGING` 不能同时缺失（否则没有任何补能手段）。
 */
export function normalizeScenarioDefinition(def: ScenarioDefinition): {
  definition: ScenarioDefinition;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const bad = illegalComponents(def.components);
  if (bad.length) {
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "unknown_scenario_component",
      message: `场景「${def.label}」包含无法识别的能力项：${bad.join("、")}，已忽略。`,
      field: "definition.components",
      suggestion: `可用能力项为：${SCENARIO_COMPONENTS.join("、")}。`,
    });
  }
  let components = normalizeComponents(def.components);

  if (!components.includes("GRID")) {
    components = normalizeComponents([...components, "GRID"]);
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "grid_component_forced",
      message: `场景「${def.label}」未声明电网接入，已自动补上（本站点以电网为基准电源）。`,
      field: "definition.components",
    });
  }
  if (!components.includes("CHARGING") && !components.includes("SWAP")) {
    components = normalizeComponents([...components, "CHARGING"]);
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "no_charging_path",
      message: `场景「${def.label}」既没有充电也没有换电能力，无法为车辆补能，已按纯充电处理。`,
      field: "definition.components",
      suggestion: "请至少选择一种补能方式（充电 / 换电）。",
    });
  }

  return {
    definition: {
      id: def.id,
      label: def.label,
      components,
      managedCharging: !!def.managedCharging,
      intent: def.intent,
    },
    diagnostics,
  };
}

/**
 * 场景模板库（**纯数据**）。
 *
 * 这里的 `id` 只用于展示与持久化，**引擎任何位置都不得按 id 分支**——
 * 参与计算的只有 `components` 与 `managedCharging` 两个字段。
 */
export const SCENARIO_TEMPLATES: readonly ScenarioDefinition[] = [
  {
    id: "grid-only",
    label: "纯电网充电",
    components: ["GRID", "CHARGING"],
    managedCharging: false,
    intent: "只靠电网购电补能，作为其他方案的对照基准（一切增值措施都与它比）。",
  },
  {
    id: "grid-tou",
    label: "电网 + 分时电价引导",
    components: ["GRID", "CHARGING", "TOU"],
    managedCharging: false,
    intent: "在纯电网基础上按峰谷分时电价引导充电时段，用调度换电价，不增加设备投资。",
  },
  {
    id: "pv-charging",
    label: "光伏 + 充电",
    components: ["GRID", "CHARGING", "PV", "TOU"],
    managedCharging: true,
    intent: "用光伏抵一部分购电量；配合有序充电把充电需求向白天光伏时段挪。",
  },
  {
    id: "pv-bess-tou",
    label: "光伏 + 储能 + 有序充电",
    components: ["GRID", "CHARGING", "PV", "BESS", "TOU"],
    managedCharging: true,
    intent: "白天光伏给储能充电、夜间放电供车；同时压低晚高峰需量。",
  },
  {
    id: "swap-grid",
    label: "换电站 + 电网",
    components: ["GRID", "SWAP", "TOU"],
    managedCharging: false,
    intent: "以换电替代充电，电池池集中在谷段充电，换取补能时间与站点功率。",
  },
  {
    id: "full",
    label: "光伏 + 储能 + 充换电一体",
    components: ["GRID", "CHARGING", "SWAP", "PV", "BESS", "TOU"],
    managedCharging: true,
    intent: "充电与换电并存、光伏与储能共同降本，投资最大、收益上限也最高。",
  },
];

export function getScenarioTemplate(id: string): ScenarioDefinition | undefined {
  return SCENARIO_TEMPLATES.find((t) => t.id === id);
}

/* ═══════════════════════════ 基准取值助手 ═══════════════════════════ */

/**
 * 情景构造器实际会查阅的**全部基准键**（含 UNKNOWN 项）。
 *
 * 用途：引擎用它生成"本次计算引用了哪些基准"的快照。之所以在这里显式列清单、而不去扫描
 * 代码里出现过的 key，是为了让"我引用了哪些数据"变成**可审阅的一行行字**——
 * 少一行就会在报告的"关键假设"里少一条，这种漏报比算错更难被发现。
 */
export const SCENARIO_BENCHMARK_KEYS: readonly string[] = [
  "grid.tou.peakMultiplier",
  "grid.tou.valleyMultiplier",
  "grid.flatPriceYuanPerKwh",
  "grid.demandChargePerKwMonth",
  "grid.demandChargeNominalYuanPerKwMonth",
  "grid.feedInTariffYuanPerKwh",
  "pv.specificYieldKwhPerKwp",
  "pv.degradationPctPerYear",
  "bess.roundTripEfficiencyPct",
  "bess.socMinPct",
  "bess.socMaxPct",
  "bess.degradationPctPerYear",
  "truck.energyConsumptionKwhPerKm",
  "truck.seasonalFactorPct",
  "truck.routeFactorPct",
  "truck.reserveFactorPct",
  "charging.chargingEfficiencyPct",
  "charging.simultaneousRatePct",
  "charging.serviceFeeLevelYuanPerKwh",
  "economics.contingencyPct",
  "economics.discountRatePct",
  "economics.inflationPct",
  "economics.incomeTaxPct",
  "economics.residualValuePct",
  "economics.equityRatioPct",
  "economics.loanInterestPct",
  "economics.pvCapexYuanPerW",
  "economics.bessCapexYuanPerWh",
  "economics.chargerCapexYuanPerKw",
  "economics.swapStationCapexYuanPerStation",
  "economics.gridCapexYuanPerKw",
  "economics.civilCapexYuanPerChargerKw",
  "economics.pvOpexYuanPerKwpYear",
  "economics.bessOpexYuanPerKwhYear",
  "economics.chargerOpexYuanPerKwYear",
  "economics.siteFixedOpexYuanPerYear",
  "economics.landRentYuanPerYear",
  "economics.insurancePctOfCapex",
];

function bm(key: string, regionId: string, fallback: number): number {
  const v = benchmarkNumber(key, regionId);
  return v === undefined ? fallback : v;
}

/* ═══════════════════════════ Seed → ScenarioInput ═══════════════════════════ */

export interface ScenarioSeed {
  name: string;
  definition: ScenarioDefinition;

  site?: Partial<SiteInput>;
  truck?: Partial<TruckFleetInput>;
  chargingMode?: ChargingMode;
  charger?: Partial<ChargerInput>;
  swap?: Partial<SwapInput>;
  swapSharePct?: number;
  pv?: Partial<PvInput>;
  bess?: Partial<BessInput>;
  grid?: Partial<GridInput>;
  economics?: Partial<EconomicsInput>;

  /**
   * **必填**：充电服务费单价（元/kWh）。
   *
   * 为什么必填而不能有默认值：山西服务费实行**市场调节价**（官方明确由经营者自主定价），
   * 行业水平没有官方数值。给它一个默认值就等于把"编造的市场价"混进结论，
   * 而报告会看起来完全正常——这是本仓库最不允许的失败模式。
   */
  chargingServiceFeeYuanPerKwh: number;

  /** 换电服务费单价（元/kWh）；未启用换电时可不填。 */
  swapServiceFeeYuanPerKwh?: number;
  /** 向车队结算的转供电价（元/kWh）；不填 = 平价转供（按加权平均到户电价代收）。 */
  electricityResalePriceYuanPerKwh?: number;

  unknowns?: Record<string, string>;
  note?: string;
}

/** 默认站点（山西太原纬度；仅作几何计算的纬度输入，不改任何电价）。 */
export const DEFAULT_SITE: SiteInput = {
  regionId: "shanxi",
  regionName: "山西省",
  latitudeDeg: 37.87,
};

/** 默认重卡车队画像（可被 seed 覆盖；所有数值都会进入报告的可复算快照）。 */
export const DEFAULT_TRUCK: TruckFleetInput = {
  truckCount: 30,
  payloadTons: 49,
  dailyMileageKm: 300,
  operatingDaysPerYear: 330,
  energyConsumptionKwhPerKm: 1.4,
  seasonalFactorPct: 18,
  routeFactorPct: 10,
  batteryCapacityKwh: 422,
  reserveFactorPct: 15,
  chargingWindowStartHour: 21,
  chargingWindowEndHour: 30,
  chargingStrategy: "unmanaged",
};

export const DEFAULT_CHARGER: ChargerInput = {
  chargerCount: 10,
  chargerPowerKw: 240,
  simultaneousRatePct: 85,
  chargingEfficiencyPct: 92,
};

export const DEFAULT_SWAP: SwapInput = {
  enabled: false,
  stationCount: 1,
  swapServiceRatePerHour: 20,
  batteryPoolCount: 30,
  batteryEnergyKwh: 282,
  chargingPowerKwPerStation: 1200,
  swapEnergyLossPct: 8,
};

/** 山西分时时段的口径（浮动比例已核实；钟点划分属待人工复核的默认值，见基准层说明）。 */
export const DEFAULT_TOU_WINDOWS = {
  valley: ["23:00-07:00"],
  peak: ["08:00-11:00", "18:00-23:00"],
};

/**
 * 由 seed 构造**唯一权威输入**（`ScenarioInput`）。
 *
 * 组件开关 → 子输入 `enabled` 的映射是这里唯一"逻辑"的地方，且只做**机械映射**：
 *   - 组件里没有 `PV` → `pv.enabled = false`（并且容量归零由经济层再次确认）；
 *   - 组件里没有 `TOU` → `grid.touEnabled = false`（全时段平段价）；
 *   - 组件里没有 `DEMAND_CHARGE` → 需量电价按 0 计（山西集中式充换电本就免征）。
 */
export function buildScenarioInput(seed: ScenarioSeed): {
  input: ScenarioInput;
  diagnostics: Diagnostic[];
} {
  const { definition, diagnostics: defDiag } = normalizeScenarioDefinition(seed.definition);
  const diagnostics: Diagnostic[] = [...defDiag];

  const regionId = seed.site?.regionId ?? DEFAULT_SITE.regionId;
  const has = (c: ScenarioComponent) => definition.components.includes(c);

  const swapEnabled = has("SWAP") && seed.chargingMode !== "charging";
  const mode: ChargingMode = seed.chargingMode ?? (swapEnabled ? (has("CHARGING") ? "hybrid" : "swap") : "charging");

  /* ── 站点 ── */
  const site: SiteInput = { ...DEFAULT_SITE, ...seed.site };
  if (!Number.isFinite(site.latitudeDeg) || site.latitudeDeg < -66 || site.latitudeDeg > 66) {
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "invalid_latitude",
      message: `纬度取值 ${site.latitudeDeg} 超出可计算范围，已按山西默认纬度 ${DEFAULT_SITE.latitudeDeg}° 处理。`,
      field: "site.latitudeDeg",
      suggestion: "请填写 -66 ~ 66 之间的纬度（北纬为正）。",
    });
    site.latitudeDeg = DEFAULT_SITE.latitudeDeg;
  }

  /* ── 车队 ── */
  const truck: TruckFleetInput = {
    ...DEFAULT_TRUCK,
    energyConsumptionKwhPerKm: bm("truck.energyConsumptionKwhPerKm", regionId, DEFAULT_TRUCK.energyConsumptionKwhPerKm),
    seasonalFactorPct: bm("truck.seasonalFactorPct", regionId, DEFAULT_TRUCK.seasonalFactorPct),
    routeFactorPct: bm("truck.routeFactorPct", regionId, DEFAULT_TRUCK.routeFactorPct),
    reserveFactorPct: bm("truck.reserveFactorPct", regionId, DEFAULT_TRUCK.reserveFactorPct),
    ...seed.truck,
    chargingStrategy: definition.managedCharging ? "managed" : (seed.truck?.chargingStrategy ?? "unmanaged"),
  };

  /* ── 充换电 ── */
  const charger: ChargerInput = {
    ...DEFAULT_CHARGER,
    simultaneousRatePct: bm("charging.simultaneousRatePct", regionId, DEFAULT_CHARGER.simultaneousRatePct),
    chargingEfficiencyPct: bm("charging.chargingEfficiencyPct", regionId, DEFAULT_CHARGER.chargingEfficiencyPct),
    ...seed.charger,
  };
  const swap: SwapInput = { ...DEFAULT_SWAP, enabled: swapEnabled, ...seed.swap };
  if (seed.swap?.enabled !== undefined) swap.enabled = swapEnabled; // 组件开关优先于零散覆盖
  const swapSharePct = mode === "swap" ? 100 : (seed.swapSharePct ?? (mode === "hybrid" ? 30 : 0));

  const charging: ChargingSolutionInput = { mode, charger, swap, swapSharePct };
  if (!has("CHARGING") && mode !== "swap") {
    diagnostics.push({
      kind: "SCENARIO_INPUT_MISSING",
      code: "charging_component_absent",
      message: "场景未包含充电能力，充电桩投资将不计入，仅按换电计算。",
      field: "definition.components",
    });
  }

  /* ── 光伏 ── */
  const pv: PvInput = {
    enabled: has("PV"),
    capacityKwp: 2000,
    tiltDeg: 30,
    azimuthDeg: 180,
    specificYieldKwhPerKwp: bm("pv.specificYieldKwhPerKwp", regionId, 1170),
    degradationPctPerYear: bm("pv.degradationPctPerYear", regionId, 0.55),
    ...seed.pv,
  };
  if (!has("PV")) {
    pv.enabled = false;
    if ((seed.pv?.capacityKwp ?? 0) > 0) {
      diagnostics.push({
        kind: "SCENARIO_INPUT_MISSING",
        code: "pv_capacity_ignored",
        message: "场景未包含光伏，已填写的光伏容量不参与本次计算。",
        field: "definition.components",
        impact: "本次结果不含光伏收益与投资，若要评估光伏请选择含光伏的场景。",
      });
    }
  }

  /* ── 储能 ── */
  const bessStrategy: BessStrategy = bessStrategyFor(has("PV"));
  const bess: BessInput = {
    enabled: has("BESS"),
    powerKw: 1000,
    energyKwh: 2000,
    roundTripEfficiencyPct: bm("bess.roundTripEfficiencyPct", regionId, 90),
    socMinPct: bm("bess.socMinPct", regionId, 10),
    socMaxPct: bm("bess.socMaxPct", regionId, 90),
    degradationPctPerYear: bm("bess.degradationPctPerYear", regionId, 2.5),
    strategy: bessStrategy,
    initialSocPct: 50,
    maxCyclesPerYear: 400,
    ...seed.bess,
  };
  if (!has("BESS")) {
    bess.enabled = false;
    if ((seed.bess?.energyKwh ?? 0) > 0) {
      diagnostics.push({
        kind: "SCENARIO_INPUT_MISSING",
        code: "bess_capacity_ignored",
        message: "场景未包含储能，已填写的储能容量不参与本次计算。",
        field: "definition.components",
        impact: "本次结果不含储能收益与投资，若要评估储能请选择含储能的场景。",
      });
    }
  }

  /* ── 电网 ── */
  const touEnabled = has("TOU");
  const grid: GridInput = {
    capacityKw: 2500,
    importLimitKw: 2500,
    exportAllowed: true,
    exportLimitKw: 2500,
    touEnabled,
    flatPriceYuanPerKwh: bm("grid.flatPriceYuanPerKwh", regionId, 0.55),
    peakMultiplier: bm("grid.tou.peakMultiplier", regionId, 1.6),
    valleyMultiplier: bm("grid.tou.valleyMultiplier", regionId, 0.45),
    touWindows: { ...DEFAULT_TOU_WINDOWS },
    demandChargePerKwMonth: has("DEMAND_CHARGE") ? bm("grid.demandChargePerKwMonth", regionId, 0) : 0,
    feedInTariffYuanPerKwh: bm("grid.feedInTariffYuanPerKwh", regionId, 0.35),
    ...seed.grid,
  };
  // 组件开关优先于零散覆盖
  grid.touEnabled = touEnabled;

  /* ── 经济 ── */
  const economics: EconomicsInput = {
    constructionYears: 1,
    projectLifeYears: 10,
    discountRatePct: bm("economics.discountRatePct", regionId, 6),
    inflationPct: bm("economics.inflationPct", regionId, 2),
    incomeTaxPct: bm("economics.incomeTaxPct", regionId, 25),
    residualValuePct: bm("economics.residualValuePct", regionId, 5),
    equityRatioPct: bm("economics.equityRatioPct", regionId, 30),
    loanInterestPct: bm("economics.loanInterestPct", regionId, 4.5),
    loanTermYears: 8,
    pvCapexYuanPerW: bm("economics.pvCapexYuanPerW", regionId, 3.2),
    bessCapexYuanPerWh: bm("economics.bessCapexYuanPerWh", regionId, 1.0),
    chargerCapexYuanPerKw: bm("economics.chargerCapexYuanPerKw", regionId, 700),
    swapStationCapexYuanPerStation: bm("economics.swapStationCapexYuanPerStation", regionId, 4_000_000),
    gridCapexYuanPerKw: bm("economics.gridCapexYuanPerKw", regionId, 600),
    civilCapexYuanPerChargerKw: bm("economics.civilCapexYuanPerChargerKw", regionId, 300),
    pvOpexYuanPerKwpYear: bm("economics.pvOpexYuanPerKwpYear", regionId, 60),
    bessOpexYuanPerKwhYear: bm("economics.bessOpexYuanPerKwhYear", regionId, 30),
    chargerOpexYuanPerKwYear: bm("economics.chargerOpexYuanPerKwYear", regionId, 40),
    siteFixedOpexYuanPerYear: bm("economics.siteFixedOpexYuanPerYear", regionId, 200_000),
    landRentYuanPerYear: bm("economics.landRentYuanPerYear", regionId, 300_000),
    insurancePctOfCapex: bm("economics.insurancePctOfCapex", regionId, 0.8),
    chargingServiceFeeYuanPerKwh: seed.chargingServiceFeeYuanPerKwh,
    swapServiceFeeYuanPerKwh: seed.swapServiceFeeYuanPerKwh ?? 0,
    // 0 = 平价转供（按运营方加权平均到户电价代收电费），未取得结算协议时的缺省口径
    electricityResalePriceYuanPerKwh: seed.electricityResalePriceYuanPerKwh ?? 0,
    otherRevenueYuanPerYear: 0,
    constructionSubsidyPct: 0,
    operationSubsidyYuanPerKwh: 0,
    ...seed.economics,
  };

  /* ── 显式未知项（如实登记，不偷填） ── */
  const unknowns: Record<string, string> = { ...seed.unknowns };
  if (!Number.isFinite(economics.chargingServiceFeeYuanPerKwh) || economics.chargingServiceFeeYuanPerKwh <= 0) {
    unknowns["economics.chargingServiceFeeYuanPerKwh"] =
      "充电服务费实行市场调节价，无官方水平值；本次未提供有效定价，服务收入按 0 计。";
  }
  const nominalDemand = getBenchmark("grid.demandChargeNominalYuanPerKwMonth", regionId);
  if (nominalDemand && nominalDemand.value === null && has("DEMAND_CHARGE")) {
    unknowns["grid.demandChargePerKwMonth"] =
      "需量电价名义水平无官方价表可核实（基准层标为 UNKNOWN），已按官方免征条款取 0。";
  }

  const input: ScenarioInput = {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name: seed.name,
    definition,
    site,
    truck,
    charging,
    pv,
    bess,
    grid,
    economics,
  };
  if (Object.keys(unknowns).length) input.unknowns = unknowns;
  if (seed.note) input.note = seed.note;

  return { input, diagnostics };
}

/**
 * 便捷入口：按模板 id 建情景。
 *
 * `name` 从 `ScenarioSeed` 中剔除后单独声明为可选——实现里本就是 `seed.name ?? tpl.label`，
 * 若沿用 `Omit<ScenarioSeed, "definition">`，交叉类型会把可选的 `name` 与必填的 `name`
 * 求交成**必填**，逼每个调用方多传一个它并不关心的展示名。
 */
export function buildScenarioFromTemplate(
  templateId: string,
  seed: Omit<ScenarioSeed, "definition" | "name"> & { name?: string },
): { input: ScenarioInput; diagnostics: Diagnostic[] } {
  const tpl = getScenarioTemplate(templateId);
  if (!tpl) {
    throw new Error(`未知场景模板：${templateId}`);
  }
  return buildScenarioInput({ ...seed, name: seed.name ?? tpl.label, definition: tpl });
}

/**
 * 本仓库的**默认对照情景**：山西重卡「光伏 + 储能 + 有序充电」。
 *
 * 之所以把服务费作为必填参数而不是默认值，见 `ScenarioSeed.chargingServiceFeeYuanPerKwh` 的说明。
 */
export function defaultScenarioInput(opts: {
  chargingServiceFeeYuanPerKwh: number;
  swapServiceFeeYuanPerKwh?: number;
  name?: string;
  templateId?: string;
}): { input: ScenarioInput; diagnostics: Diagnostic[] } {
  return buildScenarioFromTemplate(opts.templateId ?? "pv-bess-tou", {
    name: opts.name ?? "山西重卡能源项目（默认对照）",
    chargingServiceFeeYuanPerKwh: opts.chargingServiceFeeYuanPerKwh,
    ...(opts.swapServiceFeeYuanPerKwh !== undefined
      ? { swapServiceFeeYuanPerKwh: opts.swapServiceFeeYuanPerKwh }
      : {}),
  });
}
