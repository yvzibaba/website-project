/**
 * 沙盘经济编排引擎（中途重构 R2.4）——把 R1.2 参数快照、R2.1 技术能耗、R2.2 财务原语**串成端到端
 * `CalcResult`**，是《项目中途重构总控》§4 命脉「改参数→技术结果变→经济结果变」的**汇合点**，
 * 也是 R4 可视化 / R6 动态报告唯一应当消费的数据源。§7 命令 NPV/IRR/ROI/回收期 **必须程序计算**，
 * 本文件正是那台程序引擎；LLM（R6）只能读它的输出做解释，绝不代算。
 *
 * ⚠️ 诚实边界（第 16/20 条）：
 *   - 入参默认全部来自 R1.2 的**占位假设**（ASSUMPTION），且本层沿用的是 `sandbox-tech` 的**透明简化年度能量平衡**；
 *   - 现金流采用**明文写死的简化口径**（见下 ECONOMIC_MODEL），非可研/财税级；
 *   - 因此每个结论都属高风险领域，结果恒带 `needsProfessionalReview=true`，**不得当作投资/并网决策依据**。
 *
 * ── ECONOMIC_MODEL（透明简化口径，逐条可核，改任一条须升 `MODEL_VERSION` 并记原因）──────────────
 *   E1 CAPEX = 光伏(装机kWp×1000×光伏元/W) + 储能(容量kWh×1000×储能元/Wh，无储能则 0)
 *             + 充电桩(总功率kW×充电桩元/kW)；建设补贴按 `gross×constructionSubsidy%` 从 t=0 投资中扣减。
 *   E2 OPEX（元/年，随通胀逐年放大）= 光伏(装机×元/kWp·年) + 储能(容量×元/kWh·年) + 桩(桩数×元/台·年) + 电站固定运营成本。
 *   E3 收入（元/年）= 充电(电池侧年电量×综合充电单价) + 余电上网(上网量×上网电价) + 运营补贴(充电量×补贴元/kWh)。
 *      · 综合充电单价 `chargingPrice` 设为"电费+服务费合一、向重卡收取"的口径；据此与 E4 购电成本配对，避免重复计费。
 *   E4 购电成本（元/年）= 下网电量×工商业电价（下网部分随通胀放大；自用光伏电量不产生现金购电成本，即光伏的价值来源）。
 *   E5 逐年：光伏量按衰减 (1−deg%)^(y−1) 递减→ 再平衡自用/上网/下网（唯一按"实际量"递减项）；
 *      所有名义单价（充电单价/上网电价/补贴/电价/OPEX）随 `inflation%` 同步放大（假设"实际价不变"，
 *      故收入与成本同向膨胀，真实利润仅被光伏衰减侵蚀——避免把"电价涨而充电价冻结"的人工挤压当基准）。
 *   E6 税后净现金流 = 当年 (收入 − 购电 − OPEX)；正值按 `(1−taxRate%)` 征税（无折旧抵税shield，简化，已在 notes 提示偏保守），负值不递延。
 *   E7 期末残值 = 末年追加 `grossCapex×residualValue%`。
 *   E8 flows[0] = −净CAPEX，flows[y] = 第 y 年税后净现金流(+末年残值)；喂 npv/irr/payback/roi。折现率/期限取 finance 参数。
 *   ── 刻意留白（V1，标 needsProfessionalReview / 待 R6+ 精化）：无融资结构利息税盾、无流动资金、无敏感性内嵌（R2.3）、
 *      无逐时曲线（S1）、无 SOH/温度/弃电（S5）、无充电需求增长曲线、残值不再按通胀折算（E7 取名义常数）。
 */
import { resolveSandbox } from "@/server/sandbox-params";
import type { ResolveLayers } from "@/server/parameter-engine";
import {
  computeTechModel,
  pvDegradedAnnualEnergy,
  annualEnergyBalance,
  TECH_VERSION,
} from "@/server/sandbox-tech";
import {
  npv,
  irr,
  simplePaybackYears,
  discountedPaybackYears,
  roiPct,
  round,
  FINANCE_VERSION,
  type IrrResult,
} from "@/server/sandbox-finance";

/** 编排引擎版本（改经济口径须升版并记原因，宪法第 13 条）。 */
export const MODEL_VERSION = "1.0.0";

/** 溯源引用（组合各内核版本，供报告标注"这组数是按哪几版算的"，第 7/16 条）。 */
export function modelCalcRef(): string {
  return `model@${MODEL_VERSION}`;
}

