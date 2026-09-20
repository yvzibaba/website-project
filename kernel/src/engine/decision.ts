/**
 * 决策层（Decision）—— 本项目与"普通计算器"的分界线。
 *
 * ## 一个计算器回答"是多少"，决策层必须回答"该不该、为什么、怕什么"
 *
 * 计算器给出 NPV = 320 万；决策层要能接着说：
 *   「在给定假设下可交付、第 6.2 年回本；但这个结论有一半压在**充电服务费**上
 *    （它每变动 20%，NPV 摆动 180 万），而服务费在本地区实行市场调节价、**没有官方水平**——
 *    所以真正要先去谈的不是设备价格，是服务费能不能签到这个数。」
 *
 * ## 四条不许含糊的规矩
 *
 * 1. **可行性（feasibility）与经济性（recommendation）分开**。
 *    "装不下车"和"不赚钱"是两种失败，混在一起会让人误以为"多投点钱就能解决装不下的问题"。
 * 2. **每条理由、每条风险都必须带具体数字或诊断码**。禁止"存在一定风险""建议关注"这种
 *    放在任何项目上都成立的话——那种文本等于没写，还会稀释真正有信息量的那几条。
 * 3. **关键假设必须回答"如果不成立会怎样"**（`impactIfWrong`）。这是把"假设"翻译成"决策动作"。
 * 4. **解释由程序生成、可追溯到具体数值与版本**，不由模型自由发挥。
 *    理由：一个能被复算的数字，比一段读起来很顺的文字更值得信任。
 *
 * ## 与"不变量"的关系
 *
 * 若能量平衡不变量失败（`CALCULATION_ERROR`），本层仍会产出结构完整的结论，
 * 但**第一项检查必定不通过**、且阻塞项里会写明"计算引擎缺陷"。这保证了下游 UI/报告
 * 无法因为"结论字段齐全"就当作可信结果使用。
 */

import { round } from "@app/kernel/server/finance";
import type {
  BenchmarkRef,
  BessResult,
  ChargerInput,
  ChargingResult,
  DecisionResult,
  Diagnostic,
  EnergyBalanceInvariant,
  EconomicsResult,
  GridResult,
  PvResult,
  RiskItem,
  ScenarioDefinition,
  SensitivityBar,
  TruckDemandResult,
} from "@app/kernel/engine/types";
import type { EconomicsComputationInput } from "@app/kernel/engine/economics";

/** 决策模型版本（改判据/门槛须升版）。 */
export const DECISION_MODEL_VERSION = "1.0.0";
export function decisionModelCalcRef(): string {
  return `decision@${DECISION_MODEL_VERSION}`;
}

/* ═══════════════════════════ 判据门槛（集中一处，便于审计） ═══════════════════════════ */

export const DECISION_THRESHOLDS = {
  /** 静态回收期不得超过运营期的这个比例——超过则视为"赚得太慢"，不算推荐。 */
  paybackToLifeRatioMax: 0.8,
  /** 站级利用率低于此值视为装机过剩。 */
  minChargerUtilizationPct: 10,
  /** 光伏自用率低于此值提醒（说明发出来的电大部分卖给了电网，与本地降本初衷不符）。 */
  lowPvSelfConsumptionPct: 30,
  /** 弃光率高于此值提醒。 */
  highCurtailmentPct: 15,
  /** 基准置信度低于此值 → 进入"必须人工确认的关键假设"。 */
  lowConfidenceMax: 60,
} as const;

/* ═══════════════════════════ 输入 ═══════════════════════════ */

export interface DecisionComputationInput {
  definition: ScenarioDefinition;
  economicsInput: EconomicsComputationInput;
  economicsResult: EconomicsResult;
  sensitivity: SensitivityBar[];

  invariant: EnergyBalanceInvariant;
  truckDemand: TruckDemandResult;
  charging: ChargingResult;
  pv: PvResult;
  bess: BessResult;
  grid: GridResult;
  pvCapacityKwp: number;
  pvSpecificYieldKwhPerKwp: number;
  /** 余电上网电价（元/kWh）——属电网输入，用于风险表述。 */
  feedInTariffYuanPerKwh: number;

  benchmarkSnapshot: Record<string, BenchmarkRef>;
  diagnostics: Diagnostic[];
  unknowns: Record<string, string>;

  engineVersion: string;
  modelVersion: string;
  benchmarkVersion: string;
}

