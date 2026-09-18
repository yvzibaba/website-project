/**
 * 技术能耗模型（中途重构 R2.1）——《项目中途重构总控》命脉 §4「改参数→模型重算→技术结果变」里
 * 的**技术层**：把 R1.2 解析出的输入参数快照换算成**能量流**（光伏出力 / 充电负荷 / 自用与余电 /
 * 储能吞吐 / 能量平衡）。财务评价（钱）在 R2.2 `sandbox-finance.ts`；把两者串起来的编排在 R2.4。
 *
 * ⚠️ 诚实声明（宪法第 16/20 条；§7「程序算、LLM 只解释」）：
 *   本模块是**显式标注的"透明简化年度能量平衡法"**，不是逐时（8760h）生产模拟，也不是可研级潮流/容量校验。
 *   它给出量级正确、可复算、可追溯的一阶估算，用于跑通沙盘链路并让敏感性方向可信；
 *   每个结论都属高风险领域，输出统一带 `needsProfessionalReview=true` 与 `methodology` 说明，
 *   **不得当作并网/容量/收益的正式设计依据**（须专业人工与实测确认）。所有入参默认来自 R1.2 占位假设。
 *
 * 简化口径（务必与 `TRANSPARENT_SIMPLIFICATIONS` 常量一致，改公式即改此表并升版）：
 *   S1 年度能量平衡：以「年发电量 vs 年充电交流负荷」做年均值撮合来自用/余电/下网，忽略逐时曲线错配
 *      （真实自用的时间匹配损失更大，故此法会**高估**自用比例——已在 notes 里以保守方向提示）。
 *   S2 光伏首年=装机×等效小时×PR；第 n 年再乘 (1-衰减率)^(n-1)。等效小时即地区资源（R5 覆写）。
 *   S3 充电交流负荷=电池侧需电量÷充电效率（把桩损计入下网/光伏需量），不建模功率因数/谐波。
 *   S4 储能按"每天一次满充满放"的年度吞吐上界估算：受运行天数、且受循环/日历寿命折算的年最大循环数双重封顶；
 *      放电侧乘往返效率。峰谷套利的**钱**在财务/编排层结算，此处只算可移动的**能量**。
 *   S5 不含电池健康度(SOH)衰减、温度折减、限电弃光、充电需求增长曲线——V1 刻意留白，标记待补。
 */
import { round } from "@/server/sandbox-finance";

/** 技术模型版本（改公式/简化口径须升版并记原因，宪法第 13 条）。 */
export const TECH_VERSION = "1.0.0";

/** 溯源引用（供报告/审计标注这组能量数是哪个版本、按什么方法算的，第 7/16 条）。 */
export function techCalcRef(): string {
  return `tech@${TECH_VERSION}`;
}

/** 模型方法论声明（随结果透传，供报告与 UI 明示"这是简化估算不是可研"，第 16/20 条）。 */
export const TECH_METHODOLOGY =
  "透明简化的年度能量平衡法（非 8760h 逐时生产模拟、非可研级潮流/容量校验），量级估算，须经专业人工确认" as const;

/** 已采用的简化清单（与文件头 S1–S5 一一对应；结论透明度，第 20 条）。 */
export const TRANSPARENT_SIMPLIFICATIONS = [
  "S1 年度能量平衡撮合自用/余电/下网，忽略逐时曲线错配（会高估自用比例，方向保守起见已提示）",
  "S2 光伏首年=装机×等效小时×PR，逐年乘 (1-衰减率)^(年序-1)",
  "S3 充电交流负荷=电池侧电量÷充电效率，不建模功率因数/谐波",
  "S4 储能按每天一次满充满放的年度吞吐上界（受运行天数与寿命折算年最大循环双重封顶），放电侧计往返效率",
  "S5 不含 SOH 衰减/温度折减/弃光限电/充电需求增长，V1 刻意留白",
] as const;

/* ─────────────────────────── 入参键（与 R1.2 SANDBOX 键名为单一真源） ─────────────────────────── */

const K = {
  pvCapacity: "project.pvCapacity", // kWp
  eqHours: "region.pvEquivalentHours", // h
  pr: "tech.pvPerformanceRatio", // 0.82（小数，非百分）
  degradationPct: "tech.pvDegradation", // %/年
  dailyChargeEnergy: "derived.dailyChargeEnergy", // kWh/日（入电池侧）
  operatingDays: "project.operatingDays", // 天/年
  chargerEffPct: "tech.chargerEfficiency", // %
  storagePower: "project.storagePower", // kW
  storageEnergy: "project.storageEnergy", // kWh
  storageRtePct: "tech.storageRoundTripEff", // %
  storageCycleLife: "tech.storageCycleLife", // 次
  storageCalendarLife: "tech.storageCalendarLife", // 年
} as const;

