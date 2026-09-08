/**
 * R9.0 Step 1 · Storage Value Engine（SVE）纯函数模块 —— 储能价值（峰谷套利 + 光伏消纳）。
 *
 * ✅ 状态（R9.0 Step 2/3，2026-09-08）：
 *   本模块已接入生产经济层：`sandbox-model.ts` E3b 把逐年 Δ_sto 加性记入收入侧（E4 保持扁平反事实，
 *   I3 恒等式防重复计价），`MODEL_VERSION` 1.0.0→1.1.0，新增 6 个 storage-scoped 参数
 *   （5 个 tech.storage* 新键 + 复用 region.peakValleySpread，仅 hasStorage 时校验）。
 *   Step 1 四项裁决落档不变（ISSUE-1 选 A / ISSUE-2 margin 优先 / ISSUE-3 不预设 argmax / ISSUE-4 σ 年度代理），
 *   详见文件尾「裁决记录」；S1 消纳腿在年度平衡下诚实归零（缺口已声明，待日内形态建模立项）。
 *
 * 历史（Step 1 期曾为独立实验性纯函数，未接经济层；接入与版本归属在 Step 2/3 经创始人授权完成）。
 *
 * 设计依据：`docs/STORAGE_VALUE_ENGINE_R9_0.md`。三函数：
 *   1) `storageThroughputCapped` —— 储能年吞吐（容量×SOC窗口 与 功率×放电时长 双封顶 + 寿命封顶 + 逐年容量衰减）。
 *   2) `energyFlowLedger`        —— Energy Flow Ledger：把可用放电量分配到套利腿/光伏消纳腿，保证每一度电只落一个价值桶。
 *   3) `storageValueDelta`       —— 单年编排：吞吐 + 账本 → Δ_arb / Δ_pv / Δ_sto（元/年，E3 的加性增量口径）。
 *
 * ✅ MODEL_LOGIC_ISSUE-1（已裁决：创始人 2026-09-08 选 A，详见文件尾「裁决记录」）：
 *   设计稿 §4.4 原套利公式为 `M_arb·(p_peak − p_valley/η)`，与本实现采用的 `M_arb·(p − p_valley/η)` 相悖；
 *   创始人裁决**采纳本实现口径、弃用 p_peak**。原因（裁决理由）：现有 E4 已按 `Imp0 × p` 计入基线
 *   购电成本，若 Δ_arb 再使用 p_peak 会造成重复计价（每度多记 `(p_peak − p)` = spread/2）。
 *   `p − p_valley/η` 口径可被恒等式验证（见测试 "与扁平 E4 反事实的成本差恒等于 Δ_sto"）：
 *     Imp0·p − [ (Imp0−mArb−mPv)·p + (mArb/η)·p_valley + (mPv/η)·feedIn ] ≡ Δ_arb + Δ_pv。
 *   强制方法论声明（裁决原文）：**V1 采用年度平均购电价基线上的储能增量价值估算，并非逐时峰谷
 *   电价模型**；逐时电价 / E4 分时化以后单独立项（届时属新口径变更，须另走版本裁决并重推公式）。
 *
 * 诚实边界（宪法 §16/§20）：全部默认值域由调用方（未来参数引擎）约束；本模块对非法输入一律
 *   `ok:false` 诚实拒绝（绝不编造），由 `storageValueDelta` 安全归零。所有产出仍须
 *   `needsProfessionalReview=true`；数值**不做四舍五入**（精度留给集成/呈现层，测试需要精确不变量）。
 *   纯函数：无 IO / 无时钟 / 无随机 / 无依赖（不 import 任何项目模块）。
 */

/* ─────────────────────────── 1. 储能年吞吐（容量/功率双封顶 + 寿命 + 衰减） ─────────────────────────── */