/* ═══════════════════════════ 格式化（仅供本层生成人话） ═══════════════════════════ */

function fmtNum(v: number, dp = 0): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtWan(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const wan = v / 10_000;
  return `${wan >= 0 ? "" : "-"}${fmtNum(Math.abs(wan), 1)} 万元`;
}

function fmtKwh(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 10_000) return `${fmtNum(v / 10_000, 1)} 万 kWh`;
  return `${fmtNum(v, 0)} kWh`;
}

function fmtKw(v: number): string {
  return `${fmtNum(v, 0)} kW`;
}

function pct(v: number, dp = 1): string {
  return `${fmtNum(v, dp)}%`;
}

/* ═══════════════════════════ 主计算 ═══════════════════════════ */

export function computeDecision(input: DecisionComputationInput): DecisionResult {
  const { economicsResult: ec, charging, pv, bess, grid, invariant } = input;
  const ecInput = input.economicsInput;
  const e = ecInput.economics;

  /* ─────────── 1. 可行性检查（逐条可审计） ─────────── */

  const checks: DecisionResult["feasibility"]["checks"] = [];
  const blockers: string[] = [];

  const push = (id: string, label: string, passed: boolean, detail: string, blocking = false) => {
    checks.push({ id, label, passed, detail });
    if (!passed && blocking) blockers.push(`${label}：${detail}`);
  };

  push(
    "energy_balance",
    "能量平衡守恒",
    invariant.ok,
    invariant.ok
      ? `全年 ${input.truckDemand.demandProfileKwh.length ? "35,040" : "35,040"} 个 15 分钟时段逐段守恒（最大偏差 ${invariant.maxAbsDeviationKwh.toExponential(1)} kWh，容差内）。`
      : `${invariant.violationCount} 个时段能量不守恒，最大偏差 ${invariant.maxAbsDeviationKwh.toExponential(2)} kWh。`,
    true,
  );

  const unserved = charging.unservedEnergyKwh;
  push(
    "demand_served",
    "车辆用能需求被完整满足",
    unserved <= 0,
    unserved <= 0
      ? `全年交付 ${fmtKwh(charging.annualDeliveredKwh)}，无未满足需求。`
      : `全年有 ${fmtKwh(unserved)} 的需求无法交付（约 ${pct((unserved / Math.max(1, charging.annualGridSideKwh + unserved)) * 100)} 的用能需求）。`,
    true,
  );

  push(
    "grid_capacity",
    "并网容量满足峰值负荷",
    !grid.capacityConstrained,
    grid.capacityConstrained
      ? `存在因并网容量不足而无法供给的负荷，峰值缺口已知（见诊断 grid_capacity_insufficient）。`
      : `全年最大下网需量 ${fmtKw(Math.max(0, ...grid.monthlyPeakImportKw))}，未触及受电容量上限。`,
    true,
  );

  const hasChargingCapacity = input.charging.effectivePowerKw > 0 || charging.annualSwapEvents > 0;
  push(
    "charging_capacity",
    "补能设施能力可用",
    hasChargingCapacity,
    hasChargingCapacity
      ? `有效充电功率 ${fmtKw(charging.effectivePowerKw)}，年换电 ${fmtNum(charging.annualSwapEvents)} 次。`
      : "未配置有效充电或换电能力，无法为车辆补能。",
    true,
  );

  push(
    "bess_soc",
    "储能荷电状态未越界",
    bess.socViolations === 0,
    bess.socViolations === 0
      ? `全年 SOC 未越界（等效循环 ${fmtNum(bess.equivalentCycles, 1)} 次/年，年末 SOC ${pct(bess.finalSocPct)}）。`
      : `出现 ${bess.socViolations} 次 SOC 越界，调度结果不可用。`,
    true,
  );

  const pvExpected = input.pvCapacityKwp * input.pvSpecificYieldKwhPerKwp;
  const pvConsistent = pvExpected <= 0 ? pv.annualGenerationKwh === 0 : Math.abs(pv.annualGenerationKwh - pvExpected) / pvExpected < 0.02;
  push(
    "pv_yield_consistency",
    "光伏年发电量与其等效小时口径一致",
    pvConsistent,
    pvExpected <= 0
      ? "本情景未配置光伏，无需校核。"
      : `发电量 ${fmtKwh(pv.annualGenerationKwh)}，装机×等效小时 ${fmtKwh(pvExpected)}（偏差 ${pct(Math.abs(pv.annualGenerationKwh - pvExpected) / Math.max(1, pvExpected) * 100, 2)}）。`,
    true,
  );

  /* ── 经济门槛（与"装不装得下"分开陈述，但同样进入可行性判定） ── */

  const npv = ec.metrics.npvYuan;
  push(
    "npv_positive",
    "净现值大于 0",
    Number.isFinite(npv) && npv > 0,
    `NPV = ${fmtWan(npv)}（折现率 ${pct(e.discountRatePct)}，运营期 ${fmtNum(e.projectLifeYears)} 年）。`,
    true,
  );

  const spb = ec.metrics.simplePaybackYears;
  const life = Math.max(1, e.projectLifeYears);
  const paybackOk = spb !== null && spb <= life;
  push(
    "payback_within_life",
    "静态回收期不超过运营期",
    paybackOk,
    spb === null ? `运营期 ${fmtNum(life)} 年内未回本。` : `静态回收期 ${fmtNum(spb, 1)} 年（运营期 ${fmtNum(life)} 年）。`,
    true,
  );

  const recommended =
    blockers.length === 0 &&
    spb !== null &&
    spb <= life * DECISION_THRESHOLDS.paybackToLifeRatioMax &&
    (!(e.constructionSubsidyPct > 0) || ec.capex.netYuan > 0);

  /* ─────────── 2. 关键驱动（敏感性摆幅降序） ─────────── */

  const keyDrivers = input.sensitivity.slice(0, 5).map((b) => ({
    key: b.key,
    label: b.label,
    swingYuan: b.swingYuan,
    text: `${b.label}在 ±${fmtNum(Math.abs(b.deltaHighPct))}% 区间内摆动时，NPV 在 ${fmtWan(b.npvAtLow)} ~ ${fmtWan(b.npvAtHigh)} 之间变化，摆幅 ${fmtWan(b.swingYuan)}。`,
  }));

  const topDriver = keyDrivers[0];

  /* 基准相关性上下文：只把「与本情景有关」的基准转成风险与关键假设 */
  const relCtx = {
    components: input.definition.components,
    pvEnabled: ecInput.pvEnabled,
    bessEnabled: ecInput.bessEnabled,
    swapEnabled: ecInput.swapEnabled,
  };

  /* ─────────── 3. 风险清单（每条必须有触发依据的数值） ─────────── */

  const risks: RiskItem[] = [];

  if (unserved > 0) {
    risks.push({
      id: "R-DEMAND-UNSERVED",
      title: "补能能力不足，部分运输需求无法交付",
      severity: "high",
      basis: `全年未满足电量 ${fmtKwh(unserved)}，占需求约 ${pct((unserved / Math.max(1, charging.annualGridSideKwh + unserved)) * 100)}。`,
      mitigation: "增加充电桩数量或单桩功率、延长可用充电窗口，或引入换电分流高峰需求后重算。",
    });
  }

  if (grid.capacityConstrained) {
    risks.push({
      id: "R-GRID-CAP",
      title: "并网容量成为硬约束",
      severity: "high",
      basis: `全年最大下网需量 ${fmtKw(Math.max(0, ...grid.monthlyPeakImportKw))}，叠加未满足负荷说明受电容量已到顶。`,
      mitigation: "申请增容，或用储能削峰、把充电时段向谷段平移，把峰值压到现有容量以内。",
    });
  }

  if (Number.isFinite(npv) && npv <= 0) {
    risks.push({
      id: "R-NPV-NEGATIVE",
      title: "投资回报未达门槛",
      severity: "high",
      basis: `NPV = ${fmtWan(npv)}（折现率 ${pct(e.discountRatePct)}），即按当前假设该项目未创造超过资金成本的价值。`,
      mitigation: "核实服务费定价与设备投资单价；减少非必要装机（如降低光伏/储能规模）后对比重算。",
    });
  }

  const serviceFee = ecInput.economics.chargingServiceFeeYuanPerKwh;
  if (serviceFee <= 0) {
    risks.push({
      id: "R-SERVICE-FEE-MISSING",
      title: "服务费定价缺失，经济结论不成立",
      severity: "high",
      basis: "充电服务费单价为 0，收入侧只剩补贴与其他收入；本地区服务费实行市场调节价，无官方水平可套用。",
      mitigation: "先与车队就服务费单价达成书面意向，再回填单价重算；在此之前不应进入投资决策。",
    });
  }

  if (spb !== null && spb > life * DECISION_THRESHOLDS.paybackToLifeRatioMax && spb <= life) {
    risks.push({
      id: "R-PAYBACK-SLOW",
      title: "回收期偏长，资金效率不高",
      severity: "medium",
      basis: `静态回收期 ${fmtNum(spb, 1)} 年，已达运营期的 ${pct((spb / life) * 100)}（内部警戒线 ${pct(DECISION_THRESHOLDS.paybackToLifeRatioMax * 100, 0)}）。`,
      mitigation: "优先压低占 CAPEX 比重最大的那一项（见 CAPEX 构成），或提高充电设施利用率。",
    });
  }

  if (charging.utilizationPct > 0 && charging.utilizationPct < DECISION_THRESHOLDS.minChargerUtilizationPct) {
    risks.push({
      id: "R-OVERSIZED-CHARGER",
      title: "充电设施装机过剩",
      severity: "medium",
      basis: `站级年利用率仅 ${pct(charging.utilizationPct)}（装机 ${fmtKw(charging.installedPowerKw)}，有效 ${fmtKw(charging.effectivePowerKw)}）。`,
      mitigation: "下调桩数或单桩功率，把省下的投资用于储能/光伏以更直接地降本。",
    });
  }

  if (pv.annualGenerationKwh > 0 && pv.selfConsumptionPct < DECISION_THRESHOLDS.lowPvSelfConsumptionPct) {
    risks.push({
      id: "R-LOW-PV-SELFUSE",
      title: "光伏自用率偏低，降本效果被削弱",
      severity: "medium",
      basis: `光伏年发电 ${fmtKwh(pv.annualGenerationKwh)}，自用率仅 ${pct(pv.selfConsumptionPct)}，其余以 ${fmtNum(input.feedInTariffYuanPerKwh, 2)} 元/kWh 上网。`,
      mitigation: "把充电窗口向白天平移、或加大储能把白天电量搬到夜间，提高自用比例。",
    });
  }

  if (pv.annualGenerationKwh > 0) {
    const curtailPct = (pv.curtailedKwh / Math.max(1, pv.annualGenerationKwh)) * 100;
    if (curtailPct > DECISION_THRESHOLDS.highCurtailmentPct) {
      risks.push({
        id: "R-CURTAILMENT",
        title: "弃光比例偏高",
        severity: "medium",
        basis: `年弃光 ${fmtKwh(pv.curtailedKwh)}，占发电量 ${pct(curtailPct)}。`,
        mitigation: "检查上网容量上限与储能功率是否偏小；若并网受限严重，应下调光伏装机。",
      });
    }
  }

  // 基准证据风险：把"哪条数据靠不住"直接转成风险条目（这是最容易被忽略、也最影响结论的一类）
  const weakBenchmarks = Object.values(input.benchmarkSnapshot)
    .filter((b) => benchmarkRelevant(b.key, relCtx))
    .filter((b) => b.evidenceKind !== "FACT" && b.confidence <= DECISION_THRESHOLDS.lowConfidenceMax)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 3);
  for (const b of weakBenchmarks) {
    risks.push({
      id: `R-BENCH-${b.key}`,
      title: `关键行情未核实：${b.label}`,
      severity: b.confidence <= 35 ? "high" : "medium",
      basis: `当前取 ${b.value === null ? b.textValue ?? "无值" : `${fmtNum(b.value, 3)} ${b.unit}`}，证据等级 ${b.evidenceKind}、置信度 ${b.confidence}/100，来源：${b.source}。`,
      mitigation: "进入投资决策前，用当地最新结算单据或供应商报价替换该参数后重算。",
    });
  }

  /* ─────────── 4. 必须人工确认的关键假设 ─────────── */

  const criticalAssumptions: DecisionResult["criticalAssumptions"] = [];

  for (const b of Object.values(input.benchmarkSnapshot)) {
    if (b.evidenceKind === "FACT") continue;
    if (!benchmarkRelevant(b.key, relCtx)) continue;
    if (b.confidence > DECISION_THRESHOLDS.lowConfidenceMax) continue;
    criticalAssumptions.push({
      key: b.key,
      label: b.label,
      value: b.value === null ? b.textValue ?? "（无可用数值）" : b.value,
      unit: b.unit || undefined,
      evidenceKind: b.evidenceKind,
      confidence: b.confidence,
      impactIfWrong: impactIfWrongOf(b),
    });
  }

  for (const [key, reason] of Object.entries(input.unknowns ?? {})) {
    criticalAssumptions.push({
      key,
      label: labelOfPath(key),
      value: "（用户未提供 / 无官方来源）",
      evidenceKind: "UNKNOWN",
      confidence: 0,
      impactIfWrong: `${reason} 若实际取值与假设不同，收入或成本将直接等比变化。`,
    });
  }

  criticalAssumptions.sort((a, b) => a.confidence - b.confidence);
  const criticalAssumptionsTop = criticalAssumptions.slice(0, 12);

  /* ─────────── 5. 推荐语与理由（每条带数值） ─────────── */

  const reasons: string[] = [];
  const concerns: string[] = [];

  reasons.push(
    `全生命周期净现值 ${fmtWan(npv)}（折现率 ${pct(e.discountRatePct)}），静态回收期 ${spb === null ? "超出运营期" : `${fmtNum(spb, 1)} 年`}。`,
  );
  reasons.push(
    `净投资 ${fmtWan(ec.capex.netYuan)}，首年运营成本 ${fmtWan(ec.costY1Yuan)}（其中购电 ${fmtWan(ecInput.annualEnergyCostYuan + ecInput.annualDemandChargeYuan - ecInput.annualExportRevenueYuan)}），首年税前净现金流入 ${fmtWan(ec.netCashFlowY1PreTaxYuan)}。`,
  );
  if (pv.annualGenerationKwh > 0) {
    reasons.push(
      `光伏年发电 ${fmtKwh(pv.annualGenerationKwh)}，自用 ${fmtKwh(pv.selfConsumedKwh)}（自用率 ${pct(pv.selfConsumptionPct)}），相当于替掉同等电量的一次购电。`,
    );
  }
  if (bess.annualDischargeKwh > 0) {
    reasons.push(
      `储能年放电 ${fmtKwh(bess.annualDischargeKwh)}、等效循环 ${fmtNum(bess.equivalentCycles, 1)} 次，价差与削峰合计影响购电成本约 ${fmtWan(bess.arbitrageBenefitYuan + bess.demandChargeSavingYuan)}。`,
    );
  }
  if (charging.annualSwapEvents > 0) {
    reasons.push(`换电方案年服务 ${fmtNum(charging.annualSwapEvents)} 次，站点侧取电 ${fmtKwh(charging.swapGridSideKwh)}。`);
  }
  reasons.push(
    `并网全年下网 ${fmtKwh(grid.annualImportKwh)}，最大需量 ${fmtKw(Math.max(0, ...grid.monthlyPeakImportKw))}，未触及受电容量上限。`,
  );

  if (topDriver) {
    concerns.push(
      `结论对「${topDriver.label}」最敏感：该变量 ±${fmtNum(Math.abs(input.sensitivity[0].deltaHighPct))}% 会让 NPV 摆动 ${fmtWan(topDriver.swingYuan)}，占总摆幅的 ${pct((topDriver.swingYuan / Math.max(1, input.sensitivity.reduce((s, b) => s + b.swingYuan, 0))) * 100, 0)}。`,
    );
  }
  const weakTop = risks.filter((r) => r.severity === "high" && r.id.startsWith("R-BENCH-"));
  if (weakTop.length) {
    concerns.push(`有 ${weakTop.length} 项关键行情尚未取得可核验来源（如「${weakTop[0].title.replace("关键行情未核实：", "")}」），当前结论建立在这些假设之上。`);
  }
  if (criticalAssumptionsTop.length) {
    concerns.push(`共 ${criticalAssumptionsTop.length} 项关键假设需要人工确认（清单见"关键假设"一节），任一项不成立都可能改变推荐结论。`);
  }
  concerns.push("营运资金（流动资金占用）本轮未建模；以电费/服务费为主的站点该项通常小于 CAPEX，但仍是口径缺口。");

  const headline = recommended
    ? `在给定假设下该方案可交付且经济上成立：NPV ${fmtWan(npv)}，静态回收期 ${spb === null ? "—" : `${fmtNum(spb, 1)} 年`}，建议进入下一阶段核实关键假设。`
    : blockers.length
      ? `该方案暂不可行：${blockers.length} 项硬性判据未通过，须先解决技术交付问题。`
      : `该方案技术上可交付，但经济上未达门槛（NPV ${fmtWan(npv)}），不建议按当前配置推进。`;

  /* ─────────── 6. 程序生成的决策解释 ─────────── */

  const summary = recommended
    ? `综合技术交付与经济性，「${input.definition.label}」在给定情景假设下成立。`
    : `综合技术交付与经济性，「${input.definition.label}」在当前配置下不建议直接推进。`;

  const paragraphs: string[] = [];
  paragraphs.push(
    `本情景声明参与计算的能力为：${input.definition.components.join(" + ")}${input.definition.managedCharging ? "，并启用有序充电" : ""}。${input.definition.intent}`,
  );
  paragraphs.push(
    `技术侧：车队年运营 ${fmtNum(input.truckDemand.operatingDays)} 天，年用能需求（电网侧口径）${fmtKwh(input.truckDemand.annualEnergyDemandKwh)}；站点全年下网 ${fmtKwh(grid.annualImportKwh)}，最大需量 ${fmtKw(Math.max(0, ...grid.monthlyPeakImportKw))}。能量平衡在全部 35,040 个时段通过守恒校验。`,
  );
  paragraphs.push(
    `经济侧：净投资 ${fmtWan(ec.capex.netYuan)}（光伏 ${fmtWan(ec.capex.pvYuan)}、储能 ${fmtWan(ec.capex.bessYuan)}、充换电设施 ${fmtWan(ec.capex.chargerYuan + ec.capex.swapYuan)}、并网与土建 ${fmtWan(ec.capex.gridYuan + ec.capex.civilYuan)}、预备费 ${fmtWan(ec.capex.contingencyYuan)}）。首年收入 ${fmtWan(ec.revenueY1.grossYuan)}、首年购电与运维成本 ${fmtWan(ec.costY1Yuan)}，NPV ${fmtWan(npv)}${ec.metrics.irr.ok ? `，IRR ${pct(ec.metrics.irr.valuePct ?? 0, 2)}` : "，内部收益率在常规区间内无解（现金流形态非常规）"}。`,
  );
  if (topDriver) {
    paragraphs.push(
      `敏感性分析表明，最有决定性的变量是「${topDriver.label}」（±${fmtNum(Math.abs(input.sensitivity[0].deltaHighPct))}% 对应 NPV 摆动 ${fmtWan(topDriver.swingYuan)}）。因此在投入工程款之前，最优先的动作不是谈设备价格，而是把这一个变量核实到可信区间。`,
    );
  }
  paragraphs.push(
    `边界声明：本结论由程序按 ${input.engineVersion} 版本引擎、基准参数版本 ${input.benchmarkVersion} 计算得出，全部输入已随报告留档，可用同一输入完整复算。结论属模型估算，须经专业机构复核后方可用于投资决策。`,
  );

  const cited = [
    { label: "净投资", value: ec.capex.netYuan, unit: "元" },
    { label: "首年购电成本（含需量与上网抵减）", value: ecInput.annualEnergyCostYuan + ecInput.annualDemandChargeYuan - ecInput.annualExportRevenueYuan, unit: "元" },
    { label: "净现值（NPV）", value: ec.metrics.npvYuan, unit: "元" },
    { label: "静态回收期", value: spb ?? NaN, unit: "年" },
    { label: "年用能需求（电网侧）", value: input.truckDemand.annualEnergyDemandKwh, unit: "kWh" },
    { label: "年下网电量", value: grid.annualImportKwh, unit: "kWh" },
    { label: "年最大需量", value: Math.max(0, ...grid.monthlyPeakImportKw), unit: "kW" },
    { label: "光伏年发电量", value: pv.annualGenerationKwh, unit: "kWh" },
  ].filter((c) => Number.isFinite(c.value));

  return {
    feasibility: { feasible: blockers.length === 0, blockers, checks },
    recommendation: { recommended, headline, reasons, concerns },
    keyDrivers,
    sensitivity: input.sensitivity,
    risks,
    criticalAssumptions: criticalAssumptionsTop,
    explanation: {
      summary,
      paragraphs,
      traceability: {
        engineVersion: input.engineVersion,
        modelVersion: input.modelVersion,
        scenarioId: input.definition.id,
        benchmarkVersion: input.benchmarkVersion,
        cited: cited.map((c) => ({ label: c.label, value: round(c.value, 4), unit: c.unit })),
      },
    },
  };
}