/* 经济口径所需的额外参数键（R2.1 只吃能量键，钱的部分在此补齐）。 */
const ECON_KEYS = {
  // capex
  pvCapexPerW: "tech.pvCapex", // 元/W
  storageCapexPerWh: "tech.storageCapex", // 元/Wh
  chargerCapexPerKw: "tech.chargerCapex", // 元/kW
  chargerCount: "project.chargerCount",
  chargerTotalPower: "derived.chargerTotalPower", // kW
  constructionSubsidyPct: "policy.constructionSubsidy", // %
  // opex
  pvOmPerKwp: "tech.pvOm", // 元/kWp·年
  storageOmPerKwh: "tech.storageOm", // 元/kWh·年
  chargerOmPerUnit: "tech.chargerOm", // 元/台·年
  depotFixedOpex: "tech.depotFixedOpex", // 元/年
  // revenue / energy cost
  chargingPrice: "project.chargingPrice", // 元/kWh
  feedInTariff: "policy.feedInTariff", // 元/kWh
  operationSubsidyPerKwh: "policy.operationSubsidy", // 元/kWh
  elecPrice: "region.elecPrice", // 元/kWh
  // finance
  discountRatePct: "finance.discountRate", // %
  projectLifeYears: "finance.projectLife",
  inflationPct: "finance.inflation", // %/年
  taxRatePct: "finance.taxRate", // %
  residualValuePct: "finance.residualValue", // %
  // tech 里已解析但编排也要引用的
  degradationPct: "tech.pvDegradation",
} as const;

const ECON_REQUIRED: readonly string[] = Object.values(ECON_KEYS);

export interface CapexBreakdown {
  pv: number;
  storage: number;
  charger: number;
  gross: number;
  constructionSubsidy: number;
  net: number;
}
export interface OpexBreakdownY1 {
  pv: number;
  storage: number;
  charger: number;
  depotFixed: number;
  gross: number;
}
export interface RevenueBreakdownY1 {
  charging: number;
  pvExport: number;
  operationSubsidy: number;
  gross: number;
}

export interface CalcResultOk {
  ok: true;
  calcRef: string;
  engineVersions: { model: string; tech: string; finance: string; params: string };
  methodology: string;
  needsProfessionalReview: true;
  capex: CapexBreakdown;
  opexY1: OpexBreakdownY1;
  revenueY1: RevenueBreakdownY1;
  energyCostY1: number;
  netCashFlowY1PreTax: number;
  /** 逐年税后净现金流（flows[0]=−净 CAPEX，长度 = 计算期+1）。 */
  annualCashFlow: number[];
  /** 首年盈亏平衡所需"综合充电单价"（简化：覆盖 OPEX+购电÷充电量），供敏感性/提示参考。 */
  breakEvenChargingPriceY1: number | null;
  metrics: {
    npv: number; // NaN 表示算不出
    irr: IrrResult;
    simplePaybackYears: number | null;
    discountedPaybackYears: number | null;
    roi: { ok: boolean; value?: number; reason?: string };
  };
  notes: string[];
}

export interface CalcResultErr {
  ok: false;
  calcRef: string;
  reason: "tech_error" | "missing_econ_inputs" | "invalid_econ_inputs";
  detail: string;
  missingInputs?: string[];
  invalidInputs?: string[];
}

export type CalcResult = CalcResultOk | CalcResultErr;

/** 从数值快照读经济键；缺 → missing，非有限 → invalid。返回 null 表示已产出错误。 */
function readEcon(numeric: Record<string, number | undefined>) {
  const missing = ECON_REQUIRED.filter((k) => numeric[k] == null);
  const invalid = ECON_REQUIRED.filter(
    (k) => numeric[k] != null && !Number.isFinite(numeric[k] as number),
  );
  if (missing.length > 0) return { error: { reason: "missing_econ_inputs" as const, missing } };
  if (invalid.length > 0) return { error: { reason: "invalid_econ_inputs" as const, invalid } };
  const get = (k: string) => numeric[k] as number;
  return { v: get, error: null as null | { reason: "missing_econ_inputs" | "invalid_econ_inputs"; missing?: string[]; invalid?: string[] } };
}

/**
 * 经济内核纯函数：给定完整数值快照，产出逐年现金流与评价结果（不含 resolve，便于测死）。
 * `techFirstYear` 为 R2.1 成功结果（提供首年能量流）。
 */