export interface StorageThroughputInput {
  /** 储能额定容量 E_cap [kWh]。≤0 / 非有限 → no_storage / invalid。 */
  storageEnergyKwh: number;
  /** 储能额定功率 P_rated [kW]。≤0 / 非有限 → no_storage / invalid。 */
  storagePowerKw: number;
  /** SOC 下限 [%，0–100]。须 0 ≤ min < max ≤ 100。 */
  socMinPct: number;
  /** SOC 上限 [%，0–100]。 */
  socMaxPct: number;
  /** 每天可"满功率向价值窗口放电"的小时数 H_dis [h/日]。>0。 */
  dischargeWindowHours: number;
  /** 年运营天数 [天/年]。>0。 */
  operatingDays: number;
  /** 循环寿命 [次]；非有限或 ≤0 → 视为不限（与既有 S4 口径一致）。 */
  cycleLife: number;
  /** 日历寿命 [年]；与 cycleLife 同时有限且 >0 时才启用寿命折算。 */
  calendarLifeYears: number;
  /** 储能年容量衰减 δ_s [%/年，0–100]，与光伏 S2 衰减同构。 */
  degradationPctPerYear: number;
  /** 年序（1-based）；用于衰减因子 (1−δ/100)^(y−1)。 */
  yearIndex: number;
}

/** 单次循环可用放电量的约束来源（诊断用）。 */
export type ThroughputBinding = "energy" | "power" | "balanced";

export interface StorageThroughputOk {
  ok: true;
  /** 可用 SOC 窗口 w = (max−min)/100 ∈ (0,1]。 */
  socWindowFraction: number;
  /** 容量侧单次放电上界 = E_cap·w [kWh]。 */
  energyBoundPerCycleKwh: number;
  /** 功率侧单次放电上界 = P_rated·H_dis [kWh]。 */
  powerBoundPerCycleKwh: number;
  /** 单次循环可放电量 = min(容量界, 功率界) [kWh]。 */
  perCycleDischargeKwh: number;
  /** 本组参数下哪个约束生效。 */
  binding: ThroughputBinding;
  /** 年循环次数 = min(运营天数, cycleLife/calendarLife) [次/年]。 */
  annualCycles: number;
  /** 容量衰减因子 (1−δ_s/100)^(y−1) ∈ (0,1]。 */
  capacityFadeFactor: number;
  /** 第 y 年可用放电上界 D_max [kWh/年] = 单次 × 年循环 × 衰减。 */
  dMaxKwh: number;
}

export interface StorageThroughputErr {
  ok: false;
  reason:
    | "no_storage" // storageEnergy/storagePower ≤ 0：按"未配储能"合法归零（非错误）
    | "invalid_input" // 容量/功率非有限
    | "invalid_soc" // SOC 窗口非法
    | "invalid_window" // 放电时长非法
    | "invalid_operating_days"
    | "invalid_degradation"
    | "invalid_year";
  detail: string;
}

export type StorageThroughputResult = StorageThroughputOk | StorageThroughputErr;

/**
 * 储能年吞吐上界（能量口径，终端放电侧）。
 *   e_cycle = min(E_cap·w, P_rated·H_dis)      ← §8 容量与功率**分别**建模，缺一不可
 *   cycles  = min(operatingDays, CycLife/CalLife)（寿命参数不有限/非法 → 不限）
 *   D_max,y = e_cycle · cycles · (1−δ_s/100)^(y−1)
 * η（往返效率）**不在此处**——它以"充电侧多抽 1/η"的形式进入账本（见 energyFlowLedger），
 * 修正既有 S4 把整个 RTE 压在放电侧的口径（损耗记在充电侧物理上更准：先买、后损）。
 */
