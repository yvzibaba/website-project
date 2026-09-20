/**
 * 项目经济性（Economics）—— 把"物理量"翻译成"钱"，并给出可审计的评价指标。
 *
 * ## 本模块的唯一立场：**不重新发明财务数学**
 *
 * NPV / IRR / 回收期 / ROI 的公式全部复用 `kernel/server/finance.ts`（该文件已有黄金样本测死）。
 * 本模块只做三件事：
 *   ① 把 CAPEX / OPEX / 收入**按域名拆开列清**（哪笔钱是光伏的、哪笔是储能的）；
 *   ② 把物理量（年发电量、年充电量、年下网电量）乘上单价；
 *   ③ 组装逐年现金流（含通胀、折旧、利息、所得税、残值），交给财务原语求指标。
 *
 * 在这里重写一遍 IRR 二分法是**严禁**的：多一份公式 = 多一份将来会分叉的真源。
 *
 * ## 口径（必须一句话说清"这块钱算了没有"）
 *
 * - **购电成本**是运营方的支出，**充电服务费**是运营方向车队收取的收入——两者**互不抵扣**，
 *   合起来才是"卖电+服务的毛利"。光伏自发自用之所以赚钱，正是因为它**减少了下网电量**，
 *   从而压低了购电成本（已经体现在 `annualEnergyCostYuan` 里），而不是另外记一笔收入。
 *   这一点若弄错，就会把同一块钱算两遍。
 * - **上网收入**是购电成本的**抵减项**（卖电给电网），不是独立收入行。
 * - **储能套利收益**同样是"少花的购电成本"，不是收入。它在本模块中的唯一用途是：
 *   随电池衰减而逐年缩水（`lostArbitrage`），从而让"第 8 年还剩多少收益"变得可见。
 * - **CAPEX 减补贴**得到净投资；**折旧基数为净投资扣残值**，直线折旧，不留残值悬念。
 * - 流动资金（营运资本）本轮**未建模**——对"以电费/服务费为主"的项目，它显著小于 CAPEX，
 *   但这是一个**已知的口径缺口**，报告须如实标注，不得当成已计入。
 *
 * ## 敏感性的诚实边界
 *
 * 敏感性扰动**只作用于经济层**（假设物理调度不变，把能量与成本按比例缩放）。
 * 为什么这样做：完整重算需要重跑 35040 步的调度，会让"点一下看摇摆幅度"变成秒级卡顿；
 * 而这个近似的**方向与量级**对决策足够，且此处明说了它的口径——不假装它是全模型重算。
 */

import {
  discountedPaybackYears,
  irr,
  npv,
  roiPct,
  round,
  simplePaybackYears,
} from "@app/kernel/server/finance";
import type {
  Diagnostic,
  EconomicsInput,
  EconomicsResult,
  SensitivityBar,
} from "@app/kernel/engine/types";

/** 经济模型版本（改成本口径/现金流结构须升版）。 */
export const ECONOMICS_MODEL_VERSION = "1.0.0";
export function economicsModelCalcRef(): string {
  return `economics@${ECONOMICS_MODEL_VERSION}`;
}

/* ═══════════════════════════ 输入 ═══════════════════════════ */

export interface EconomicsComputationInput {
  /** 情景层的投资与财务假设。 */
  economics: EconomicsInput;

  /* ── 设施规模（DERIVED，来自各技术模块） ── */
  pvCapacityKwp: number;
  bessPowerKw: number;
  bessEnergyKwh: number;
  /** 充电设施装机（kW）。 */
  chargerInstalledKw: number;
  swapStationCount: number;
  gridCapacityKw: number;

  /* ── 年电量（DERIVED，kWh） ── */
  /** 年交付到车的充电量（电池侧）——服务费计费口径。 */
  annualChargingDeliveredKwh: number;
  /** 年交付到车的换电量（电池侧）。 */
  annualSwapDeliveredKwh: number;
  /** 站点年总负荷（电网侧，含损失）。 */
  annualLoadKwh: number;
  /** 年下网电量（电网侧）。 */
  annualNetImportKwh: number;
  /** 光伏年发电量（交流侧）。 */
  annualPvGenerationKwh: number;
  /** 光伏年自发自用量。 */
  annualPvSelfConsumedKwh: number;

