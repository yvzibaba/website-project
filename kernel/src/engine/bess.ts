/**
 * 储能模型（BESS）—— 逐 15 分钟充放电调度 + SOC 演化 + 经济价值。
 *
 * ## 这一层要回答的唯一问题
 *
 * **储能在本项目里值不值它的钱？** 不是"电池电化学特性如何"，而是"它每天能省下多少电费、
 * 削掉多少需量、多消纳多少光伏"。因此本模块是一个**规则型逐日调度器**，不是电化学模型：
 *   - 全局最优（线性规划）在决策阶段没必要，且不可解释；
 *   - 规则型调度的每一步都可以被人读代码核对，这是"可审计"的前提。
 *
 * ## 三种策略（都在**同一天内**做计划，SOC 跨日连续）
 *
 * | 策略 | 充电时段 | 放电时段 | 它解决什么问题 |
 * |---|---|---|---|
 * | `arbitrage`   | 谷段 | 峰段 | 赚峰谷价差 |
 * | `peak-shaving`| 非高峰负荷时段 | 负荷超过阈值时 | 降需量电费 / 降低受电容量 |
 * | `pv-shift`    | 光伏富余时段 | 峰段 | 把白天的电挪到晚上用 |
 *
 * ## 三条不可违反的约束（由不变量层再校一次）
 *
 * 1. 充放电功率 ≤ 额定功率；
 * 2. `socMin ≤ SOC ≤ socMax`，且每一个 15 分钟都不越界；
 * 3. **不做亏本循环**：放电计划不会超过当日峰段实际用电需求，因此不会为了"多循环"而
 *    先充后放同一时段（那只会白烧效率）。
 *
 * ## 效率口径（重要，避免与光伏/充电层的效率重复计算）
 *
 * 往返效率按 `η_each = √η_rt` 分摊到充、放两侧；**效率只在本层作用一次**。
 * 充电链路效率归 `charging.ts`，光伏的直交流损耗已折进"年等效利用小时"，三者不重叠。
 */

import {
  STEPS_PER_YEAR,
  STEPS_PER_DAY,
  STEPS_PER_HOUR,
  TIME_STEP_MINUTES,
  DAYS_PER_YEAR,
  zeros,
  sumAll,
  monthStepRange,
  stepToMonth,
} from "@app/kernel/engine/time";
import type { BessInput, BessResult, Diagnostic, TimeSeries } from "@app/kernel/engine/types";

/** 储能模型版本。 */
export const BESS_MODEL_VERSION = "1.0.0";
export function bessModelCalcRef(): string {
  return `bess@${BESS_MODEL_VERSION}`;
}

const DT_HOURS = TIME_STEP_MINUTES / 60;