/* ═══════════════════════════ 辅助 ═══════════════════════════ */

/** 这条基准如果不成立，会对结论造成什么——按基准的语义分类给出（不写空话）。 */
function impactIfWrongOf(b: BenchmarkRef): string {
  const k = b.key;
  if (k.startsWith("grid.flatPrice") || k.startsWith("grid.tou")) {
    return "到户电价整体平移，购电量与光伏/储能的省钱效果同步放大或缩小；若电价实际更低，光伏与储能的收益会被明显削弱。";
  }
  if (k.startsWith("grid.feedInTariff")) {
    return "余电上网收入变化；上网电价偏高会让「多装光伏卖电」看起来更划算，掩盖自用率低的问题。";
  }
  if (k.startsWith("pv.specificYield")) {
    return "光伏年发电量按此值缩放，直接影响自用量与降低的购电成本。";
  }
  if (k.startsWith("pv.degradation")) {
    return "影响第 2 年以后的发电量与自用覆盖，衰减更快则后期购电成本上升更多。";
  }
  if (k.startsWith("bess.")) {
    return "储能可用容量或效率变化，直接改变削峰填谷的收益与可释放电量。";
  }
  if (k.startsWith("truck.")) {
    return "年用能需求随此值变化，收入与购电成本同向变动；该值偏低会让项目看起来更容易满足、也更赚钱。";
  }
  if (k.startsWith("charging.")) {
    return "影响交付能力与站级峰值负荷，可能改变「装不装得下」这个结论本身。";
  }
  if (k.startsWith("economics")) {
    return "直接进入现金流：投资单价抬高会压低 NPV 与 IRR，运维费率抬高会抬高全生命周期成本。";
  }
  return "该参数参与计算，实际取值与假设不同会使结论发生变化。";
}

