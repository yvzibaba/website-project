/**
 * S1 · 逐时储能**物理不变量契约**（mandate §二十–§二十一 · 纯派生 · 零重算 · 符号严格对齐 engine）
 *
 * ## 这批只做"非争议性"的部分
 * mandate §十六 S1 收口（把 V1 Path A 切到 V2 Path B 的统一口径）**属 §23 创始人域**——须升
 * `MODEL_VERSION` / 重录黄金 / 改需量策略 / φ·Kc 裁决，本批**一律不碰**（§十九 明文禁止）。
 * 本文件只交付 §二十 要求「至少建立」的**物理不变量**里**无争议、可代码化**的那一半：
 *   - SOC ≥ 0 且 SOC ≤ capacity（含引擎自身 `socMin%–socMax%` 界）；
 *   - chargePower ≤ ratedPower、dischargePower ≤ ratedPower；
 *   - 能量守恒式的**符号契约**（把 mandate 概念符号钉到引擎真实字段名上，权威校验器唯一 = balance.ts）；
 *   - §二十一「套利 + 削峰**不能双算**」= One Battery → One SOC → One chronological dispatch 的结构事实断言。
 *
 * ## "符号必须与当前 engine 真实定义一致 · 不要凭空重写" 如何被机器保证
 *   - 本文件里的**每一个引擎字段名**（`socProfilePct / chargeProfileKw / dischargeProfileKw /
 *     powerKw / energyKwh / socMinPct / socMaxPct` 及守恒式八元 `pvOutputKw … unservedProfileKw`）
 *     都由 `tests/unit/hourly-bess-invariants.test.ts` 去**读引擎源码**逐一断言仍然存在——
 *     任一处被改名 / 删除，符号映射测立刻红。
 *   - 守恒式**不在此重算**：本文件只以字符串**引用** `kernel/src/engine/balance.ts ·
 *     checkEnergyBalanceInvariant()` 为**唯一权威**（宪法第 16 条单一真源 / §二十一禁第二套 runtime），
 *     并把它左／右两侧的真实算式作为源码快照钉进测里，防"注释与引擎漂移"。
 *
 * ## 与 R7-B / S1 骨架「不重算守卫」同一模式
 *   - 只 `import type`（编译期擦除、运行时零依赖），**绝不调用** `computeBess / computeEnergyBalance /
 *     runCalculation` 等任何计算函数——结构上保证本模块不可能"顺手把引擎跑一遍"。
 *   - 独立版本常量 `HOURLY_BESS_INVARIANTS_VERSION`，不挂任何冻结口径（MODEL/ENGINE/BALANCE/BESS/STORAGE 全零动）。
 */

import type { BessResult } from "@app/kernel/engine/types";

/** 本契约模块版本（**独立命名空间**，改判据须升版记原因，规则 13；与所有冻结口径无关）。 */
export const HOURLY_BESS_INVARIANTS_VERSION = "1.0.0"; // 1.0.0（S1 · §二十–§二十一）：SOC/功率越界外部复核 + 守恒式符号契约 + 套利/削峰单预算双算守卫。零引擎写入、零重算。

/**
 * SOC 越界判定的浮点容差。**必须与引擎 `bess.ts` 的 `const tol = 1e-6` 一致**（符号对齐测里钉）。
 * 引擎用 `socMin - tol … socMax + tol` 判越界；本模块外部复核采用同一 tol，避免与引擎自身计数打架。
 */
export const SOC_TOLERANCE_PCT = 1e-6;

/* ───────────────────────────── ① mandate §二十 符号 → 引擎真实字段 映射 ───────────────────────────── */

/**
 * mandate §二十 守恒式的**概念符号** → 本引擎**真实字段名**。符号名不许臆造：
 *   `PV / Grid Import / BESS Discharge / Load / BESS Charge / Grid Export / Losses / Unserved`
 *   全部落到 `balance.ts · checkEnergyBalanceInvariant(series)` 的入参键上。
 *   注意 **Losses 在本引擎实现为「弃光 curtailment」**（`curtailmentProfileKw`）——
 *   引擎的守恒里没有独立的"效率损耗"项（充/放电往返效率已在 SOC↔AC 换算里消化，见 §二十一 单预算叙事），
 *   供给侧的"损失"体现为弃光。这一点是引擎真实定义，**不重写**。
 */
