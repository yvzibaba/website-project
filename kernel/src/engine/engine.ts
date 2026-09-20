/**
 * 生产计算引擎的**唯一入口**（Single Production Entry）。
 *
 * ```
 *   UI  ─┐
 *   API ─┼─→  runCalculation(ScenarioInput) ─→ CalculationOutcome ─→ 报告 / 持久化
 *   测试 ─┘
 * ```
 *
 * ## 为什么"只有一个入口"值得单独写成一段
 *
 * 一个项目里出现两条计算路径，通常不是因为有人故意，而是因为：
 * 界面上为了"实时预览"先算了一遍、后端为了"存库"又算了一遍，两遍慢慢就不一样了。
 * 到那时，用户看到的数和落库的数不一致，而两边都有测试：谁也说不清哪个是对的。
 *
 * 本文件把这条路径收成一个纯函数：
 *   - **输入**：`ScenarioInput`（唯一权威输入形状，见 `types.ts`）；
 *   - **输出**：`CalculationOutcome`（成功 = 完整结果；失败 = 显式失败 + 诊断）。
 *
 * 除此之外没有第二条路：前端不再"顺手算一下"，后端不再"补一个公式"，
 * 报告只读结果、不重算。所有的一致性、可复算、回归测试都建立在这一条路径之上。
 *
 * ## 纯度约束（对应"生产计算核心不得依赖 …"）
 *
 * 本模块及其依赖的全部子模块：**不读时钟、不读随机、不读环境变量、不访问网络、不碰数据库、
 * 不 import React/Next/Prisma**。因此同一份输入在任何机器、任何时候都得到逐字节相同的输出——
 * 这不是"好习惯"，而是"结论可被复核"的前提。时间戳由调用方在报告层补。
 *
 * ## 失败也要有形状
 *
 * 报错分两类，且**都不许静默**：
 *   - `invalid_input`：输入在物理/逻辑上不成立（负车队、倒挂的充电窗口、负年限）。
 *   - `invariant_violation`：输入没问题，但计算出的能量不守恒 → **这是引擎缺陷**，
 *     必须修代码，绝不能把结果发给用户。
 */

import { BALANCE_MODEL_VERSION, computeEnergyBalance } from "@app/kernel/engine/balance";
import { BENCHMARK_VERSION, benchmarkSnapshot } from "@app/kernel/engine/benchmark";
import { BESS_MODEL_VERSION, computeBess } from "@app/kernel/engine/bess";
import { CHARGING_MODEL_VERSION, computeCharging } from "@app/kernel/engine/charging";
import { DECISION_MODEL_VERSION, computeDecision } from "@app/kernel/engine/decision";
import { ECONOMICS_MODEL_VERSION, computeEconomics, sensitivityBars } from "@app/kernel/engine/economics";
import type { EconomicsComputationInput } from "@app/kernel/engine/economics";
import { GRID_MODEL_VERSION, buildPriceProfile, computeGridCosts } from "@app/kernel/engine/grid";
import { PV_MODEL_VERSION, computePv } from "@app/kernel/engine/pv";
import { SCENARIO_BENCHMARK_KEYS } from "@app/kernel/engine/scenario";
import { TIME_AXIS_VERSION, STEPS_PER_YEAR, TIME_STEP_MINUTES, sumAll } from "@app/kernel/engine/time";
import { TRUCK_MODEL_VERSION, computeTruckDemand } from "@app/kernel/engine/truck-demand";
import type {
  CalculationOutcome,
  CalculationResult,
  ChargingResult,
  Diagnostic,
  PvResult,
  ScenarioInput,
  TruckDemandResult,
} from "@app/kernel/engine/types";
import { round } from "@app/kernel/server/finance";

/** 引擎版本（改编排顺序/口径/不变量判定 = 必须升版）。 */
export const ENGINE_VERSION = "2.0.0";
/** 模型语义版本（子模型有实质性改动时升版，构成明细见 `MODEL_COMPOSITION`）。 */
export const MODEL_VERSION = "1.0.0";

/** 各子模型版本清单——"这一版结果由哪些模型算出来"的可审阅答案。 */
export const MODEL_COMPOSITION: string = [
  `time@${TIME_AXIS_VERSION}`,
  `truck@${TRUCK_MODEL_VERSION}`,
  `charging@${CHARGING_MODEL_VERSION}`,
  `pv@${PV_MODEL_VERSION}`,
  `bess@${BESS_MODEL_VERSION}`,
  `balance@${BALANCE_MODEL_VERSION}`,
  `grid@${GRID_MODEL_VERSION}`,
  `economics@${ECONOMICS_MODEL_VERSION}`,
  `decision@${DECISION_MODEL_VERSION}`,
].join("+");