  /* ── 年成本分解（DERIVED，元） ── */
  annualEnergyCostYuan: number;
  annualDemandChargeYuan: number;
  annualExportRevenueYuan: number;
  /** 平段基准电价（元/kWh）——用于展示与敏感性扰动（该参数属电网输入，不在 EconomicsInput 上）。 */
  gridFlatPriceYuanPerKwh: number;
  /** 加权平均到户电价（元/kWh；null = 全年无下网）。 */
  weightedAveragePriceYuanPerKwh: number | null;
  /** 储能年套利收益（元）——已体现在购电成本中，此处仅用于衰减建模。 */
  annualBessArbitrageBenefitYuan: number;

  /* ── 衰减（来自技术模块的输入，非本层臆造） ── */
  pvDegradationPctPerYear: number;
  bessDegradationPctPerYear: number;

  /* ── 工程口径 ── */
  /** 预备费率（% of 直接工程投资）——基准层参数，本层不内置默认值。 */
  contingencyPct: number;

  /* ── 情景组件（决定哪些投资被计入） ── */
  pvEnabled: boolean;
  bessEnabled: boolean;
  swapEnabled: boolean;
}

export interface EconomicsComputation {
  result: EconomicsResult;
  diagnostics: Diagnostic[];
  /** 计算明细（供报告/敏感性复核，避免各处重算）。 */
  details: {
    /** 年折旧（元）。 */
    annualDepreciationYuan: number;
    /** 贷款金额 / 资本金（元）。 */
    loanAmountYuan: number;
    equityAmountYuan: number;
    /** 首年利息 / 首年还本（元）。 */
    annualLoanInterestY1Yuan: number;
    annualLoanPrincipalY1Yuan: number;
    /** 期末残值（元）。 */
    residualValueYuan: number;
    /** 首年应税所得 / 所得税（元）。 */
    taxableIncomeY1Yuan: number;
    incomeTaxY1Yuan: number;
    /** LCOE 分子（元现值）/ 分母（kWh 现值）。 */
    lcoeNumeratorYuan: number;
    lcoeDenominatorKwh: number;
  };
}

/* ═══════════════════════════ 小工具 ═══════════════════════════ */