export function storageThroughputCapped(input: StorageThroughputInput): StorageThroughputResult {
  const {
    storageEnergyKwh: eCap,
    storagePowerKw: pRated,
    socMinPct,
    socMaxPct,
    dischargeWindowHours: hDis,
    operatingDays,
    cycleLife,
    calendarLifeYears,
    degradationPctPerYear,
    yearIndex,
  } = input;

  if (!Number.isFinite(eCap) || !Number.isFinite(pRated))
    return { ok: false, reason: "invalid_input", detail: "storageEnergy/storagePower 含非有限值" };
  if (eCap <= 0 || pRated <= 0)
    return { ok: false, reason: "no_storage", detail: "storageEnergy≤0 或 storagePower≤0：按未配储能处理" };
  if (
    !Number.isFinite(socMinPct) ||
    !Number.isFinite(socMaxPct) ||
    socMinPct < 0 ||
    socMaxPct > 100 ||
    socMinPct >= socMaxPct
  )
    return { ok: false, reason: "invalid_soc", detail: "SOC 窗口非法（须 0 ≤ SocMin < SocMax ≤ 100）" };
  if (!Number.isFinite(hDis) || hDis <= 0)
    return { ok: false, reason: "invalid_window", detail: "dischargeWindowHours 须为正有限值" };
  if (!Number.isFinite(operatingDays) || operatingDays <= 0)
    return { ok: false, reason: "invalid_operating_days", detail: "operatingDays 须为正有限值" };
  if (!Number.isFinite(degradationPctPerYear) || degradationPctPerYear < 0 || degradationPctPerYear > 100)
    return { ok: false, reason: "invalid_degradation", detail: "degradationPctPerYear 须 ∈ [0,100]" };
  if (!Number.isFinite(yearIndex) || yearIndex < 1)
    return { ok: false, reason: "invalid_year", detail: "yearIndex 须 ≥ 1" };

  const socWindowFraction = (socMaxPct - socMinPct) / 100;
  const energyBoundPerCycleKwh = eCap * socWindowFraction;
  const powerBoundPerCycleKwh = pRated * hDis;
  const perCycleDischargeKwh = Math.min(energyBoundPerCycleKwh, powerBoundPerCycleKwh);
  const binding: ThroughputBinding =
    perCycleDischargeKwh === energyBoundPerCycleKwh && perCycleDischargeKwh === powerBoundPerCycleKwh
      ? "balanced"
      : perCycleDischargeKwh === energyBoundPerCycleKwh
        ? "energy"
        : "power";

  const lifeLimitedCyclesPerYear =
    Number.isFinite(cycleLife) && Number.isFinite(calendarLifeYears) && calendarLifeYears > 0
      ? cycleLife / calendarLifeYears
      : Infinity;
  const annualCycles = Math.min(operatingDays, lifeLimitedCyclesPerYear);
  const capacityFadeFactor = (1 - degradationPctPerYear / 100) ** (yearIndex - 1);

  return {
    ok: true,
    socWindowFraction,
    energyBoundPerCycleKwh,
    powerBoundPerCycleKwh,
    perCycleDischargeKwh,
    binding,
    annualCycles,
    capacityFadeFactor,
    dMaxKwh: perCycleDischargeKwh * annualCycles * capacityFadeFactor,
  };
}

/* ─────────────────────────── 2. Energy Flow Ledger（分配 + 防重复计算） ─────────────────────────── */

export interface EnergyFlowLedgerInput {
  /** 当年可用放电上界 D_max [kWh/年]（来自 storageThroughputCapped；0 合法=无可用吞吐）。 */
  dMaxKwh: number;
  /** 往返效率 η ∈ (0,1]（小数）。损耗全部记在充电侧（多抽 1/η）。 */
  etaFraction: number;
  /** 当年光伏富余 Exp0 [kWh/年]（技术层：max(0, PV−负荷)）。≥0。 */
  pvSurplusKwh: number;
  /** 当年下网电量 Imp0 [kWh/年]（技术层：max(0, 负荷−PV)）。≥0。 */
  gridImportKwh: number;
  /**
   * 峰时占比 σ ∈ [0,1]（ISSUE-4 裁决保留的年度代理口径，创始人 2026-09-08）：
   * σ 不是逐时真实峰时电量，而是"峰时可套利下网电量比例"的年度代理。
   * 标记 ASSUMPTION；凡含本模块产出的结论恒 needsProfessionalReview=true。
   */
  peakLoadShareFraction: number;
  /** 扁平工商业电价 p [元/kWh]（= E4 现行口径；套利"避免的购电"按此价计，防与 E4 重复，见头注）。 */
  elecPriceYuanPerKwh: number;
  /** 峰谷价差 spread [元/kWh]：p_valley = p − spread/2。可为任意有限值，负价差自然关断套利。 */
  spreadYuanPerKwh: number;
  /** 余电上网电价 feedIn [元/kWh]（消纳腿的机会成本）。≥0。 */
  feedInYuanPerKwh: number;
}