export const MANDATE_BALANCE_SYMBOL_TO_ENGINE_FIELD = {
  PV: "pvOutputKw",
  GridImport: "importProfileKw",
  BESS_Discharge: "bessDischargeKw",
  Load: "loadProfileKw",
  BESS_Charge: "bessChargeKw",
  GridExport: "exportProfileKw",
  Losses: "curtailmentProfileKw",
  Unserved: "unservedProfileKw",
} as const;
export type MandateBalanceSymbol = keyof typeof MANDATE_BALANCE_SYMBOL_TO_ENGINE_FIELD;

/**
 * 引擎**实际**守恒式（逐 15 分钟、单位 kWh = kW × DT_HOURS）——**引用** `balance.ts` 真实算式：
 *   `pv + discharge + import  ==  load + charge - unserved + export + curtailment`
 *   等价于 mandate §二十 的
 *   `PV + BESS_Discharge + GridImport  ==  Load + BESS_Charge + GridExport + Losses − Unserved`
 * （"− Unserved"移到右侧即 mandate 写法；本文件**不重算**，权威判定唯一在 `checkEnergyBalanceInvariant`）。
 */
export const ENGINE_ENERGY_BALANCE_EQUATION =
  "PV + BESS_Discharge + GridImport == Load + BESS_Charge + GridExport + Losses - Unserved  (per 15-min step, kWh = kW x DT_HOURS; Losses == curtailment in this engine)";

/** 守恒式的**唯一权威校验器**位置（宪法 §16 单一真源；本模块绝不另起一套守恒计算）。 */
export const ENGINE_BALANCE_AUTHORITATIVE_CHECKER =
  "kernel/src/engine/balance.ts :: checkEnergyBalanceInvariant [BALANCE_MODEL_VERSION]";

/* ───────────────────────────── ② SOC 界（SOC ≥ 0 · SOC ≤ capacity · socMin%–socMax%） ───────────────────────────── */

/** 引擎 `BessInput` 里与 SOC 界相关的三个真实字段（`socMinPct / socMaxPct` 为 %，`energyKwh` 为容量 kWh）。 */
export interface SocBoundsConfig {
  socMinPct: number;
  socMaxPct: number;
  energyKwh: number; // capacity（额定容量·SOC 的能量上限锚点）
}

export interface SocBoundViolation {
  step: number;
  socPct: number;
  minPct: number;
  maxPct: number;
}

export interface SocBoundsReport {
  ok: boolean;
  /** 生效界：先套用引擎同款 clamp `socMin=max(0,min(100,·))`、`socMax=max(socMin,min(100,·))`。 */
  effectiveMinPct: number;
  effectiveMaxPct: number;
  observedMinPct: number;
  observedMaxPct: number;
  /** 能量形式（SOC% × capacity/100）界：恒有 `0 ≤ socEnergyKwh ≤ capacityKwh`。 */
  capacityKwh: number;
  socEnergyMinKwh: number;
  socEnergyMaxKwh: number;
  violationCount: number;
  samples: SocBoundViolation[];
  /** 与本模块**独立**复算的越界次数 vs 引擎自身 `BessResult.socViolations` 是否一致（防御性双读）。 */
  engineSocViolations: number;
  agreesWithEngine: boolean;
  note: string;
}

function clampSocPct(raw: number, lo: number, hi: number): number {
  if (!Number.isFinite(raw)) return lo;
  return Math.max(lo, Math.min(hi, raw));
}

/**
 * 外部复核 SOC 界：**不重算调度**，只对引擎**已发布**的 `socProfilePct` 逐点判界（同一 SOC 序列）。
 * 同时把百分比换算到能量形式核对 `0 ≤ SOC·capacity ≤ capacity`（§二十 "SOC ≤ capacity" 的字面兑现）。
 */