export function computeEconomics(
  numeric: Record<string, number | undefined>,
): CalcResult {
  const baseErr = (
    reason: CalcResultErr["reason"],
    detail: string,
    extra: Partial<CalcResultErr> = {},
  ): CalcResultErr => ({
    ok: false,
    calcRef: modelCalcRef(),
    reason,
    detail,
    ...extra,
  });

  // 先跑技术层（能量流），失败即诚实回报。
  const tech = computeTechModel(numeric);
  if (!tech.ok) {
    return baseErr(
      "tech_error",
      `技术层未通过：${tech.reason} ${[...(tech.missingInputs ?? []), ...(tech.invalidInputs ?? [])].join(",")}`,
    );
  }

  const r = readEcon(numeric);
  if (r.error) {
    return r.error.reason === "missing_econ_inputs"
      ? baseErr("missing_econ_inputs", "缺少经济参数", { missingInputs: r.error.missing })
      : baseErr("invalid_econ_inputs", "经济参数含非法值", { invalidInputs: r.error.invalid });
  }
  const g = r.v!;

  const pvCapacity = numeric["project.pvCapacity"] as number;
  const storageEnergy = numeric["project.storageEnergy"] as number;
  const storagePower = numeric["project.storagePower"] as number;
  const hasStorage =
    storageEnergy > 0 && storagePower > 0 && tech.storageIncluded;

  // ── E1 CAPEX ──
  const pvCapex = pvCapacity * 1000 * g(ECON_KEYS.pvCapexPerW);
  const storageCapex = hasStorage ? storageEnergy * 1000 * g(ECON_KEYS.storageCapexPerWh) : 0;
  const chargerCapex = g(ECON_KEYS.chargerTotalPower) * g(ECON_KEYS.chargerCapexPerKw);
  const capexGross = pvCapex + storageCapex + chargerCapex;
  const constructionSubsidy = (capexGross * g(ECON_KEYS.constructionSubsidyPct)) / 100;
  const capexNet = capexGross - constructionSubsidy;

  // ── E2 OPEX（首年）──
  const opexPv = pvCapacity * g(ECON_KEYS.pvOmPerKwp);
  const opexStorage = hasStorage ? storageEnergy * g(ECON_KEYS.storageOmPerKwh) : 0;
  const opexCharger = g(ECON_KEYS.chargerCount) * g(ECON_KEYS.chargerOmPerUnit);
  const opexDepot = g(ECON_KEYS.depotFixedOpex);
  const opexY1 = opexPv + opexStorage + opexCharger + opexDepot;

  // ── E3/E4 收入与购电（首年）──
  const deliveredY1 = tech.firstYear.chargeEnergyDeliveredY1Kwh;
  const revCharging = deliveredY1 * g(ECON_KEYS.chargingPrice);
  const revExport = tech.firstYear.pvExportY1Kwh * g(ECON_KEYS.feedInTariff);
  const revSubsidy = deliveredY1 * g(ECON_KEYS.operationSubsidyPerKwh);
  const revenueY1 = revCharging + revExport + revSubsidy;
  const energyCostY1 = tech.firstYear.gridImportY1Kwh * g(ECON_KEYS.elecPrice);
  const netY1PreTax = revenueY1 - energyCostY1 - opexY1;

  // ── E5–E7 逐年现金流 ──
  const life = g(ECON_KEYS.projectLifeYears);
  const rate = g(ECON_KEYS.discountRatePct) / 100;
  const infl = g(ECON_KEYS.inflationPct) / 100;
  const tax = g(ECON_KEYS.taxRatePct) / 100;
  const residual = (capexGross * g(ECON_KEYS.residualValuePct)) / 100;
  const degradationPct = g(ECON_KEYS.degradationPct);

  const pvEnergyY1 = tech.firstYear.pvEnergyY1Kwh;
  const acLoad = tech.firstYear.acLoadY1Kwh; // 负荷名义不变（E5）

  const flows: number[] = [-capexNet];
  const taxBlocked = netY1PreTax > 0 && tax > 0;
  for (let y = 1; y <= life; y++) {
    const pvY = pvDegradedAnnualEnergy(pvEnergyY1, degradationPct, y);
    const bal = annualEnergyBalance({ pvEnergyKwh: pvY, acLoadKwh: acLoad });
    const importY = bal ? bal.gridImportKwh : acLoad;
    const exportY = bal ? bal.pvExportKwh : 0;
    const inflFactor = (1 + infl) ** (y - 1); // E5 名义单价随通胀同步放大
    const revY =
      (deliveredY1 * g(ECON_KEYS.chargingPrice) +
        exportY * g(ECON_KEYS.feedInTariff) +
        deliveredY1 * g(ECON_KEYS.operationSubsidyPerKwh)) *
      inflFactor;
    const costY = (importY * g(ECON_KEYS.elecPrice) + opexY1) * inflFactor;
    let netY = revY - costY;
    if (netY > 0) netY *= 1 - tax; // E6 税后（无折旧抵税，简化）
    if (y === life) netY += residual; // E7 残值
    flows.push(netY);
  }

  // ── E8 评价指标（全部程序算）──
  const npvVal = npv(rate, flows);
  const irrVal = irr(flows);
  const payS = simplePaybackYears(flows);
  const payD = discountedPaybackYears(flows, rate);
  const roiVal = roiPct(flows);

  // 首年盈亏平衡充电单价（覆盖首年 OPEX+购电，÷充电量；delivered=0 → null）
  const breakEvenPrice =
    deliveredY1 > 0
      ? round((energyCostY1 + opexY1) / deliveredY1, 4)
      : null;

  const notes: string[] = [];
  if (taxBlocked) notes.push("已按企业所得税率对正净现金流简化计税（无折旧抵税 shield，偏保守）");
  if (rate < 0) notes.push("折现率为负，NPV 口径异常，谨慎解读");
  if (!irrVal.ok) notes.push(`IRR 无法给出（${irrVal.reason}）：不编造比率，看 NPV/回收期`);
  if (payD === null) notes.push("折现回收期超出计算期：分析期内未回本（不假设迟早回本）");
  if (!hasStorage && storageEnergy > 0)
    notes.push("储能键存在但技术层判定未纳入，储能相关 CAPEX/OPEX 按 0 计");

  return {
    ok: true,
    calcRef: modelCalcRef(),
    engineVersions: {
      model: MODEL_VERSION,
      tech: TECH_VERSION,
      finance: FINANCE_VERSION,
      params: String(tech.calcRef),
    },
    methodology:
      "简化年度税后现金流沙盘（透明假设，非可研/财税级），CAPEX/OPEX/NPV/IRR/回收期均程序计算，须经专业人工确认",
    needsProfessionalReview: true,
    capex: {
      pv: round(pvCapex, 0),
      storage: round(storageCapex, 0),
      charger: round(chargerCapex, 0),
      gross: round(capexGross, 0),
      constructionSubsidy: round(constructionSubsidy, 0),
      net: round(capexNet, 0),
    },
    opexY1: {
      pv: round(opexPv, 0),
      storage: round(opexStorage, 0),
      charger: round(opexCharger, 0),
      depotFixed: round(opexDepot, 0),
      gross: round(opexY1, 0),
    },
    revenueY1: {
      charging: round(revCharging, 0),
      pvExport: round(revExport, 0),
      operationSubsidy: round(revSubsidy, 0),
      gross: round(revenueY1, 0),
    },
    energyCostY1: round(energyCostY1, 0),
    netCashFlowY1PreTax: round(netY1PreTax, 0),
    annualCashFlow: flows.map((f) => round(f, 0)),
    breakEvenChargingPriceY1: breakEvenPrice,
    metrics: {
      npv: Number.isFinite(npvVal) ? round(npvVal, 0) : NaN,
      irr: irrVal,
      simplePaybackYears: payS,
      discountedPaybackYears: payD,
      roi: roiVal,
    },
    notes,
  };
}

/**
 * 沙盘主入口：解析参数分层覆写 → 技术能量 → 经济现金流 → 评价指标 → `CalcResult`。
 * 这就是 R4/R6 应消费的唯一真源；§4 命脉体现为：改 `layers.user` 任一滑块 → 此处整链重算。
 */
export function runSandboxModel(layers: Omit<ResolveLayers, "derived"> = {}): CalcResult {
  const resolved = resolveSandbox(layers);
  const econ = computeEconomics(resolved.numeric);
  if (econ.ok) {
    econ.engineVersions.params = `${econ.engineVersions.params}`; // 保持 tech calcRef 溯源（tech@x）
  }
  return econ;
}

/** 基线运行（无覆写），供默认视图/文档示例/冒烟。 */
export function runSandboxModelBaseline(): CalcResult {
  return runSandboxModel();
}