export interface EnergyFlowLedgerOk {
  ok: true;
  /** 谷时电价 p_valley = p − spread/2 [元/kWh]（诊断透出）。 */
  valleyPriceYuanPerKwh: number;
  /** 峰时电价 p_peak = p + spread/2 [元/kWh]（诊断透出；**不参与**套利计价，见头注 ISSUE-1）。 */
  peakPriceYuanPerKwh: number;
  /** 套利腿每度净收益 = p − p_valley/η [元/kWh]（与扁平 E4 自洽口径）。 */
  arbUnitMarginYuanPerKwh: number;
  /** 消纳腿每度净收益 = p − feedIn/η [元/kWh]。 */
  pvUnitMarginYuanPerKwh: number;
  /** 套利腿是否开启（margin>0 才运行；操作者不做负套利）。 */
  arbOpen: boolean;
  /** 消纳腿是否开启。 */
  pvOpen: boolean;
  /** 套利腿放电量 M_arb [kWh/年] = min(D_max, σ·Imp0)，腿关断时 0。 */
  mArbKwh: number;
  /** 消纳腿放电量 M_pv [kWh/年] = min(D_max−M_arb, η·Exp0, (1−σ)·Imp0)，腿关断时 0。 */
  mPvKwh: number;
  /** 被储能截走的光伏 = M_pv/η [kWh/年]（从上网侧扣除，防"同一度光伏既上网又消纳"）。 */
  pvDivertedKwh: number;
  /** 截走后仍上网的光伏 = Exp0 − M_pv/η [kWh/年] ≥ 0。 */
  pvExportAfterKwh: number;
  /** 套利腿谷时抽电 = M_arb/η [kWh/年]。 */
  arbitrageGridDrawKwh: number;
  /** 套利损耗 = M_arb·(1/η−1) [kWh/年]。 */
  arbitrageLossKwh: number;
  /** 账后总购电 = Imp0 − M_pv + M_arb·(1/η−1) [kWh/年]（≥0；仅诊断，E4 本阶段不动）。 */
  gridPurchaseAfterKwh: number;
  /** Δ_arb [元/年] = M_arb × (p − p_valley/η) ≥ 0。 */
  dArbYuan: number;
  /** Δ_pv [元/年] = M_pv × (p − feedIn/η) ≥ 0。 */
  dPvYuan: number;
  /** Δ_sto [元/年] = Δ_arb + Δ_pv ≥ 0。 */
  dStoYuan: number;
}

export interface EnergyFlowLedgerErr {
  ok: false;
  reason:
    | "invalid_dmax" // D_max 非有限或负
    | "invalid_eta" // η 非有限或 ∉ (0,1]
    | "invalid_energy" // Exp0/Imp0 非有限或负（负能量拒绝）
    | "invalid_share" // σ ∉ [0,1]
    | "invalid_prices"; // 电价/上网价非有限或负；价差非有限
  detail: string;
}

export type EnergyFlowLedgerResult = EnergyFlowLedgerOk | EnergyFlowLedgerErr;