/** 非有限值归零（避免一行 NaN 污染整条现金流）。 */
function nz(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** 百分比裁剪到 [0,100]。 */
function clampPct(v: number): number {
  const x = nz(v);
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

interface LoanSchedule {
  interest: number[];
  principal: number[];
}

/** 等额本息还款计划（rate=0 时退化为等额本金）。只填前 `years` 年。 */
function buildLoanSchedule(principal: number, rate: number, term: number, years: number): LoanSchedule {
  const interest = new Array<number>(Math.max(0, years)).fill(0);
  const princ = new Array<number>(Math.max(0, years)).fill(0);
  if (!(principal > 0) || !(term > 0) || years <= 0) return { interest, principal: princ };

  const n = Math.min(term, years);
  if (rate > 0) {
    const annuity = (principal * rate) / (1 - (1 + rate) ** -term);
    let balance = principal;
    for (let t = 0; t < n; t++) {
      const int = balance * rate;
      let p = annuity - int;
      if (p > balance) p = balance;
      if (p < 0) p = 0;
      interest[t] = int;
      princ[t] = p;
      balance -= p;
    }
  } else {
    const p = principal / term;
    for (let t = 0; t < n; t++) princ[t] = p;
  }
  return { interest, principal: princ };
}

/* ═══════════════════════════ 主计算 ═══════════════════════════ */

export function computeEconomics(input: EconomicsComputationInput): EconomicsComputation {
  const e = input.economics;
  const diagnostics: Diagnostic[] = [];

  /* ── 1. 规模归零（组件未启用 = 不计投资，而不是"投了但不用"） ── */
  const pvCapacityKwp = input.pvEnabled ? Math.max(0, nz(input.pvCapacityKwp)) : 0;
  const bessEnergyKwh = input.bessEnabled ? Math.max(0, nz(input.bessEnergyKwh)) : 0;
  const chargerInstalledKw = Math.max(0, nz(input.chargerInstalledKw));
  const swapStationCount = input.swapEnabled ? Math.max(0, nz(input.swapStationCount)) : 0;
  const gridCapacityKw = Math.max(0, nz(input.gridCapacityKw));

  /* ── 2. CAPEX（直接工程投资 → 预备费 → 补贴 → 净投资） ── */
  const pvYuan = pvCapacityKwp * 1000 * nz(e.pvCapexYuanPerW);
  const bessYuan = bessEnergyKwh * 1000 * nz(e.bessCapexYuanPerWh);
  const chargerYuan = chargerInstalledKw * nz(e.chargerCapexYuanPerKw);
  const swapYuan = swapStationCount * nz(e.swapStationCapexYuanPerStation);
  const gridYuan = gridCapacityKw * nz(e.gridCapexYuanPerKw);
  const civilYuan = chargerInstalledKw * nz(e.civilCapexYuanPerChargerKw);
  const directYuan = pvYuan + bessYuan + chargerYuan + swapYuan + gridYuan + civilYuan;
  const contingencyYuan = directYuan * (Math.max(0, nz(input.contingencyPct)) / 100);
  const grossYuan = directYuan + contingencyYuan;
  const subsidyYuan = grossYuan * (clampPct(e.constructionSubsidyPct) / 100);
  const netYuan = grossYuan - subsidyYuan;

  const capex: EconomicsResult["capex"] = {
    pvYuan: round(pvYuan),
    bessYuan: round(bessYuan),
    chargerYuan: round(chargerYuan),
    swapYuan: round(swapYuan),
    gridYuan: round(gridYuan),
    civilYuan: round(civilYuan),
    contingencyYuan: round(contingencyYuan),
    grossYuan: round(grossYuan),
    subsidyYuan: round(subsidyYuan),
    netYuan: round(netYuan),
  };

  /* ── 3. OPEX（首年） ── */
  const opexPvYuan = pvCapacityKwp * nz(e.pvOpexYuanPerKwpYear);
  const opexBessYuan = bessEnergyKwh * nz(e.bessOpexYuanPerKwhYear);
  const opexChargerYuan = chargerInstalledKw * nz(e.chargerOpexYuanPerKwYear);
  const opexSiteYuan = nz(e.siteFixedOpexYuanPerYear);
  const opexLandYuan = nz(e.landRentYuanPerYear);
  const opexInsuranceYuan = grossYuan * (clampPct(e.insurancePctOfCapex) / 100);
  const opexGrossYuan =
    opexPvYuan + opexBessYuan + opexChargerYuan + opexSiteYuan + opexLandYuan + opexInsuranceYuan;

  const opexY1: EconomicsResult["opexY1"] = {
    pvYuan: round(opexPvYuan),
    bessYuan: round(opexBessYuan),
    chargerYuan: round(opexChargerYuan),
    siteFixedYuan: round(opexSiteYuan),
    landYuan: round(opexLandYuan),
    insuranceYuan: round(opexInsuranceYuan),
    grossYuan: round(opexGrossYuan),
  };

  /* ── 4. 收入（首年） ── */
  const chargingDeliveredKwh = Math.max(0, nz(input.annualChargingDeliveredKwh));
  const swapDeliveredKwh = Math.max(0, nz(input.annualSwapDeliveredKwh));
  const deliveredY1 = chargingDeliveredKwh + swapDeliveredKwh;

  const chargingServiceYuan = chargingDeliveredKwh * nz(e.chargingServiceFeeYuanPerKwh);
  const swapServiceYuan = swapDeliveredKwh * nz(e.swapServiceFeeYuanPerKwh);

  // 转供电费：填 0 表示"平价转供"——按运营方自己的加权平均到户电价代收，不赚电费差价。
  const resalePriceRaw = nz(e.electricityResalePriceYuanPerKwh);
  const resalePriceYuanPerKwh =
    resalePriceRaw > 0 ? resalePriceRaw : Math.max(0, nz(input.weightedAveragePriceYuanPerKwh ?? 0));
  const electricityResaleYuan = deliveredY1 * resalePriceYuanPerKwh;

  const operationSubsidyYuan = deliveredY1 * nz(e.operationSubsidyYuanPerKwh);
  const otherYuan = nz(e.otherRevenueYuanPerYear);
  const revenueGrossYuan =
    chargingServiceYuan + swapServiceYuan + electricityResaleYuan + operationSubsidyYuan + otherYuan;

  const revenueY1: EconomicsResult["revenueY1"] = {
    chargingServiceYuan: round(chargingServiceYuan),
    swapServiceYuan: round(swapServiceYuan),
    electricityResaleYuan: round(electricityResaleYuan),
    operationSubsidyYuan: round(operationSubsidyYuan),
    otherYuan: round(otherYuan),
    grossYuan: round(revenueGrossYuan),
  };

  /* ── 5. 首年成本与税前净现金流 ── */
  const energyCostY1 = nz(input.annualEnergyCostYuan);
  const demandChargeY1 = nz(input.annualDemandChargeYuan);
  const exportRevenueY1 = nz(input.annualExportRevenueYuan);
  const gridCostY1 = energyCostY1 + demandChargeY1 - exportRevenueY1;

  const costY1Yuan = gridCostY1 + opexGrossYuan;
  const netCashFlowY1PreTaxYuan = revenueGrossYuan - costY1Yuan;

  /* ── 6. 折旧 / 贷款 / 残值 ── */
  const constructionYears = Math.max(1, Math.round(nz(e.constructionYears) || 1));
  const lifeYears = Math.max(1, Math.round(nz(e.projectLifeYears) || 1));
  const discountRate = nz(e.discountRatePct) / 100;
  const inflation = nz(e.inflationPct) / 100;
  const taxRate = clampPct(e.incomeTaxPct) / 100;

  const residualValueYuan = netYuan * (clampPct(e.residualValuePct) / 100);
  const depreciableBase = Math.max(0, netYuan - residualValueYuan);
  const annualDepreciationYuan = depreciableBase / lifeYears;

  const equityRatio = clampPct(e.equityRatioPct) / 100;
  const equityAmountYuan = netYuan * equityRatio;
  const loanAmountYuan = netYuan - equityAmountYuan;
  const loanTermYears = Math.max(0, Math.round(nz(e.loanTermYears)));
  const loan = buildLoanSchedule(loanAmountYuan, nz(e.loanInterestPct) / 100, loanTermYears, lifeYears);

  /* ── 7. 逐年现金流：**两条口径分别构建**，绝不混用 ──
   *
   *  全投资（项目）口径：期初 = −净投资，年度 = EBIT×(1−税率) + 折旧，**不含利息与还本**。
   *  资本金（股东）口径：期初 = −资本金，年度 = 净利润 + 折旧 − 还本，**含利息与还本**。
   *
   * 把两者混在一起（例如"期初扣全部投资、年度又扣还本付息"）会把同一笔钱扣两次，
   * 让一个正常赚钱的项目在模型里永远回不了本——这是投资测算里最常见也最伤人的一个错。 */
  const pvDegRate = Math.min(1, Math.max(0, nz(input.pvDegradationPctPerYear) / 100));
  const bessDegRate = Math.min(1, Math.max(0, nz(input.bessDegradationPctPerYear) / 100));
  const wap = input.weightedAveragePriceYuanPerKwh;
  const pvSelfConsumedY1 = Math.max(0, nz(input.annualPvSelfConsumedKwh));
  const arbitrageY1 = Math.max(0, nz(input.annualBessArbitrageBenefitYuan));

  const projectFlows: number[] = [];
  const equityFlows: number[] = [];
  for (let t = 0; t < constructionYears; t++) {
    projectFlows.push(-netYuan / constructionYears);
    equityFlows.push(-equityAmountYuan / constructionYears);
  }

  let lcoeNumeratorYuan = netYuan;
  let lcoeDenominatorKwh = 0;
  let taxableIncomeY1Yuan = 0;
  let incomeTaxY1Yuan = 0;

  for (let k = 0; k < lifeYears; k++) {
    const inflMult = (1 + inflation) ** k;
    const disc = (1 + discountRate) ** (k + constructionYears);

    // 光伏衰减 → 自用覆盖减少 → 必须多从电网买电（按加权平均到户电价计价）
    const lostPvCoverage = pvSelfConsumedY1 * (1 - (1 - pvDegRate) ** k);
    const extraPurchase = wap === null ? 0 : lostPvCoverage * wap;
    // 储能衰减 → 套利（少花的钱）缩水
    const lostArbitrage = arbitrageY1 * (1 - (1 - bessDegRate) ** k);

    const gridCostK =
      (energyCostY1 + demandChargeY1 - exportRevenueY1) * inflMult + (extraPurchase + lostArbitrage) * inflMult;
    const opexK = opexGrossYuan * inflMult;
    const revenueK = revenueGrossYuan * inflMult;

    const interestK = loan.interest[k] ?? 0;
    const principalK = loan.principal[k] ?? 0;

    const ebit = revenueK - opexK - gridCostK - annualDepreciationYuan;

    /* 全投资口径：无融资，所得税基数为 EBIT */
    const taxProject = Math.max(0, ebit) * taxRate;
    let cfProject = ebit - taxProject + annualDepreciationYuan;

    /* 资本金口径：所得税基数为 EBIT − 利息 */
    const ebtEquity = ebit - interestK;
    const taxEquity = Math.max(0, ebtEquity) * taxRate;
    let cfEquity = ebtEquity - taxEquity + annualDepreciationYuan - principalK;

    if (k === lifeYears - 1) {
      cfProject += residualValueYuan;
      cfEquity += residualValueYuan;
    }

    projectFlows.push(cfProject);
    equityFlows.push(cfEquity);

    if (k === 0) {
      taxableIncomeY1Yuan = ebtEquity;
      incomeTaxY1Yuan = taxEquity;
    }

    // LCOE 为**自有成本口径**：只含自有投资与运维，不含过手电费
    lcoeNumeratorYuan += opexK / disc;
    lcoeDenominatorKwh += deliveredY1 / disc;
  }

  /* ── 7.5 口径归一：先把年度现金流量化到「分」，再据此算全部指标与累计值 ──
   * 留档的 `annualCashFlowYuan` 是量化后的值；若指标用未量化的原始值计算，
   * 审计方拿留档现金流复算 NPV 必然对不上（差几厘钱）。可复算性要求
   * 「留档的现金流就是唯一真源」，因此统一先量化、后评价——两条口径各量化各的。 */
  for (let i = 0; i < projectFlows.length; i++) projectFlows[i] = round(projectFlows[i]);
  for (let i = 0; i < equityFlows.length; i++) equityFlows[i] = round(equityFlows[i]);

  const cumulativeCashFlowYuan: number[] = [];
  let cum = 0;
  for (const f of projectFlows) {
    cum += f;
    cumulativeCashFlowYuan.push(round(cum));
  }

  /* ── 8. 评价指标（全部由 finance.ts 原语给出） ── */
  const npvRaw = npv(discountRate, projectFlows);
  const irrRes = irr(projectFlows);
  const roiRes = roiPct(projectFlows);
  const lcoe = lcoeDenominatorKwh > 0 ? lcoeNumeratorYuan / lcoeDenominatorKwh : null;

  const equityNpvRaw = npv(discountRate, equityFlows);
  const equityIrrRes = irr(equityFlows);

  const metrics: EconomicsResult["metrics"] = {
    npvYuan: round(npvRaw),
    irr: irrRes.ok
      ? { ok: true, valuePct: round((irrRes.value ?? 0) * 100, 3) }
      : { ok: false, reason: irrRes.reason },
    simplePaybackYears: simplePaybackYears(projectFlows),
    discountedPaybackYears: discountedPaybackYears(projectFlows, discountRate),
    roiRatio: roiRes.ok ? { ok: true, value: roiRes.value } : { ok: false, reason: roiRes.reason },
    lcoeYuanPerKwh: lcoe === null || !Number.isFinite(lcoe) ? null : round(lcoe, 4),
    equity: {
      npvYuan: round(equityNpvRaw),
      irr: equityIrrRes.ok
        ? { ok: true, valuePct: round((equityIrrRes.value ?? 0) * 100, 3) }
        : { ok: false, reason: equityIrrRes.reason },
      simplePaybackYears: simplePaybackYears(equityFlows),
    },
  };

  /* ── 9. 诊断（只登记"会影响结论的缺口"，不重复基准层的证据诊断） ── */
  if (deliveredY1 > 0 && nz(e.chargingServiceFeeYuanPerKwh) <= 0) {
    diagnostics.push({
      kind: "EVIDENCE_MISSING",
      code: "service_fee_not_provided",
      message: "充电服务费单价为 0（或未填写），本次计算的服务收入为 0，经济结论只反映成本侧。",
      field: "economics.chargingServiceFeeYuanPerKwh",
      impact: "收入被低估，NPV 与回收期会明显偏保守，不能据此判断项目是否可行。",
      suggestion:
        "山西的服务费实行市场调节价、没有官方水平值，请按自身经营策略填写充电服务费单价后重算。",
    });
  }
  if (deliveredY1 > 0 && resalePriceRaw <= 0) {
    diagnostics.push({
      kind: "EVIDENCE_MISSING",
      code: "resale_price_assumed_at_cost",
      message: `未提供向车队结算的转供电价，已按**平价转供**处理：以本情景加权平均到户电价 ${round(resalePriceYuanPerKwh, 4)} 元/kWh 代收电费，运营方不赚电费差价。`,
      field: "economics.electricityResalePriceYuanPerKwh",
      impact:
        "电费属过手成本；若实际结算价高于/低于购电价，运营方的电费差价收益或亏损会直接改变结论。",
      suggestion: "按与车队约定的实际结算电价填写该参数后重算。",
    });
  }
  if (netYuan <= 0 && grossYuan > 0) {
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "subsidy_exceeds_capex",
      message: "建设补贴超过了工程总投资，净投资被压到 0 及以下。",
      field: "economics.constructionSubsidyPct",
      impact: "投资回收期会失真（分母趋零），经济指标不可用。",
      suggestion: "请核对补贴比例是否填写正确。",
    });
  }
  if (arbitrageY1 <= 0 && input.bessEnabled && input.bessEnergyKwh > 0) {
    diagnostics.push({
      kind: "CONSTRAINT_VIOLATION",
      code: "bess_no_economic_value",
      message:
        "储能投了钱但没有产生正的价差收益：在当前电价结构下，充放电所能赚到的价差不足以覆盖「少上网」的机会成本与往返损耗。",
      impact: "储能投资基本是净支出，会直接拉低 NPV 并拉长回收期。",
      suggestion:
        "可对比三个方向：①取消储能；②把充电负荷向白天光伏时段平移，让储能去做真正的「搬电」；③核实上网电价是否偏低。",
    });
  }

  return {
    result: {
      capex,
      opexY1,
      revenueY1,
      costY1Yuan: round(costY1Yuan),
      netCashFlowY1PreTaxYuan: round(netCashFlowY1PreTaxYuan),
      annualCashFlowYuan: projectFlows.map((f) => round(f)),
      equityCashFlowYuan: equityFlows.map((f) => round(f)),
      metrics,
      cumulativeCashFlowYuan,
    },
    diagnostics,
    details: {
      annualDepreciationYuan: round(annualDepreciationYuan),
      loanAmountYuan: round(loanAmountYuan),
      equityAmountYuan: round(equityAmountYuan),
      annualLoanInterestY1Yuan: round(loan.interest[0] ?? 0),
      annualLoanPrincipalY1Yuan: round(loan.principal[0] ?? 0),
      residualValueYuan: round(residualValueYuan),
      taxableIncomeY1Yuan: round(taxableIncomeY1Yuan),
      incomeTaxY1Yuan: round(incomeTaxY1Yuan),
      lcoeNumeratorYuan: round(lcoeNumeratorYuan),
      lcoeDenominatorKwh: round(lcoeDenominatorKwh),
    },
  };
}