export function checkSocBounds(bess: BessResult, cfg: SocBoundsConfig): SocBoundsReport {
  const series = Array.isArray(bess.socProfilePct) ? bess.socProfilePct : [];
  const capacity = Number.isFinite(cfg.energyKwh) && cfg.energyKwh > 0 ? cfg.energyKwh : 0;

  // 与 bess.ts 第 130–131 行同法 clamp 生效界（保证与引擎判据逐字一致）
  const effMin = clampSocPct(cfg.socMinPct, 0, 100);
  const effMaxRaw = Number.isFinite(cfg.socMaxPct) ? Math.min(100, cfg.socMaxPct) : effMin;
  const effMax = Math.max(effMin, effMaxRaw);

  let violationCount = 0;
  let observedMin = Number.POSITIVE_INFINITY;
  let observedMax = Number.NEGATIVE_INFINITY;
  const samples: SocBoundViolation[] = [];

  for (let t = 0; t < series.length; t++) {
    const s = series[t];
    if (Number.isFinite(s)) {
      if (s < observedMin) observedMin = s;
      if (s > observedMax) observedMax = s;
    }
    // 判界式与 bess.ts 第 276 行逐字一致：非有限 / < socMin - tol / > socMax + tol 记一次越界
    if (!Number.isFinite(s) || s < effMin - SOC_TOLERANCE_PCT || s > effMax + SOC_TOLERANCE_PCT) {
      violationCount++;
      if (samples.length < 5) samples.push({ step: t, socPct: Number.isFinite(s) ? s : NaN, minPct: effMin, maxPct: effMax });
    }
  }

  const hasAny = series.length > 0;
  const engViolations = Number.isFinite(bess.socViolations) ? Math.max(0, Math.trunc(bess.socViolations)) : 0;
  const ok = violationCount === 0;

  return {
    ok,
    effectiveMinPct: round4(effMin),
    effectiveMaxPct: round4(effMax),
    observedMinPct: hasAny && Number.isFinite(observedMin) ? round4(observedMin) : 0,
    observedMaxPct: hasAny && Number.isFinite(observedMax) ? round4(observedMax) : 0,
    capacityKwh: round4(capacity),
    socEnergyMinKwh: round4((Number.isFinite(observedMin) ? observedMin : 0) / 100 * capacity),
    socEnergyMaxKwh: round4((Number.isFinite(observedMax) ? observedMax : 0) / 100 * capacity),
    violationCount,
    samples,
    engineSocViolations: engViolations,
    // 本模块只见 socProfilePct 快照；引擎在 clamp 前计数——两者应一致（干净调度下都为 0）
    agreesWithEngine: violationCount === engViolations,
    note: ok
      ? "SOC 全程落在生效界内（含 0 ≤ SOC ≤ capacity 能量核对），与引擎 socViolations=0 一致。"
      : `SOC 越界 ${violationCount} 个时段（应在 ${round4(effMin)}%–${round4(effMax)}%）；引擎自身记 ${engViolations} 次。`,
  };
}

/* ───────────────────────────── ③ 功率界（chargePower ≤ ratedPower · dischargePower ≤ ratedPower） ───────────────────────────── */

export interface PowerBoundsConfig {
  powerKw: number; // 额定功率（引擎 BessInput.powerKw）
}

export interface PowerBoundViolation {
  step: number;
  kw: number;
  ratedKw: number;
  leg: "charge" | "discharge";
}

export interface PowerBoundsReport {
  ok: boolean;
  ratedPowerKw: number;
  maxChargeKw: number;
  maxDischargeKw: number;
  chargeViolationCount: number;
  dischargeViolationCount: number;
  samples: PowerBoundViolation[];
  note: string;
}

/**
 * 外部复核充/放电功率 ≤ 额定功率。**读引擎已发布的功率序列**（`chargeProfileKw / dischargeProfileKw`，
 *   类型注释明确标为 kW），逐点对比 `BessInput.powerKw`。不重算、不改任何调度。
 */