/**
 * Energy Flow Ledger：把 D_max 分配到两条价值腿，并给出完整的能量去向账本。
 *
 * 分配规则（**margin 优先 = 单位净收益高者先占预算**；ISSUE-2 已获创始人批准，2026-09-08）：
 *   为什么 margin 优先是本模型的最优分配（裁决批准的最优性论证）：两条价值腿在当前 V1 模型下
 *   均为**线性单位价值**（每度放电的收益恒等于各自 margin，与分配量无关），且共享有限 D_max——
 *   这正是分数背包问题的结构，按单位价值降序贪心即全局最优。它同时保证三条已实测性质：
 *   η 下降时储能总价值不增、spread/feedIn 变化时价值单调不降、I1/I2/I3 不变量不被破坏。
 *   （历史注：设计稿 §4.3 原为固定"套利优先"，被 Step 1 测试证伪——两腿 margin 差异大时次优，
 *   且出现"η 降→预算释放→总价值反升"的物理悖论，详见文件尾「裁决记录」。）
 *   1) 只运行 margin>0 的腿（操作者不做负价值循环）；margin 高者先取 min(D_max, 各自容量片)，剩余给另一腿。
 *   2) 套利腿容量片 = σ·Imp0（峰时时间片，放电侧口径）；消纳腿容量片 = min(η·Exp0, (1−σ)·Imp0)。
 *   3) margin 相等时套利优先（确定性平局规则）。
 *
 * 三条防重复计算不变量（测试逐条钉死）：
 *   I1  M_arb + M_pv ≤ D_max（同一循环预算不可两腿重复占用）；
 *   I2  M_pv/η ≤ Exp0 且 (M_pv/η) + (Exp0 − M_pv/η) ≡ Exp0（一度光伏只有一个去向）；
 *   I3  与扁平 E4 反事实的成本差恒等 Δ_sto（套利腿不重复抵扣 E4 购电量，见头注与测试）。
 */
export function energyFlowLedger(input: EnergyFlowLedgerInput): EnergyFlowLedgerResult {
  const {
    dMaxKwh,
    etaFraction: eta,
    pvSurplusKwh: exp0,
    gridImportKwh: imp0,
    peakLoadShareFraction: sigma,
    elecPriceYuanPerKwh: p,
    spreadYuanPerKwh: spread,
    feedInYuanPerKwh: feedIn,
  } = input;

  if (!Number.isFinite(dMaxKwh) || dMaxKwh < 0)
    return { ok: false, reason: "invalid_dmax", detail: "dMaxKwh 须为非负有限值" };
  if (!Number.isFinite(eta) || eta <= 0 || eta > 1)
    return { ok: false, reason: "invalid_eta", detail: "etaFraction 须 ∈ (0,1]" };
  if (!Number.isFinite(exp0) || exp0 < 0 || !Number.isFinite(imp0) || imp0 < 0)
    return { ok: false, reason: "invalid_energy", detail: "pvSurplus/gridImport 须为非负有限值（负能量拒绝）" };
  if (!Number.isFinite(sigma) || sigma < 0 || sigma > 1)
    return { ok: false, reason: "invalid_share", detail: "peakLoadShareFraction 须 ∈ [0,1]" };
  if (!Number.isFinite(p) || p < 0 || !Number.isFinite(feedIn) || feedIn < 0 || !Number.isFinite(spread))
    return { ok: false, reason: "invalid_prices", detail: "电价/上网价须为非负有限值，价差须有限" };

  const valleyPriceYuanPerKwh = p - spread / 2;
  const peakPriceYuanPerKwh = p + spread / 2;
  const arbUnitMarginYuanPerKwh = p - valleyPriceYuanPerKwh / eta;
  const pvUnitMarginYuanPerKwh = p - feedIn / eta;
  const arbOpen = arbUnitMarginYuanPerKwh > 0;
  const pvOpen = pvUnitMarginYuanPerKwh > 0;

  // 分配：margin 高的腿先占预算（分数背包贪心最优，保证 η/spread/feedIn 单调性，见函数头注）。
  const arbSliceKwh = sigma * imp0; // 套利容量片 = 峰时时间片（放电侧口径，指令 §6）
  const pvSliceKwh = Math.min(eta * exp0, (1 - sigma) * imp0); // 消纳容量片 = 截光伏 ≤ Exp0 且只抵非峰片
  let budgetKwh = dMaxKwh;
  let mArbKwh = 0;
  let mPvKwh = 0;
  const arbFirst = arbUnitMarginYuanPerKwh >= pvUnitMarginYuanPerKwh;
  if (arbOpen && arbFirst) {
    mArbKwh = Math.min(budgetKwh, arbSliceKwh);
    budgetKwh -= mArbKwh;
  }
  if (pvOpen) {
    mPvKwh = Math.min(budgetKwh, pvSliceKwh);
    budgetKwh -= mPvKwh;
  }
  if (arbOpen && !arbFirst) {
    mArbKwh = Math.min(budgetKwh, arbSliceKwh);
    budgetKwh -= mArbKwh;
  }

  const pvDivertedKwh = mPvKwh / eta;
  const pvExportAfterKwh = exp0 - pvDivertedKwh;
  const arbitrageGridDrawKwh = mArbKwh / eta;
  const arbitrageLossKwh = mArbKwh * (1 / eta - 1);
  const gridPurchaseAfterKwh = imp0 - mPvKwh + arbitrageLossKwh;

  const dArbYuan = mArbKwh * arbUnitMarginYuanPerKwh;
  const dPvYuan = mPvKwh * pvUnitMarginYuanPerKwh;

  return {
    ok: true,
    valleyPriceYuanPerKwh,
    peakPriceYuanPerKwh,
    arbUnitMarginYuanPerKwh,
    pvUnitMarginYuanPerKwh,
    arbOpen,
    pvOpen,
    mArbKwh,
    mPvKwh,
    pvDivertedKwh,
    pvExportAfterKwh,
    arbitrageGridDrawKwh,
    arbitrageLossKwh,
    gridPurchaseAfterKwh,
    dArbYuan,
    dPvYuan,
    dStoYuan: dArbYuan + dPvYuan,
  };
}