/* ═══════════════════════════ 敏感性（tornado） ═══════════════════════════ */

export interface SensitivitySpec {
  key: string;
  label: string;
  /** 扰动幅度（%）。 */
  deltaPct: number;
  unit: string;
  /**
   * 该变量在**本情景**下是否值得扰动。
   *
   * 为什么需要它：一个没装光伏的情景不该出现「光伏单位投资」这根条——它摆幅为 0，
   * 却会占据 tornado 图的一行，让读者误以为「光伏价格也值得去谈」。
   * 没有这件事，就不要把它放进图里。
   */
  when?: (input: EconomicsComputationInput) => boolean;
}

/**
 * 参与敏感性分析的变量（**声明式**：加一根条只需在这里加一行，不改任何分支逻辑）。
 * 覆盖"收入端 / 成本端 / 投资端 / 资金端"四类，避免只扰动价格、不扰动投资的片面结论。
 */
export const SENSITIVITY_SPECS: readonly SensitivitySpec[] = [
  { key: "chargingServiceFee", label: "充电服务费单价", deltaPct: 20, unit: "元/kWh", when: (i) => deliveredOf(i) > 0 },
  { key: "electricityPrice", label: "到户电价水平", deltaPct: 20, unit: "元/kWh", when: (i) => nz(i.annualNetImportKwh) > 0 },
  { key: "fleetScale", label: "运输量（车队规模）", deltaPct: 20, unit: "kWh/年", when: (i) => deliveredOf(i) > 0 },
  { key: "pvYield", label: "光伏年发电量", deltaPct: 20, unit: "kWh/年", when: (i) => i.pvEnabled && nz(i.annualPvGenerationKwh) > 0 },
  { key: "pvCapex", label: "光伏单位投资", deltaPct: 20, unit: "元/W", when: (i) => i.pvEnabled && nz(i.pvCapacityKwp) > 0 },
  { key: "bessCapex", label: "储能单位投资", deltaPct: 20, unit: "元/Wh", when: (i) => i.bessEnabled && nz(i.bessEnergyKwh) > 0 },
  { key: "chargerCapex", label: "充电设施单位投资", deltaPct: 20, unit: "元/kW", when: (i) => nz(i.chargerInstalledKw) > 0 },
  { key: "swapCapex", label: "换电站单位投资", deltaPct: 20, unit: "元/站", when: (i) => i.swapEnabled && nz(i.swapStationCount) > 0 },
  { key: "discountRate", label: "折现率", deltaPct: 20, unit: "%" },
];