/** 必备（缺任一即诚实判定"算不出"，不硬编能量流）。储能相关为可选。 */
const REQUIRED_KEYS: readonly string[] = [
  K.pvCapacity,
  K.eqHours,
  K.pr,
  K.degradationPct,
  K.dailyChargeEnergy,
  K.operatingDays,
  K.chargerEffPct,
];

/* ─────────────────────────── 原子纯函数（可独立测死） ─────────────────────────── */

/** S2 首年光伏年发电量 [kWh] = 装机 × 等效小时 × PR。非有限入参 → NaN（调用方负责有限性校验）。 */
export function pvAnnualEnergyYear1(args: {
  pvCapacityKwP: number;
  equivalentHours: number;
  performanceRatio: number;
}): number {
  const { pvCapacityKwP, equivalentHours, performanceRatio } = args;
  return pvCapacityKwP * equivalentHours * performanceRatio;
}

/** S2 第 yearIndex（1-based）年光伏量 = 首年 × (1-衰减率)^(yearIndex-1)。yearIndex<1 → NaN。 */
export function pvDegradedAnnualEnergy(
  year1Kwh: number,
  degradationPct: number,
  yearIndex: number,
): number {
  if (!Number.isFinite(year1Kwh) || !Number.isFinite(degradationPct) || yearIndex < 1) return NaN;
  const factor = 1 - degradationPct / 100;
  return year1Kwh * factor ** (yearIndex - 1);
}

/** S3 年充电电池侧需电量 [kWh] = 日充电量 × 年运营天数。 */
export function annualChargeEnergyDelivered(args: {
  dailyChargeEnergyKwh: number;
  operatingDays: number;
}): number {
  const { dailyChargeEnergyKwh, operatingDays } = args;
  return dailyChargeEnergyKwh * operatingDays;
}

/** S3 折算到交流侧（表后）的年负荷 [kWh] = 电池侧需电 ÷ (充电效率/100)。eff≤0 → NaN（无定义，诚实不诈算）。 */
export function acLoadFromDelivered(deliveredKwh: number, chargerEffPct: number): number {
  if (!Number.isFinite(deliveredKwh) || !Number.isFinite(chargerEffPct) || chargerEffPct <= 0)
    return NaN;
  return deliveredKwh / (chargerEffPct / 100);
}

/**
 * S1 年度能量平衡（自用/余电/下网）：给定年光伏量与年交流负荷，返回三者。
 * 任一非有限 → null。除零安全：pvEnergy≤0 时 selfConsumptionRate 记 0；load≤0 时 renewableFraction 记 0。
 */
export function annualEnergyBalance(args: {
  pvEnergyKwh: number;
  acLoadKwh: number;
}): {
  selfConsumedKwh: number;
  pvExportKwh: number;
  gridImportKwh: number;
  /** 光伏被就地消纳的比例 = self/pv（0–1）。 */
  pvSelfConsumptionRate: number;
  /** 负荷中由光伏覆盖的比例（可再生渗透率）= self/load（0–1）。 */
  renewableFraction: number;
} | null {
  const { pvEnergyKwh, acLoadKwh } = args;
  if (!Number.isFinite(pvEnergyKwh) || !Number.isFinite(acLoadKwh)) return null;
  const selfConsumedKwh = Math.min(pvEnergyKwh, acLoadKwh);
  const pvExportKwh = Math.max(0, pvEnergyKwh - acLoadKwh);
  const gridImportKwh = Math.max(0, acLoadKwh - pvEnergyKwh);
  const pvSelfConsumptionRate = pvEnergyKwh > 0 ? selfConsumedKwh / pvEnergyKwh : 0;
  const renewableFraction = acLoadKwh > 0 ? selfConsumedKwh / acLoadKwh : 0;
  return {
    selfConsumedKwh,
    pvExportKwh,
    gridImportKwh,
    pvSelfConsumptionRate,
    renewableFraction,
  };
}

/**
 * S4 储能年吞吐上界（能量口径）。以"每天一次满充满放"为基准，双重封顶：
 *   - 运行天数上限：一年最多循环 operatingDays 次；
 *   - 寿命折算上限：cycleLife ÷ min(日历寿命, 期望服务年限) 得保守年最大循环数（此处取日历寿命做分母）。
 * 每次可放电 = 额定容量 × (往返效率/100)。返回 { annualCycles, annualDischargeThroughputKwh }。
 * 非有限或 storageEnergy≤0 / 效率≤0 → null（未配储能或参数无意义）。
 */