/* ─────────────────────────── 3. 单年编排（吞吐 → 账本 → Δ_sto） ─────────────────────────── */

/** `storageValueDelta` 的单年输入 = 吞吐输入 + 账本输入（去掉 dMax，由吞吐产出）。 */
export type StorageValueYearInput = StorageThroughputInput & Omit<EnergyFlowLedgerInput, "dMaxKwh">;

/** 成功：吞吐与账本完整透出 + 三条价值增量（元/年）。 */
export interface StorageValueDeltaOk {
  ok: true;
  included: true;
  throughput: StorageThroughputOk;
  ledger: EnergyFlowLedgerOk;
  dArbYuan: number;
  dPvYuan: number;
  dStoYuan: number;
}

/** 安全归零：未配储能（合法）或输入非法（诚实拒绝）。Δ 全 0，绝不产生 NaN/负值。 */
export interface StorageValueDeltaZero {
  ok: true;
  included: false;
  reason: string;
  throughput: null;
  ledger: null;
  dArbYuan: 0;
  dPvYuan: 0;
  dStoYuan: 0;
}

export type StorageValueDeltaResult = StorageValueDeltaOk | StorageValueDeltaZero;

/**
 * 单年储能价值增量：吞吐（功率/容量/SOC/寿命/衰减封顶）→ 账本（两腿分配 + 防重复）→ Δ_sto。
 * 任一环节非法 → 安全归零（included:false + reason），绝不向下传播 NaN/Infinity/负值。
 * 价格入参为"当年名义价"（通胀由未来集成层按 E5 口径先行放大，本模块不碰通胀）。
 */
export function storageValueDelta(input: StorageValueYearInput): StorageValueDeltaResult {
  const throughput = storageThroughputCapped(input);
  if (!throughput.ok) {
    return {
      ok: true,
      included: false,
      reason: `${throughput.reason}: ${throughput.detail}`,
      throughput: null,
      ledger: null,
      dArbYuan: 0,
      dPvYuan: 0,
      dStoYuan: 0,
    };
  }
  const ledger = energyFlowLedger({
    dMaxKwh: throughput.dMaxKwh,
    etaFraction: input.etaFraction,
    pvSurplusKwh: input.pvSurplusKwh,
    gridImportKwh: input.gridImportKwh,
    peakLoadShareFraction: input.peakLoadShareFraction,
    elecPriceYuanPerKwh: input.elecPriceYuanPerKwh,
    spreadYuanPerKwh: input.spreadYuanPerKwh,
    feedInYuanPerKwh: input.feedInYuanPerKwh,
  });
  if (!ledger.ok) {
    return {
      ok: true,
      included: false,
      reason: `${ledger.reason}: ${ledger.detail}`,
      throughput: null,
      ledger: null,
      dArbYuan: 0,
      dPvYuan: 0,
      dStoYuan: 0,
    };
  }
  return {
    ok: true,
    included: true,
    throughput,
    ledger,
    dArbYuan: ledger.dArbYuan,
    dPvYuan: ledger.dPvYuan,
    dStoYuan: ledger.dStoYuan,
  };
}