/** 非有限值归零。 */
function nz(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export interface BessComputationInput {
  bess: BessInput;
  /** 站点总负荷（kW，电网侧，含充电与换电）。 */
  loadProfileKw: TimeSeries;
  pvOutputKw: TimeSeries;
  priceProfileYuanPerKwh: TimeSeries;
  /** 峰段电价门槛（元/kWh，价格 ≥ 此值视为峰段）。 */
  peakPriceThreshold: number;
  /** 谷段电价门槛（元/kWh，价格 ≤ 此值视为谷段）。 */
  valleyPriceThreshold: number;
  /** 需量电价（元/kW·月），用于计算削峰收益；0 = 不计算。 */
  demandChargePerKwMonth: number;
  /**
   * 余电上网电价（元/kWh）——光伏富余时段充电的**机会成本**。
   *
   * 为什么必须要它：储能充的往往是「本来要上网卖掉」的光伏电，它的真实代价是「少卖了这几度」，
   * 而不是「按到户电价买了几度」。用买电价当作充电成本会系统性低估储能收益，
   * 甚至在谷段电价低于上网电价时得出「储能永远亏」的错误结论。
   */
  feedInTariffYuanPerKwh: number;
}

export interface BessComputation {
  result: BessResult;
  diagnostics: Diagnostic[];
  /** 逐时净负荷（kW，= 负荷 − 光伏；未含储能）。 */
  netLoadBeforeKw: TimeSeries;
}

/** 空结果（未启用储能）。 */
function emptyResult(): BessResult {
  const zero = zeros();
  return {
    chargeProfileKw: zero,
    dischargeProfileKw: zero,
    socProfilePct: new Array(STEPS_PER_YEAR).fill(0),
    annualChargeKwh: 0,
    annualDischargeKwh: 0,
    equivalentCycles: 0,
    arbitrageBenefitYuan: 0,
    demandChargeSavingYuan: 0,
    finalSocPct: 0,
    socViolations: 0,
  };
}

/**
 * 主计算：储能调度。
 *
 * 关键实现约束：**逐日规划、逐日执行**。每日先用当日已知的负荷/光伏/电价做一次计划
 * （充多少、放多少），再逐步执行；SOC 在日间连续传递。这样既避免了"看穿全年"的
 * 不可解释性，也避免了"逐步贪心"导致 SOC 被早早耗尽、峰段无电可放。
 */
export function computeBess(input: BessComputationInput): BessComputation {
  const { bess, loadProfileKw, pvOutputKw, priceProfileYuanPerKwh } = input;
  const diagnostics: Diagnostic[] = [];
  const netBefore = zeros();
  for (let t = 0; t < STEPS_PER_YEAR; t++) netBefore[t] = loadProfileKw[t] - pvOutputKw[t];

  if (!bess.enabled || bess.powerKw <= 0 || bess.energyKwh <= 0) {
    if (bess.enabled && (bess.powerKw <= 0 || bess.energyKwh <= 0)) {
      diagnostics.push({
        kind: "SCENARIO_INPUT_MISSING",
        code: "bess_capacity_missing",
        message: "已选择配置储能，但额定功率或额定容量为 0，储能按未配置处理。",
        field: "bess.powerKw",
        suggestion: "请填写储能的额定功率（kW）与额定容量（kWh），或关闭储能开关。",
      });
    }
    return { result: emptyResult(), diagnostics, netLoadBeforeKw: netBefore };
  }

  const socMin = Math.max(0, Math.min(100, bess.socMinPct));
  const socMax = Math.max(socMin, Math.min(100, bess.socMaxPct));
  const usableKwh = bess.energyKwh * ((socMax - socMin) / 100);
  const etaRt = Math.max(0.01, Math.min(1, bess.roundTripEfficiencyPct / 100));
  const etaEach = Math.sqrt(etaRt);
  const powerKw = bess.powerKw;
  const maxAcPerStep = powerKw * DT_HOURS;

  const chargeProfile = zeros();
  const dischargeProfile = zeros();
  const socProfile = new Array<number>(STEPS_PER_YEAR).fill(0);

  let socKwh = bess.energyKwh * (Math.max(socMin, Math.min(socMax, bess.initialSocPct)) / 100);
  let socViolations = 0;
  let annualChargeAc = 0;
  let annualDischargeAc = 0;
  let arbitrageBenefit = 0;

  for (let day = 0; day < DAYS_PER_YEAR; day++) {
    const base = day * STEPS_PER_DAY;
    const idx: number[] = [];
    for (let s = 0; s < STEPS_PER_DAY; s++) idx.push(base + s);

    /* ── 1) 当日充电/放电候选步 ── */
    const valleySteps: number[] = [];
    const peakSteps: number[] = [];
    const surplusSteps: number[] = [];
    let shaveThreshold = 0;

    if (bess.strategy === "peak-shaving") {
      // 阈值 = 当日净负荷的 80 分位（确定性：排序后取位）
      const sorted = idx.map((t) => netBefore[t]).sort((a, b) => a - b);
      shaveThreshold = sorted[Math.floor(sorted.length * 0.8)] ?? 0;
    }

    for (const t of idx) {
      const p = priceProfileYuanPerKwh[t];
      if (p <= input.valleyPriceThreshold) valleySteps.push(t);
      if (p >= input.peakPriceThreshold) peakSteps.push(t);
      if (netBefore[t] < 0) surplusSteps.push(t);
    }

    const chargeSteps =
      bess.strategy === "pv-shift"
        ? surplusSteps
        : bess.strategy === "peak-shaving"
          ? idx.filter((t) => priceProfileYuanPerKwh[t] < input.peakPriceThreshold)
          : valleySteps;

    const dischargeSteps =
      bess.strategy === "peak-shaving"
        ? idx.filter((t) => netBefore[t] > shaveThreshold && netBefore[t] > 0)
        : peakSteps;

    /* ── 2) 当日"值得放的电"（峰段/高峰时段实际需要的 AC 电量） ── */
    let dischargeNeedAc = 0;
    for (const t of dischargeSteps) {
      const need = Math.max(0, netBefore[t]);
      dischargeNeedAc += Math.min(need, powerKw) * DT_HOURS;
    }
    const dischargePowerCapAc = maxAcPerStep * Math.max(1, dischargeSteps.length);

    /* ── 3) 当日充放电计划 ──
     *
     * ⚠️ 这里的方向必须是「先算能充多少 → 再算能放多少」，**不能反过来**。
     * 曾经写成"充电目标 = 放电计划 ÷ 效率"，结果是：电池见底那天放电计划为 0
     * （因为没电可放）→ 充电计划也为 0（因为要放的量是 0）→ 电池再也充不上电，
     * 全年只放了初始 SOC 那一点点。这个死锁不会报错，只会让储能看起来"毫无价值"。
     *
     * 正确的因果：充电能力由「库容空位 + 可用的富余/低价电量 + 功率」决定；
     * 放电能力由「实际需要 + 当前实有电量 + 当天刚充进来的电量」决定。
     */
    const socHeadroomKwh = Math.max(0, bess.energyKwh * (socMax / 100) - socKwh);
    const acHeadroom = socHeadroomKwh / etaEach;
    let availableChargeAc = 0;
    for (const t of chargeSteps) {
      // pv-shift：只能用光伏富余（不额外买电）；其余策略：受功率上限约束的低价时段
      availableChargeAc +=
        bess.strategy === "pv-shift"
          ? Math.max(0, -netBefore[t]) * DT_HOURS
          : powerKw * DT_HOURS;
    }
    const chargePowerCapAc = maxAcPerStep * Math.max(1, chargeSteps.length);
    // 经济上限：当天需要放出去的量决定了最多需要充多少（不为充而充）
    const chargeTargetAc = Math.max(
      0,
      Math.min(acHeadroom, availableChargeAc, chargePowerCapAc, dischargeNeedAc / etaRt),
    );

    const acAvailableFromSoc = Math.max(0, (socKwh - bess.energyKwh * (socMin / 100)) * etaEach);
    const dischargePlanAc = Math.max(
      0,
      Math.min(dischargeNeedAc, dischargePowerCapAc, acAvailableFromSoc + chargeTargetAc * etaRt),
    );

    /* ── 4) 执行：**按时间顺序**逐步执行（保证 SOC 轨迹与执行顺序自洽） ──
     * 计划给出当日"充多少、放多少"的总量；执行必须沿时间轴走，否则 SOC 轨迹会是
     * 一个"按价格排序重放"的假轨迹（中途可能越界，而实际电池不会）。 */
    const chargeStepSet = new Set(chargeSteps);
    const dischargeStepSet = new Set(dischargeSteps);
    let remainingCharge = chargeTargetAc;
    let remainingDischarge = dischargePlanAc;

    for (let s = 0; s < STEPS_PER_DAY; s++) {
      const t = base + s;
      const socFloorKwh = bess.energyKwh * (socMin / 100);
      const socCeilKwh = bess.energyKwh * (socMax / 100);

      // 先放后充（同一时段不会既充又放：候选集合由策略保证互斥）
      if (dischargeStepSet.has(t) && remainingDischarge > 1e-9) {
        const need = Math.max(0, netBefore[t]);
        const perStep = Math.min(maxAcPerStep, remainingDischarge, need * DT_HOURS);
        if (perStep > 1e-9) {
          const dcAvailable = Math.max(0, socKwh - socFloorKwh);
          const dc = Math.min(perStep / etaEach, dcAvailable);
          const ac = dc * etaEach;
          if (ac > 1e-9) {
            socKwh -= dc;
            remainingDischarge -= ac;
            annualDischargeAc += ac;
            dischargeProfile[t] += ac;
            arbitrageBenefit += ac * priceProfileYuanPerKwh[t];
          }
        }
      } else if (chargeStepSet.has(t) && remainingCharge > 1e-9) {
        const perStep = Math.min(maxAcPerStep, remainingCharge);
        if (perStep > 1e-9) {
          const headroomDc = Math.max(0, socCeilKwh - socKwh);
          const dc = Math.min(perStep * etaEach, headroomDc);
          const ac = dc / etaEach;
          if (ac > 1e-9) {
            socKwh += dc;
            remainingCharge -= ac;
            annualChargeAc += ac;
            chargeProfile[t] += ac;
          }
        }
      }
      socProfile[t] = bess.energyKwh > 0 ? (socKwh / bess.energyKwh) * 100 : socMin;
    }
  }

  /* ── SOC 不变量校验（逐时） ── */
  const tol = 1e-6;
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const s = socProfile[t];
    if (!Number.isFinite(s) || s < socMin - tol || s > socMax + tol) socViolations++;
  }
  if (socViolations > 0) {
    diagnostics.push({
      kind: "CALCULATION_ERROR",
      code: "bess_soc_out_of_bounds",
      message: `储能 SOC 有 ${socViolations} 个时段越界（应恒在 ${socMin}%–${socMax}% 之间）。`,
      impact: "储能调度结果不可信，经济结论须作废。",
      suggestion: "这是计算引擎缺陷，请联系维护者；不要据此做投资判断。",
      value: socViolations,
      unit: "步",
    });
  }

  /* ── 充电成本（用于价差净收益）──
   * 富余时段充电 → 机会成本 = 上网电价（本来能卖的钱）；
   * 其余时段充电 → 实付到户电价。 */
  let chargeCost = 0;
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const ac = chargeProfile[t];
    if (ac <= 0) continue;
    const marginalPrice = netBefore[t] < 0 ? nz(input.feedInTariffYuanPerKwh) : priceProfileYuanPerKwh[t];
    chargeCost += ac * marginalPrice;
  }
  const arbitrageNet = arbitrageBenefit - chargeCost;

  /* ── 需量削峰收益（逐月：未配储的峰值 − 配储后的净下网峰值） ── */
  let demandSaving = 0;
  if (input.demandChargePerKwMonth > 0) {
    for (let m = 0; m < 12; m++) {
      const { start, end } = monthStepRange(m);
      let peakBase = 0;
      let peakWith = 0;
      for (let t = start; t < end; t++) {
        const net = loadProfileKw[t] - pvOutputKw[t];
        if (net > peakBase) peakBase = net;
        const netWith = net - dischargeProfile[t] + chargeProfile[t];
        if (netWith > peakWith) peakWith = netWith;
      }
      demandSaving += Math.max(0, peakBase - peakWith) * input.demandChargePerKwMonth;
    }
  }

  const equivCycles = usableKwh > 0 ? annualDischargeAc / usableKwh : 0;
  const finalSocPct = bess.energyKwh > 0 ? (socKwh / bess.energyKwh) * 100 : 0;

  if (chargeCost > 0 && arbitrageNet < 0) {
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "bess_negative_spread",
      message: '储能调度的价差净收益为负（放电回收 ' + round2(arbitrageBenefit).toLocaleString("zh-CN") + ' 元，充电机会成本 ' + round2(chargeCost).toLocaleString("zh-CN") + ' 元），约 ' + round2(arbitrageNet).toLocaleString("zh-CN") + ' 元/年。',
      impact: "在现有电价结构下储能不产生经济价值，其投资会直接拉低项目回报。",
      suggestion: '核对上网电价与谷段电价的关系：当上网电价接近或高于谷段到户电价时，储能「搬电」越搬越亏，应优先考虑取消储能，或把充电负荷挪到白天光伏时段。',
      value: round2(arbitrageNet),
      unit: "元/年",
    });
  }

  if (equivCycles > bess.maxCyclesPerYear && bess.maxCyclesPerYear > 0) {
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "bess_cycles_exceeded",
      message: `储能年等效循环约 ${equivCycles.toFixed(0)} 次，超过设定的年循环上限 ${bess.maxCyclesPerYear} 次。`,
      impact: "电池寿命可能短于项目期限，报告中按整期计算的收益偏乐观。",
      suggestion: "可降低储能容量或调整调度目标，使循环次数落在寿命允许范围内。",
      value: round2(equivCycles),
      unit: "次/年",
    });
  }

  return {
    result: {
      chargeProfileKw: chargeProfile.map(round2),
      dischargeProfileKw: dischargeProfile.map(round2),
      socProfilePct: socProfile.map((v) => round2(v)),
      annualChargeKwh: round2(annualChargeAc),
      annualDischargeKwh: round2(annualDischargeAc),
      equivalentCycles: round2(equivCycles),
      // 允许为负：负值本身就是「储能在这套电价结构下不产生价值」的证据，不能被截成 0 藏起来
      arbitrageBenefitYuan: round2(arbitrageNet),
      demandChargeSavingYuan: round2(demandSaving),
      finalSocPct: round2(finalSocPct),
      socViolations,
    },
    diagnostics,
    netLoadBeforeKw: netBefore,
  };
}

/** 某月的储能净出力（kW，正 = 放电），供报告展示。 */
export function monthlyBessNetKwh(chargeKw: TimeSeries, dischargeKw: TimeSeries): number[] {
  const out = new Array(12).fill(0);
  for (let t = 0; t < STEPS_PER_YEAR; t++) {
    const m = stepToMonth(t);
    out[m] += (dischargeKw[t] - chargeKw[t]) * DT_HOURS;
  }
  return out.map(round2);
}

/** 年充电量（kWh，含损耗前的交流侧）。 */
export function annualBessChargeKwh(chargeKw: TimeSeries): number {
  return round2(sumAll(chargeKw) * DT_HOURS);
}

/** 年放电量（kWh，交流侧）。 */
export function annualBessDischargeKwh(dischargeKw: TimeSeries): number {
  return round2(sumAll(dischargeKw) * DT_HOURS);
}

/** 小时 → 步（供 UI 对齐时间轴）。 */
export function hourToStep(hour: number): number {
  return Math.round(hour * STEPS_PER_HOUR);
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