export function engineCalcRef(): string {
  return `calc@${ENGINE_VERSION}`;
}

/* ═══════════════════════════ 输入校验 ═══════════════════════════ */

interface ValidationOutcome {
  fatal: Diagnostic[];
  warnings: Diagnostic[];
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 结构性校验：只拦"算不了"的输入，不拦截"算得出来但不好看"的输入
 * （后者交给诊断与决策层，让用户看到"为什么不好"，而不是被一句报错挡住）。
 */
export function validateScenarioInput(input: ScenarioInput): ValidationOutcome {
  const fatal: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const f = (code: string, message: string, field?: string, suggestion?: string) =>
    fatal.push({ kind: "SCENARIO_INPUT_MISSING", code, message, ...(field ? { field } : {}), ...(suggestion ? { suggestion } : {}) });
  const w = (code: string, message: string, field?: string, suggestion?: string) =>
    warnings.push({ kind: "SCENARIO_INPUT_MISSING", code, message, ...(field ? { field } : {}), ...(suggestion ? { suggestion } : {}) });

  if (!isFiniteNum(input.site.latitudeDeg)) f("invalid_latitude", "站点纬度缺失或不是有效数字，光伏几何计算无法进行。", "site.latitudeDeg");
  if (!isFiniteNum(input.truck.truckCount) || input.truck.truckCount < 0) f("invalid_truck_count", "车队规模为负或非数字。", "truck.truckCount");
  if (!isFiniteNum(input.truck.dailyMileageKm) || input.truck.dailyMileageKm < 0) f("invalid_daily_mileage", "单车日均里程为负或非数字。", "truck.dailyMileageKm");
  if (!isFiniteNum(input.truck.operatingDaysPerYear) || input.truck.operatingDaysPerYear < 0 || input.truck.operatingDaysPerYear > 365) {
    f("invalid_operating_days", "年运营天数必须在 0 ~ 365 之间。", "truck.operatingDaysPerYear");
  }
  const windowHours = input.truck.chargingWindowEndHour - input.truck.chargingWindowStartHour;
  if (!isFiniteNum(windowHours) || windowHours <= 0) {
    f(
      "charging_window_invalid",
      `充电窗口无效：起点 ${input.truck.chargingWindowStartHour}、终点 ${input.truck.chargingWindowEndHour}，终点必须大于起点（跨零点请填 30 表示次日 06:00）。`,
      "truck.chargingWindowEndHour",
      "例如 21 → 30 表示 21:00 至次日 06:00。",
    );
  }
  if (!isFiniteNum(input.economics.projectLifeYears) || input.economics.projectLifeYears < 1) {
    f("invalid_project_life", "运营期必须至少 1 年。", "economics.projectLifeYears");
  }
  if (!isFiniteNum(input.grid.capacityKw) || input.grid.capacityKw <= 0) {
    f("invalid_grid_capacity", "并网容量必须大于 0。", "grid.capacityKw");
  }
  if (!isFiniteNum(input.truck.energyConsumptionKwhPerKm) || input.truck.energyConsumptionKwhPerKm <= 0) {
    w(
      "zero_energy_consumption",
      "单位能耗为 0 或缺失，用能需求会被算成 0，全部经济结论都失去意义。",
      "truck.energyConsumptionKwhPerKm",
      "请按目标车型的实际能耗填写（标准工况参考 1.2 ~ 1.6 kWh/km）。",
    );
  }
  if (input.charging.mode !== "swap" && input.charging.charger.chargerCount <= 0 && input.charging.swap.enabled !== true) {
    w("no_charging_asset", "未配置任何充电桩，且未启用换电，将无法交付用能需求。", "charging.charger.chargerCount");
  }
  if (input.bess.enabled && (input.bess.energyKwh <= 0 || input.bess.powerKw <= 0)) {
    w("bess_size_zero", "储能已启用但功率或容量为 0，本次不会产生储能收益。", "bess.energyKwh");
  }
  if (input.pv.enabled && input.pv.capacityKwp <= 0) {
    w("pv_size_zero", "光伏已启用但装机容量为 0，本次不会产生发电量。", "pv.capacityKwp");
  }
  if (!isFiniteNum(input.economics.chargingServiceFeeYuanPerKwh)) {
    f("invalid_service_fee", "充电服务费单价缺失或非数字。", "economics.chargingServiceFeeYuanPerKwh");
  }
  return { fatal, warnings };
}

/* ═══════════════════════════ 输入哈希 ═══════════════════════════ */

/** 递归排序键的稳定序列化（对象键顺序不影响哈希）。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * 输入内容哈希（FNV-1a 双通道 64 位）。
 *
 * 诚实说明：这是**非密码学**哈希，用途是"两次计算是不是同一份输入"的一致性校验，
 * 不是防篡改签名。之所以不引入 `node:crypto`，是为了让引擎保持"零运行时依赖"，
 * 从而可以被内联进任何环境（浏览器、边缘函数、测试）。
 */
export function hashScenarioInput(input: ScenarioInput): string {
  // 只对**参与计算**的字段做哈希：name / note 是展示文本，改名字不该让复算校验失败。
  const payload = {
    schemaVersion: input.schemaVersion,
    definition: input.definition,
    site: input.site,
    truck: input.truck,
    charging: input.charging,
    pv: input.pv,
    bess: input.bess,
    grid: input.grid,
    economics: input.economics,
    unknowns: input.unknowns ?? null,
  };
  const s = stableStringify(payload);
  let h1 = 0x811c9dc5;
  let h2 = 0xc9dc5118;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}`;
}

/* ═══════════════════════════ 主入口 ═══════════════════════════ */

/**
 * **唯一的生产计算路径**。
 *
 * 编排顺序（有依赖关系，不可随意调换）：
 * ```
 *   电价曲线 ─┐
 *   光伏出力 ─┼→ 车队需求 → 充换电负荷 → 储能调度 → 能量平衡 → 电网成本
 *            ┘                                                    │
 *                        经济性 ←────────────────────────────────┘
 *                          │
 *                        决策（含敏感性）
 * ```
 * 为什么光伏要排在充换电之前：有序充电需要"哪些时段光伏多"这个信息。
 * 为什么储能排在充换电之后：它要看到完整的站点负荷曲线才能决定充放。
 */
export function runCalculation(input: ScenarioInput): CalculationOutcome {
  const calcRef = engineCalcRef();
  const diagnostics: Diagnostic[] = [];

  /* ── 0. 结构校验 ── */
  const validation = validateScenarioInput(input);
  diagnostics.push(...validation.warnings);
  if (validation.fatal.length) {
    return {
      ok: false,
      calcRef,
      reason: "invalid_input",
      detail: validation.fatal.map((d) => d.message).join(" "),
      diagnostics: [...validation.fatal, ...validation.warnings],
    };
  }

  try {
    const { site, truck: fleet, charging: solution, pv: pvInput, bess: bessInput, grid: gridInput, economics } = input;

    /* ── 1. 电价曲线（分时） ── */
    const priceProfile = buildPriceProfile(gridInput);
    diagnostics.push(...priceProfile.diagnostics);

    /* ── 2. 光伏出力（有序充电需要它，故先算） ── */
    const pvComputation = computePv(pvInput, site);
    diagnostics.push(...pvComputation.diagnostics);

    /* ── 3. 车队用能需求 ── */
    const truckComputation = computeTruckDemand(fleet, {
      mode: solution.mode,
      swap: solution.swap,
      swapSharePct: solution.swapSharePct,
      charger: solution.charger,
    });
    diagnostics.push(...truckComputation.diagnostics);

    /* ── 4. 充换电负荷 ── */
    const chargingComputation = computeCharging({
      fleet,
      charger: solution.charger,
      swap: solution.swap,
      mode: solution.mode,
      swapSharePct: solution.swapSharePct,
      managedCharging: input.definition.managedCharging,
      pvOutputKw: pvComputation.outputProfileKw,
      priceProfileYuanPerKwh: priceProfile.priceProfileYuanPerKwh,
      touEnabled: gridInput.touEnabled,
      touValleyHours: priceProfile.valleyWindows,
    });
    diagnostics.push(...chargingComputation.diagnostics);
    const charging = chargingComputation.result;
    // 同一年末切边现象在需求层与充电层各算一次（两层口径同为电网侧等价量，
    // 需求层 >= 交付层）。只发**一条**诊断，取两者较大者作为保守口径，
    // 并在正文里同时列出两个数，避免报告出现三条同义告警。
    const spillDemandKwh = truckComputation.result.yearBoundarySpillKwh;
    const spillDeliveredKwh = charging.yearBoundarySpillKwh;
    if (spillDemandKwh > 1 || spillDeliveredKwh > 1) {
      const spillKwh = Math.max(spillDemandKwh, spillDeliveredKwh);
      diagnostics.push({
        kind: "SCENARIO_INPUT_MISSING",
        code: "year_boundary_spill",
        message: `年末最后一个运营日的部分充电时段越过 12 月 31 日 24:00，约 ${Math.round(spillDemandKwh).toLocaleString("zh-CN")} kWh 需求（对应交付侧约 ${Math.round(spillDeliveredKwh).toLocaleString("zh-CN")} kWh）按规则计入次年，未纳入本年曲线与交付量。`,
        impact:
          "这不是补能能力不足，而是自然年切边：同一笔需求会在次年交付。本期年电量与年需求因此存在约万分之几的口径差（已在结果字段中单列）。",
        suggestion: "如需逐日严格闭合，可把充电窗口整体前移 6 小时以上，使窗口不再跨年。",
        value: round(spillKwh),
        unit: "kWh",
      });
    }

    /* ── 5. 储能调度 ── */
    const bessComputation = computeBess({
      bess: bessInput,
      loadProfileKw: charging.loadProfileKw,
      pvOutputKw: pvComputation.outputProfileKw,
      priceProfileYuanPerKwh: priceProfile.priceProfileYuanPerKwh,
      peakPriceThreshold: priceProfile.peakThreshold,
      valleyPriceThreshold: priceProfile.valleyThreshold,
      demandChargePerKwMonth: gridInput.demandChargePerKwMonth,
      feedInTariffYuanPerKwh: gridInput.feedInTariffYuanPerKwh,
    });
    diagnostics.push(...bessComputation.diagnostics);
    const bess = bessComputation.result;

    /* ── 6. 能量平衡（含不变量校验） ── */
    const importLimitKw = Math.max(0, Math.min(gridInput.importLimitKw, gridInput.capacityKw));
    const balance = computeEnergyBalance({
      loadProfileKw: charging.loadProfileKw,
      bessChargeKw: bess.chargeProfileKw,
      bessDischargeKw: bess.dischargeProfileKw,
      pvOutputKw: pvComputation.outputProfileKw,
      importLimitKw,
      exportAllowed: gridInput.exportAllowed,
      exportLimitKw: Math.min(gridInput.exportLimitKw, gridInput.capacityKw),
    });
    diagnostics.push(...balance.diagnostics);

    if (!balance.invariant.ok) {
      // 不变量失败 = 引擎缺陷。此时把结果发出去比报错危险得多：数字看起来完全正常。
      return {
        ok: false,
        calcRef,
        reason: "invariant_violation",
        detail:
          `能量平衡不守恒：${balance.invariant.violationCount} 个时段出现能量凭空产生或消失` +
          `（最大偏差 ${balance.invariant.maxAbsDeviationKwh.toExponential(3)} kWh）。这是计算引擎缺陷，结果不可用。`,
        diagnostics: [...diagnostics, ...balance.diagnostics],
      };
    }

    /* ── 7. 电网成本 ── */
    const gridComputation = computeGridCosts({
      importProfileKw: balance.importProfileKw,
      exportProfileKw: balance.exportProfileKw,
      curtailmentProfileKw: balance.curtailmentProfileKw,
      unservedProfileKw: balance.unservedProfileKw,
      priceProfileYuanPerKwh: priceProfile.priceProfileYuanPerKwh,
      feedInTariffYuanPerKwh: gridInput.feedInTariffYuanPerKwh,
      demandChargePerKwMonth: gridInput.demandChargePerKwMonth,
      monthlyPeakImportKw: balance.monthlyPeakImportKw,
      capacityConstrained: balance.capacityConstrained,
      gridCapacityKw: gridInput.capacityKw,
    });
    diagnostics.push(...gridComputation.diagnostics);
    const grid = gridComputation.result;

    /* ── 8. 组装光伏结果（自用/上网/弃光只有平衡层知道，故在此合并） ── */
    const pvResult: PvResult = {
      outputProfileKw: pvComputation.outputProfileKw,
      annualGenerationKwh: pvComputation.annualGenerationKwh,
      monthlyGenerationKwh: pvComputation.monthlyGenerationKwh,
      selfConsumedKwh: balance.selfConsumedPvKwh,
      exportedKwh: grid.annualExportKwh,
      curtailedKwh: round(sumAll(balance.curtailmentProfileKw) * (TIME_STEP_MINUTES / 60)),
      selfConsumptionPct:
        pvComputation.annualGenerationKwh > 0
          ? round((balance.selfConsumedPvKwh / pvComputation.annualGenerationKwh) * 100)
          : 0,
      chargingCoveragePct:
        charging.annualGridSideKwh > 0 ? round((balance.selfConsumedPvKwh / charging.annualGridSideKwh) * 100) : 0,
    };

    /* ── 9. 经济性 ── */
    const benchmark = benchmarkSnapshot(SCENARIO_BENCHMARK_KEYS, site.regionId);
    const contingencyPct = benchmark["economics.contingencyPct"]?.value ?? 0;

    const economicsInput: EconomicsComputationInput = {
      economics,
      pvCapacityKwp: pvInput.enabled ? pvInput.capacityKwp : 0,
      bessPowerKw: bessInput.enabled ? bessInput.powerKw : 0,
      bessEnergyKwh: bessInput.enabled ? bessInput.energyKwh : 0,
      chargerInstalledKw: charging.installedPowerKw,
      swapStationCount: solution.swap.enabled ? solution.swap.stationCount : 0,
      gridCapacityKw: gridInput.capacityKw,
      annualChargingDeliveredKwh: charging.annualChargingDeliveredKwh,
      annualSwapDeliveredKwh: charging.annualSwapDeliveredKwh,
      annualLoadKwh: charging.annualGridSideKwh,
      annualNetImportKwh: grid.annualImportKwh,
      annualPvGenerationKwh: pvResult.annualGenerationKwh,
      annualPvSelfConsumedKwh: pvResult.selfConsumedKwh,
      annualEnergyCostYuan: gridComputation.breakdown.energyCostYuan,
      annualDemandChargeYuan: gridComputation.breakdown.demandChargeYuan,
      annualExportRevenueYuan: gridComputation.breakdown.exportRevenueYuan,
      gridFlatPriceYuanPerKwh: gridInput.flatPriceYuanPerKwh,
      weightedAveragePriceYuanPerKwh: grid.weightedAveragePriceYuanPerKwh,
      annualBessArbitrageBenefitYuan: bess.arbitrageBenefitYuan + bess.demandChargeSavingYuan,
      pvDegradationPctPerYear: pvInput.degradationPctPerYear,
      bessDegradationPctPerYear: bessInput.degradationPctPerYear,
      contingencyPct,
      pvEnabled: pvInput.enabled,
      bessEnabled: bessInput.enabled,
      swapEnabled: solution.swap.enabled,
    };

    const economicsComputation = computeEconomics(economicsInput);
    diagnostics.push(...economicsComputation.diagnostics);
    const economicsResult = economicsComputation.result;

    /* ── 10. 决策（含敏感性；敏感性只扰动经济层，口径已在 economics.ts 声明） ── */
    const sensitivity = sensitivityBars(economicsInput);
    const decision = computeDecision({
      definition: input.definition,
      economicsInput,
      economicsResult,
      sensitivity,
      invariant: balance.invariant,
      truckDemand: truckComputation.result,
      charging,
      pv: pvResult,
      bess,
      grid,
      pvCapacityKwp: pvInput.enabled ? pvInput.capacityKwp : 0,
      pvSpecificYieldKwhPerKwp: pvInput.specificYieldKwhPerKwp,
      feedInTariffYuanPerKwh: gridInput.feedInTariffYuanPerKwh,
      benchmarkSnapshot: benchmark,
      diagnostics,
      unknowns: input.unknowns ?? {},
      engineVersion: ENGINE_VERSION,
      modelVersion: MODEL_VERSION,
      benchmarkVersion: BENCHMARK_VERSION,
    });

    const result: CalculationResult = {
      ok: true,
      calcRef,
      engineVersion: ENGINE_VERSION,
      modelVersion: MODEL_VERSION,
      modelComposition: MODEL_COMPOSITION,
      scenarioId: input.definition.id,
      scenarioLabel: input.definition.label,
      inputHash: hashScenarioInput(input),
      timeStepMinutes: TIME_STEP_MINUTES,
      stepsPerYear: STEPS_PER_YEAR,
      benchmarkVersion: BENCHMARK_VERSION,
      benchmarkSnapshot: benchmark,
      inputSnapshot: input,
      truckDemand: truckComputation.result as TruckDemandResult,
      charging: charging as ChargingResult,
      pv: pvResult,
      bess,
      grid,
      invariant: balance.invariant,
      economics: economicsResult,
      decision,
      diagnostics,
      needsProfessionalReview: true,
    };
    return result;
  } catch (err) {
    // 任何未预期异常都必须变成"显式失败"，绝不半路返回一个字段缺失的结果
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      calcRef,
      reason: "calculation_error",
      detail: `计算过程中出现未预期错误：${message}`,
      diagnostics: [
        ...diagnostics,
        {
          kind: "CALCULATION_ERROR",
          code: "unexpected_exception",
          message: `计算中断：${message}`,
          impact: "本次结果不可用。",
          suggestion: "这是引擎缺陷，请连同输入快照一起反馈，不要据此做任何判断。",
        },
      ],
    };
  }
}