export function storageAnnualThroughput(args: {
  storageEnergyKwh: number;
  chargerOrRtePct: number; // 此处传储能往返效率
  operatingDays: number;
  cycleLife: number;
  calendarLifeYears: number;
}): { annualCycles: number; annualDischargeThroughputKwh: number } | null {
  const { storageEnergyKwh, chargerOrRtePct: rtePct, operatingDays, cycleLife, calendarLifeYears } =
    args;
  if (
    !Number.isFinite(storageEnergyKwh) ||
    !Number.isFinite(rtePct) ||
    !Number.isFinite(operatingDays) ||
    storageEnergyKwh <= 0 ||
    rtePct <= 0
  ) {
    return null;
  }
  const lifeLimitedCyclesPerYear =
    Number.isFinite(cycleLife) && Number.isFinite(calendarLifeYears) && calendarLifeYears > 0
      ? cycleLife / calendarLifeYears
      : Infinity;
  const annualCycles = Math.min(operatingDays, lifeLimitedCyclesPerYear);
  const perCycleDischarge = storageEnergyKwh * (rtePct / 100);
  return {
    annualCycles: round(annualCycles, 0),
    annualDischargeThroughputKwh: round(perCycleDischarge * annualCycles, 0),
  };
}

/* ─────────────────────────── 聚合入口 ─────────────────────────── */

export interface TechFirstYearResult {
  pvEnergyY1Kwh: number;
  chargeEnergyDeliveredY1Kwh: number;
  acLoadY1Kwh: number;
  chargingLossY1Kwh: number;
  selfConsumedY1Kwh: number;
  pvExportY1Kwh: number;
  gridImportY1Kwh: number;
  pvSelfConsumptionRatePct: number;
  renewableFractionPct: number;
}

export interface TechResultOk {
  ok: true;
  calcRef: string;
  methodology: string;
  transparentSimplifications: readonly string[];
  needsProfessionalReview: true;
  /** 参与计算的关键输入回显（溯源，第 16 条）。 */
  inputsUsed: Record<string, number>;
  /** 缺失的可选储能键（true 表示按"未配储能"降级，非致命）。 */
  storageIncluded: boolean;
  firstYear: TechFirstYearResult;
  /** 若储能参与，其年吞吐上界；否则 null。 */
  storage: { annualCycles: number; annualDischargeThroughputKwh: number } | null;
  notes: string[];
}

export interface TechResultErr {
  ok: false;
  calcRef: string;
  reason: "missing_inputs" | "invalid_inputs";
  missingInputs: string[];
  invalidInputs: string[];
}

export type TechResult = TechResultOk | TechResultErr;

/**
 * 从解析后的数值快照计算沙盘**技术能量结果**（首年 + 储能吞吐）。这是 R2.4 编排消费的技术内核。
 * 诚实策略（第 20 条）：
 *   - 缺任一必备键 → ok:false `missing_inputs`（列出缺哪些，绝不猜默认能量）。
 *   - 必备键存在但含非有限值，或除零致关键量 NaN → ok:false `invalid_inputs`。
 *   - 储能键缺失/为 0 → 视为"未配储能"，降级但**不影响整体成功**（storageIncluded=false）。
 */