/** 年交付电量（充电 + 换电，电池侧）。 */
function deliveredOf(i: EconomicsComputationInput): number {
  return nz(i.annualChargingDeliveredKwh) + nz(i.annualSwapDeliveredKwh);
}

/** 基准值（展示用，取"这个变量本身"的当前值）。 */
function specBaseValue(input: EconomicsComputationInput, key: string): number {
  const e = input.economics;
  switch (key) {
    case "chargingServiceFee":
      return nz(e.chargingServiceFeeYuanPerKwh);
    case "electricityPrice":
      return nz(input.gridFlatPriceYuanPerKwh);
    case "fleetScale":
      return round(nz(input.annualChargingDeliveredKwh) + nz(input.annualSwapDeliveredKwh));
    case "pvYield":
      return round(nz(input.annualPvGenerationKwh));
    case "pvCapex":
      return nz(e.pvCapexYuanPerW);
    case "bessCapex":
      return nz(e.bessCapexYuanPerWh);
    case "chargerCapex":
      return nz(e.chargerCapexYuanPerKw);
    case "discountRate":
      return nz(e.discountRatePct);
    default:
      return 0;
  }
}

function cloneInput(i: EconomicsComputationInput): EconomicsComputationInput {
  return { ...i, economics: { ...i.economics } };
}