/*
 * ─────────────────────────── 裁决记录（创始人 2026-09-08，Step 1 正式收口）───────────────────────────
 *
 * MODEL_LOGIC_ISSUE-1 · 已裁决（选项 A）：
 *   问题：设计稿 §4.4 套利公式 `Δ_arb = M_arb·(p_peak − p_valley/η)` 与同一文档 §二/§十五 的集成
 *         架构「E4 保持扁平电价 Imp0×p 不变 + 储能收益作加性增量」互相矛盾。
 *   原因：扁平 E4 已对被套利移走的峰时电量按均价 p 计过一次购电费；增量再按 p_peak 计"避免的
 *         峰价"，则每度电重复计入 (p_peak − p) = spread/2 元。
 *   裁决：**选项 A** —— 维持 E4 单一平均电价不改；采纳本实现 `Δ_arb = M_arb·(p − p_valley/η)`；
 *         不使用 p_peak 作为 E3 增量项。设计稿 §4.2/§4.4/§5/§6 已同步修订。
 *   强制声明（裁决原文）：V1 采用年度平均购电价基线上的储能增量价值估算，并非逐时峰谷电价模型；
 *         逐时电价 / E4 分时化以后单独立项（届时属新口径变更，须另走 §16 版本裁决并重推公式）。
 *
 * MODEL_LOGIC_ISSUE-2 · 已批准（margin 优先分配）：
 *   问题：设计稿 §4.3 的"固定优先级=套利优先"被 Step 1 测试证伪：基准参数下消纳腿单位净收益更高
 *         （p−feedIn/η=0.3023 > p−p_valley/η=0.2455），固定顺序让低价值腿先占满循环预算，总价值
 *         次优；且当 η 降到套利关断时预算释放给消纳腿，出现"效率下降→总收益反升"的物理悖论
 *         （实测 η=0.58 时 10,344 元 → η=0.55 时 63,636 元），违反"η 越低价值不应增加"。
 *   裁决：采用"单位经济价值 margin 高者优先占用共享储能循环预算；margin 相等时套利优先"，
 *         M_arb + M_pv ≤ D_max。最优性理由（裁决批准，写入函数头注与设计稿 §4.3）：两条价值腿在
 *         当前 V1 模型下均为线性单位价值，且共享有限 D_max，因此 margin 优先（分数背包贪心）是
 *         当前简化模型中的最优分配规则——并据此保证 η 单调不增 / spread·feedIn 单调不减 /
 *         I1·I2·I3 不变量不破（三条性质保留为常驻测试）。
 *
 * ISSUE-3（容量响应表述纪律）· 已裁决：不预设"必然存在最优容量/argmax"——统一表述为
 *         "系统在给定容量搜索范围内寻找最优配置；可能存在内部最优点、端点最优，或在当前范围内
 *         持续增加/持续下降"。测试须按 A/B/C 三态如实断言所在形态（见单测 D 区分类器）。
 * ISSUE-4（σ 时间代理）· 已裁决：保留 `tech.storagePeakLoadShare` 与 V1 年度代理口径；方法论明确
 *         "σ 不是逐时真实峰时电量，而是峰时可套利下网电量比例的年度代理"；ASSUMPTION ·
 *         needsProfessionalReview=true。σ·Imp0 时间片取放电侧口径（与本实现一致）随本裁决一并落档。
 *
 * 本批范围＝设计文档 / 模块注释 / 测试说明文字同步；未接入 E3、未改 E4、未动任何 *_VERSION、
 * 未重录黄金样本、未改数据库与历史结果、未接支付、未进融资模型。
 */