export function computeTechModel(numeric: Record<string, number | undefined>): TechResult {
  const missing = REQUIRED_KEYS.filter((k) => numeric[k] == null);
  // 记数值快照里可能因 boolean/派生缺失而 undefined：只把"必备键 undefined"算缺失。
  const invalid = REQUIRED_KEYS.filter(
    (k) => numeric[k] != null && !Number.isFinite(numeric[k] as number),
  );

  const baseErr = (reason: TechResultErr["reason"], bad: string[]): TechResultErr => ({
    ok: false,
    calcRef: techCalcRef(),
    reason,
    missingInputs: reason === "missing_inputs" ? bad : [],
    invalidInputs: reason === "invalid_inputs" ? bad : [],
  });

  if (missing.length > 0) return baseErr("missing_inputs", missing);
  if (invalid.length > 0) return baseErr("invalid_inputs", invalid);

  const pvCapacity = numeric[K.pvCapacity] as number;
  const eqHours = numeric[K.eqHours] as number;
  const pr = numeric[K.pr] as number;
  const degradationPct = numeric[K.degradationPct] as number;
  const dailyCharge = numeric[K.dailyChargeEnergy] as number;
  const operatingDays = numeric[K.operatingDays] as number;
  const chargerEffPct = numeric[K.chargerEffPct] as number;

  const notes: string[] = [];

  const pvEnergyY1Kwh = pvAnnualEnergyYear1({
    pvCapacityKwP: pvCapacity,
    equivalentHours: eqHours,
    performanceRatio: pr,
  });
  const chargeEnergyDeliveredY1Kwh = annualChargeEnergyDelivered({
    dailyChargeEnergyKwh: dailyCharge,
    operatingDays,
  });
  const acLoadY1Kwh = acLoadFromDelivered(chargeEnergyDeliveredY1Kwh, chargerEffPct);
  const chargingLossY1Kwh = acLoadY1Kwh - chargeEnergyDeliveredY1Kwh;

  if (!Number.isFinite(pvEnergyY1Kwh) || !Number.isFinite(acLoadY1Kwh)) {
    return baseErr("invalid_inputs", [K.pvCapacity, K.chargerEffPct]);
  }

  const bal = annualEnergyBalance({ pvEnergyKwh: pvEnergyY1Kwh, acLoadKwh: acLoadY1Kwh });
  if (!bal) {
    return baseErr("invalid_inputs", [K.pvCapacity, K.chargerEffPct]);
  }

  // 储能（可选）：仅当 storagePower>0 且 storageEnergy>0 时参与。
  const storageEnergy = numeric[K.storageEnergy];
  const storagePower = numeric[K.storagePower];
  const storageIncluded =
    typeof storageEnergy === "number" &&
    typeof storagePower === "number" &&
    Number.isFinite(storageEnergy) &&
    Number.isFinite(storagePower) &&
    storageEnergy > 0 &&
    storagePower > 0;

  let storage: TechResultOk["storage"] = null;
  if (storageIncluded) {
    const rte = numeric[K.storageRtePct];
    const cycleLife = numeric[K.storageCycleLife];
    const calLife = numeric[K.storageCalendarLife];
    if (rte == null || !Number.isFinite(rte) || rte <= 0) {
      notes.push(`储能往返效率缺失/非法（键 ${K.storageRtePct}），储能吞吐按不可用降级`);
    } else {
      storage = storageAnnualThroughput({
        storageEnergyKwh: storageEnergy as number,
        chargerOrRtePct: rte,
        operatingDays,
        cycleLife: cycleLife ?? Infinity,
        calendarLifeYears: calLife ?? Infinity,
      });
      if (storage == null) notes.push("储能参数导致吞吐无定义，已按 0 处理");
    }
  } else {
    notes.push("未检测到有效储能配置（storagePower/storageEnergy≤0），按「无储能」场景计算");
  }

  if (pvCapacity === 0) notes.push("光伏装机为 0：本沙盘仅计算充电负荷与下网，无光伏出力");
  if (bal.pvExportKwh > 0)
    notes.push("存在余电上网（S1 年度平衡会高估自用，逐时模型下自用可能更低、上网更多）");

  return {
    ok: true,
    calcRef: techCalcRef(),
    methodology: TECH_METHODOLOGY,
    transparentSimplifications: TRANSPARENT_SIMPLIFICATIONS,
    needsProfessionalReview: true,
    inputsUsed: {
      "project.pvCapacity": pvCapacity,
      "region.pvEquivalentHours": eqHours,
      "tech.pvPerformanceRatio": pr,
      "tech.pvDegradation": degradationPct,
      "derived.dailyChargeEnergy": dailyCharge,
      "project.operatingDays": operatingDays,
      "tech.chargerEfficiency": chargerEffPct,
      ...(storageEnergy != null ? { "project.storageEnergy": storageEnergy } : {}),
      ...(storagePower != null ? { "project.storagePower": storagePower } : {}),
    },
    storageIncluded,
    firstYear: {
      pvEnergyY1Kwh: round(pvEnergyY1Kwh, 0),
      chargeEnergyDeliveredY1Kwh: round(chargeEnergyDeliveredY1Kwh, 0),
      acLoadY1Kwh: round(acLoadY1Kwh, 0),
      chargingLossY1Kwh: round(chargingLossY1Kwh, 0),
      selfConsumedY1Kwh: round(bal.selfConsumedKwh, 0),
      pvExportY1Kwh: round(bal.pvExportKwh, 0),
      gridImportY1Kwh: round(bal.gridImportKwh, 0),
      pvSelfConsumptionRatePct: round(bal.pvSelfConsumptionRate * 100, 1),
      renewableFractionPct: round(bal.renewableFraction * 100, 1),
    },
    storage,
    notes,
  };
}