/** 以加权平均到户电价把"下网电量"折成电度成本（缺价时保持原值）。 */
function energyCostOf(netImportKwh: number, wap: number | null, fallback: number): number {
  if (wap === null || !Number.isFinite(wap)) return fallback;
  return Math.max(0, netImportKwh) * wap;
}

/**
 * 按变量扰动经济层输入。传入 `deltaPct = +20` 表示"该变量上行 20%"。
 * 物理调度结果保持不变——见文件头「敏感性的诚实边界」。
 */
export function perturbEconomicsInput(
  input: EconomicsComputationInput,
  key: string,
  deltaPct: number,
): EconomicsComputationInput {
  const out = cloneInput(input);
  const d = deltaPct / 100;
  const wap = input.weightedAveragePriceYuanPerKwh;

  switch (key) {
    case "chargingServiceFee":
      out.economics.chargingServiceFeeYuanPerKwh = nz(out.economics.chargingServiceFeeYuanPerKwh) * (1 + d);
      out.economics.swapServiceFeeYuanPerKwh = nz(out.economics.swapServiceFeeYuanPerKwh) * (1 + d);
      break;

    case "electricityPrice": {
      const mult = 1 + d;
      out.gridFlatPriceYuanPerKwh = nz(input.gridFlatPriceYuanPerKwh) * mult;
      out.annualEnergyCostYuan = nz(input.annualEnergyCostYuan) * mult;
      out.annualDemandChargeYuan = nz(input.annualDemandChargeYuan) * mult;
      out.annualExportRevenueYuan = nz(input.annualExportRevenueYuan) * mult;
      out.weightedAveragePriceYuanPerKwh = wap === null ? null : wap * mult;
      break;
    }

    case "fleetScale":
    case "transportVolume": {
      const mult = 1 + d;
      out.annualChargingDeliveredKwh = nz(input.annualChargingDeliveredKwh) * mult;
      out.annualSwapDeliveredKwh = nz(input.annualSwapDeliveredKwh) * mult;
      // 增量运输量只能由电网补（光伏/储能调度规模不变）
      const extraImport = nz(input.annualLoadKwh) * d;
      const nextImport = Math.max(0, nz(input.annualNetImportKwh) + extraImport);
      out.annualNetImportKwh = nextImport;
      out.annualEnergyCostYuan = energyCostOf(nextImport, wap, nz(input.annualEnergyCostYuan));
      break;
    }

    case "pvYield": {
      const mult = 1 + d;
      out.annualPvGenerationKwh = nz(input.annualPvGenerationKwh) * mult;
      const nextSelf = nz(input.annualPvSelfConsumedKwh) * mult;
      const deltaSelf = nextSelf - nz(input.annualPvSelfConsumedKwh);
      out.annualPvSelfConsumedKwh = nextSelf;
      const nextImport = Math.max(0, nz(input.annualNetImportKwh) - deltaSelf);
      out.annualNetImportKwh = nextImport;
      out.annualEnergyCostYuan = energyCostOf(nextImport, wap, nz(input.annualEnergyCostYuan));
      out.annualExportRevenueYuan = nz(input.annualExportRevenueYuan) * mult;
      break;
    }

    case "pvCapex":
      out.economics.pvCapexYuanPerW = nz(out.economics.pvCapexYuanPerW) * (1 + d);
      break;
    case "bessCapex":
      out.economics.bessCapexYuanPerWh = nz(out.economics.bessCapexYuanPerWh) * (1 + d);
      break;
    case "chargerCapex":
      out.economics.chargerCapexYuanPerKw = nz(out.economics.chargerCapexYuanPerKw) * (1 + d);
      break;
    case "swapCapex":
      out.economics.swapStationCapexYuanPerStation = nz(out.economics.swapStationCapexYuanPerStation) * (1 + d);
      break;
    case "discountRate":
      out.economics.discountRatePct = nz(out.economics.discountRatePct) * (1 + d);
      break;
    default:
      break;
  }
  return out;
}