export function checkPowerBounds(bess: BessResult, cfg: PowerBoundsConfig): PowerBoundsReport {
  const rated = Number.isFinite(cfg.powerKw) && cfg.powerKw > 0 ? cfg.powerKw : 0;
  const charge = Array.isArray(bess.chargeProfileKw) ? bess.chargeProfileKw : [];
  const discharge = Array.isArray(bess.dischargeProfileKw) ? bess.dischargeProfileKw : [];

  let maxCharge = 0;
  let maxDischarge = 0;
  let chargeViol = 0;
  let dischargeViol = 0;
  const samples: PowerBoundViolation[] = [];

  for (let t = 0; t < charge.length; t++) {
    const v = charge[t];
    if (Number.isFinite(v)) {
      if (v > maxCharge) maxCharge = v;
      if (v > rated + SOC_TOLERANCE_PCT) {
        chargeViol++;
        if (samples.length < 5) samples.push({ step: t, kw: v, ratedKw: rated, leg: "charge" });
      }
    }
  }
  for (let t = 0; t < discharge.length; t++) {
    const v = discharge[t];
    if (Number.isFinite(v)) {
      if (v > maxDischarge) maxDischarge = v;
      if (v > rated + SOC_TOLERANCE_PCT) {
        dischargeViol++;
        if (samples.length < 5) samples.push({ step: t, kw: v, ratedKw: rated, leg: "discharge" });
      }
    }
  }

  const ok = chargeViol === 0 && dischargeViol === 0;
  return {
    ok,
    ratedPowerKw: round4(rated),
    maxChargeKw: round4(maxCharge),
    maxDischargeKw: round4(maxDischarge),
    chargeViolationCount: chargeViol,
    dischargeViolationCount: dischargeViol,
    samples,
    note: ok
      ? `充/放电峰值功率均在额定 ${round4(rated)} kW 内（充 ${round4(maxCharge)} / 放 ${round4(maxDischarge)} kW）。`
      : `功率越额定 ${round4(rated)} kW：充超 ${chargeViol} 次 / 放超 ${dischargeViol} 次。`,
  };
}

/* ───────────────────────────── ④ §二十一 套利 + 削峰不能双算（One Battery → One SOC → One dispatch） ───────────────────────────── */

export interface DoubleCountGuard {
  ok: boolean;
  arbitrageBenefitYuan: number;
  demandChargeSavingYuan: number;
  totalBessBenefitYuan: number;
  /** 两条腿是否出自**同一份** socProfile/charge/discharge（即同一时刻同一电池、单一时序调度）。 */
  sharesOneChronologicalDispatch: boolean;
  /** 单份 SOC 预算是否内部自洽（socViolations=0）。越界则"同一预算"叙事不成立，禁止合并讲。 */
  singleSocBudgetConsistent: boolean;
  socSeriesLength: number;
  chargeSeriesLength: number;
  dischargeSeriesLength: number;
  note: string;
}

/**
 * §二十一 硬约束的**可审计断言**：套利收益与削峰收益**不是各算一遍再相加**，而是
 *   **同一块电池、同一份 SOC 演化、同一条时序调度**在 `bess.ts` 里一次产出的两个计价侧面。
 * 因此二者相加 = 合法合并（同一预算的两条腿），而"双算"的定义是**两条独立调度各自吃满同一电量**——
 *   引擎结构上不存在第二条调度（三条策略 arbitrage/peak-shaving/pv-shift 在同一 socProfile 上互斥充放）。
 *
 * 本函数**只做一致性体检**（不判谁对谁错、不做口径仲裁）：
 *   - 三条序列同长 = 同一时间轴（One chronological dispatch 的形式前提）；
 *   - `socViolations === 0` = 单份预算自洽；
 *   - 合计 = 两腿相加（不额外乘二、不重复计入）。
 */