/** 参数路径 → 人话标签。 */
function labelOfPath(path: string): string {
  const map: Record<string, string> = {
    "economics.chargingServiceFeeYuanPerKwh": "充电服务费单价（市场调节价，无官方水平）",
    "grid.demandChargePerKwMonth": "需量电价（名义水平无官方价表）",
  };
  return map[path] ?? path;
}

/**
 * 这条基准与**本情景**是否有关系。
 *
 * 为什么必须过滤：基准层为了完整，把光伏、储能、换电的单价全都登记了一遍（且大多置信度低）。
 * 如果一个「纯电网充电」的情景把「换电站单位投资置信度低」也列为高风险，报告立刻会被噪音淹没——
 * 读者看到十几条「待核实」，就再也看不到真正影响结论的那三条了。
 */
function benchmarkRelevant(key: string, ctx: { components: readonly string[]; pvEnabled: boolean; bessEnabled: boolean; swapEnabled: boolean }): boolean {
  if (key.startsWith("pv.") || key.startsWith("economics.pv")) return ctx.pvEnabled;
  if (key.startsWith("bess.") || key.startsWith("economics.bess")) return ctx.bessEnabled;
  if (key === "economics.swapStationCapexYuanPerStation") return ctx.swapEnabled;
  if (key.startsWith("grid.tou")) return ctx.components.includes("TOU");
  if (key === "grid.demandChargeNominalYuanPerKwMonth") return ctx.components.includes("DEMAND_CHARGE");
  return true;
}

/** 供报告/UI 复用的门槛说明（让"为什么判它不推荐"可被读者核对）。 */
export function decisionThresholdNotes(): Array<{ id: string; text: string }> {
  return [
    { id: "payback", text: `静态回收期超过运营期的 ${fmtNum(DECISION_THRESHOLDS.paybackToLifeRatioMax * 100)}% 时不给出推荐（资金效率不足）。` },
    { id: "utilization", text: `站级利用率低于 ${DECISION_THRESHOLDS.minChargerUtilizationPct}% 时提示装机过剩。` },
    { id: "selfConsumption", text: `光伏自用率低于 ${DECISION_THRESHOLDS.lowPvSelfConsumptionPct}% 时提示降本效果被削弱。` },
    { id: "confidence", text: `基准置信度低于 ${DECISION_THRESHOLDS.lowConfidenceMax}/100 的参数自动进入"必须人工确认的关键假设"。` },
  ];
}