/**
 * 单变量 tornado：对每个变量取 ±`deltaPct`，给出对应 NPV。
 *
 * 返回的条按**摆幅**降序（= 决策最该关心的变量排最前）。
 * 任一扰动出现非有限 NPV → 该条被跳过（诚实：不编造一根没有数的条）。
 */
export function sensitivityBars(input: EconomicsComputationInput): SensitivityBar[] {
  const bars: SensitivityBar[] = [];

  for (const spec of SENSITIVITY_SPECS) {
    if (spec.when && !spec.when(input)) continue; // 本情景没这件事 → 不进图
    const baseValue = specBaseValue(input, spec.key);
    if (baseValue === 0) continue;

    const low = perturbEconomicsInput(input, spec.key, -spec.deltaPct);
    const high = perturbEconomicsInput(input, spec.key, +spec.deltaPct);
    const npvLow = npv(nz(low.economics.discountRatePct) / 100, buildFlows(low));
    const npvHigh = npv(nz(high.economics.discountRatePct) / 100, buildFlows(high));
    if (!Number.isFinite(npvLow) || !Number.isFinite(npvHigh)) continue;

    bars.push({
      key: spec.key,
      label: spec.label,
      baseValue: round(baseValue, 4),
      unit: spec.unit,
      npvAtLow: round(npvLow),
      npvAtHigh: round(npvHigh),
      deltaLowPct: -spec.deltaPct,
      deltaHighPct: spec.deltaPct,
      swingYuan: round(Math.abs(npvHigh - npvLow)),
    });
  }

  bars.sort((a, b) => b.swingYuan - a.swingYuan);
  return bars;
}

/**
 * 只重算现金流、不重算明细的轻量路径（供敏感性大量调用）。
 * 与 `computeEconomics` 共用同一套口径参数，故二者结果一致。
 */
function buildFlows(input: EconomicsComputationInput): number[] {
  return computeEconomics(input).result.annualCashFlowYuan;
}