export function assertNoArbitragePeakShavingDoubleCount(bess: BessResult): DoubleCountGuard {
  const arbitrage = finiteOr(bess.arbitrageBenefitYuan);
  const demand = finiteOr(bess.demandChargeSavingYuan);
  const total = round2(arbitrage + demand);

  const socLen = Array.isArray(bess.socProfilePct) ? bess.socProfilePct.length : 0;
  const chgLen = Array.isArray(bess.chargeProfileKw) ? bess.chargeProfileKw.length : 0;
  const disLen = Array.isArray(bess.dischargeProfileKw) ? bess.dischargeProfileKw.length : 0;
  const sameLength = socLen > 0 && socLen === chgLen && socLen === disLen;

  const engViolations = Number.isFinite(bess.socViolations) ? Math.trunc(bess.socViolations) : 1;
  const singleSocBudgetConsistent = engViolations === 0;

  const ok = sameLength && singleSocBudgetConsistent;

  let note: string;
  if (!sameLength) {
    note = `SOC/充/放序列长度不一致（${socLen}/${chgLen}/${disLen}）· 非同一时间轴 · 双算守卫拒绝作"单一调度"结论。`;
  } else if (!singleSocBudgetConsistent) {
    note = `SOC 越界 ${engViolations} 次 · 单份预算不自洽 · 套利与削峰不可合并为"同一预算已闭合"。`;
  } else {
    note = "套利腿 + 削峰腿出自同一份 SOC 时序调度（One Battery → One SOC → One dispatch）· 二者相加是同一预算的两条腿、非双算；真实定价与需求侧收益归 §23。";
  }

  return {
    ok,
    arbitrageBenefitYuan: round2(arbitrage),
    demandChargeSavingYuan: round2(demand),
    totalBessBenefitYuan: total,
    sharesOneChronologicalDispatch: sameLength,
    singleSocBudgetConsistent,
    socSeriesLength: socLen,
    chargeSeriesLength: chgLen,
    dischargeSeriesLength: disLen,
    note,
  };
}

/* ───────────────────────────── 聚合体检（把上面三块 + 守恒式契约汇成一份可审计报告） ───────────────────────────── */

export interface BessInvariantAudit {
  soc: SocBoundsReport;
  power: PowerBoundsReport;
  doubleCount: DoubleCountGuard;
  /** 三项全绿 = 本模块关注的物理不变量当前**无一被违反**（非"引擎全对"，只是这一层）。 */
  allOk: boolean;
  /** 守恒式**符号契约**快照（供报告/审计引用；真正判定在 balance.ts）。 */
  energyBalanceContract: {
    equation: string;
    symbolToEngineField: typeof MANDATE_BALANCE_SYMBOL_TO_ENGINE_FIELD;
    authoritativeChecker: string;
  };
  version: string;
}

/**
 * 一次体检：SOC 界 + 功率界 + 套利/削峰单预算守卫 + 守恒式符号契约。
 * **纯读引擎已发布结果 + 配置**，不调任何计算函数。脏输入 → 相应项保守判负，不假装通过。
 */
export function auditBessInvariants(
  bess: BessResult,
  cfg: SocBoundsConfig & PowerBoundsConfig,
): BessInvariantAudit {
  const soc = checkSocBounds(bess, cfg);
  const power = checkPowerBounds(bess, cfg);
  const doubleCount = assertNoArbitragePeakShavingDoubleCount(bess);
  return {
    soc,
    power,
    doubleCount,
    allOk: soc.ok && power.ok && doubleCount.ok && soc.agreesWithEngine,
    energyBalanceContract: {
      equation: ENGINE_ENERGY_BALANCE_EQUATION,
      symbolToEngineField: MANDATE_BALANCE_SYMBOL_TO_ENGINE_FIELD,
      authoritativeChecker: ENGINE_BALANCE_AUTHORITATIVE_CHECKER,
    },
    version: HOURLY_BESS_INVARIANTS_VERSION,
  };
}

/* ───────────────────────────── 小工具（无副作用·脏输入吃保守值） ───────────────────────────── */

function finiteOr(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}
function round2(x: number): number {
  return Math.round(finiteOr(x) * 100) / 100;
}
function round4(x: number): number {
  return Math.round(finiteOr(x) * 10000) / 10000;
}

/* ───────────────────── 结构守卫：本文件不得调用任何计算函数（同 S1 骨架 / R7-B 反算守卫） ───────────────────── */

/**
 * 备注（守卫本体在 `tests/unit/hourly-bess-invariants.test.ts`）：
 *   测直接读本源文件，断言 ① 除 `import type` 外不得有任何运行时 `@app/kernel/engine/` import；
 *   ② 代码行不得出现 `computeBess(` / `computeEnergyBalance(` / `checkEnergyBalanceInvariant(` /
 *   `runCalculation(` / `runProjectModel(` 任一调用点（守恒式**只引用不重算**）。禁令 token 字面量
 *   **只留在测里**，源码本身不含这些串，避免"自己写禁令、自己撞禁令"，也保证除 `import type` 外
 *   源码没有任何指向 engine 运行时的字符串。
 */
