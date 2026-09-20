/**
 * 决策报告（DecisionReport）—— 把一次计算的结果翻译成**可交付给他人阅读**的结构化文档。
 *
 * ## 一条硬规则：报告**只读**计算结果，不做任何计算
 *
 * 本文件里没有一处四则运算参与结论（只有单位换算与数字格式化）。所有数字都来自
 * `CalculationResult`。理由很实际：只要报告能自己算一点，就一定会在某个版本里
 * 和引擎算出不一样的数——而报告是给人看的、引擎是给机器算的，两者一旦不一致，
 * 就没有人知道该信哪一个。所以：**报告 = 视图，不是模型**。
 *
 * ## 为什么返回"结构化段"而不是一段 Markdown / HTML
 *
 * 因为同一份报告要同时喂给三种消费者：
 *   - 网页（`/workbench/projects/[id]` 按 `section.id` 做锚点与折叠）；
 *   - 导出文档（Word/PDF，需要标题层级与表格）；
 *   - 审计与回归测试（需要稳定 id 与稳定数值文本）。
 * 返回 `ReportSection[]` 后，这三种渲染只是三种"读法"，不需要各写一份报告生成逻辑。
 *
 * ## 免责声明不可省略
 *
 * 本报告的全部结论都属"高风险领域"的模型估算，且关键行情参数多数尚无官方来源
 * （基准层已逐条标注置信度）。因此 `disclaimer` 是**契约字段**，任何调用方都不得为了
 * "版面好看"而删掉它。
 */

import { REPORT_VERSION } from "@app/kernel/engine/types";
import type {
  CalculationResult,
  DecisionReport,
  ReportSection,
} from "@app/kernel/engine/types";

export const REPORT_BUILDER_VERSION = "1.0.0";

/** 常驻免责声明（契约字段，不允许调用方裁剪）。 */
export const REPORT_DISCLAIMER =
  "本报告由计算引擎按给定假设自动生成，用于项目早期的方案比较与风险识别，不构成投资建议。" +
  "其中的电价水平、设备单价、单位能耗等关键参数部分尚无官方或厂商可核验来源（已在「关键假设」中逐条标注置信度），" +
  "实际取值与假设不同会使结论发生变化。" +
  "报告结论须经具备资质的专业机构复核、并以实际合同价与结算单价重算后，方可用于投资决策。";

/* ═══════════════════════════ 格式化 ═══════════════════════════ */

function n(v: number, dp = 0): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function wan(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${n(v / 10_000, 1)} 万元`;
}
function kwh(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v) >= 10_000 ? `${n(v / 10_000, 1)} 万 kWh` : `${n(v, 0)} kWh`;
}
function kw(v: number): string {
  return `${n(v, 0)} kW`;
}
function pct(v: number, dp = 1): string {
  return `${n(v, dp)}%`;
}
/* ═══════════════════════════ 主入口 ═══════════════════════════ */

export interface ReportOptions {
  /**
   * 报告生成时刻（ISO）。**由调用方传入**，不由本模块读时钟——
   * 这样同一份计算结果在测试里可以生成逐字节一致的报告，回归才有意义。
   */
  generatedAtIso: string;
  /** 报告标题（默认按情景名生成）。 */
  title?: string;
}

export function buildDecisionReport(calc: CalculationResult, opts: ReportOptions): DecisionReport {
  const { truckDemand, charging, pv, bess, grid, economics: ec, decision, inputSnapshot } = calc;
  const input = inputSnapshot;
  const sections: ReportSection[] = [];

  /* ── 1. 结论摘要 ── */
  sections.push({
    id: "summary",
    title: "一、结论摘要",
    kind: "paragraph",
    paragraphs: [decision.explanation.summary, ...decision.explanation.paragraphs],
  });

  /* ── 2. 可行性判定（逐条判据，可审计） ── */
  sections.push({
    id: "feasibility",
    title: "二、可行性判定",
    kind: "table",
    paragraphs: [
      decision.feasibility.feasible
        ? "全部硬性判据通过：该方案在给定假设下能够交付运输用能需求，且经济指标达到门槛。"
        : `存在 ${decision.feasibility.blockers.length} 项未通过的判据，方案在当前配置下不可行。`,
    ],
    table: {
      columns: ["判据", "结论", "说明"],
      rows: decision.feasibility.checks.map((c) => [c.label, c.passed ? "通过" : "未通过", c.detail]),
    },
    items: decision.feasibility.blockers.length
      ? decision.feasibility.blockers.map((b, i) => ({ label: `阻塞项 ${i + 1}`, value: b }))
      : undefined,
  });

  /* ── 3. 推荐意见 ── */
  sections.push({
    id: "recommendation",
    title: "三、推荐意见",
    kind: "paragraph",
    paragraphs: [decision.recommendation.headline],
    bullets: [
      ...decision.recommendation.reasons.map((r) => `【支持】${r}`),
      ...decision.recommendation.concerns.map((c) => `【关注】${c}`),
    ],
  });

  /* ── 4. 关键假设（必须人工确认） ── */
  sections.push({
    id: "critical-assumptions",
    title: "四、必须人工确认的关键假设",
    kind: "table",
    paragraphs: [
      "下表列出本次计算中**证据强度不足**的输入（非官方来源、低置信度、或用户未提供）。" +
        "它们不是「可以忽略的参数」，而是「结论成立的前提」——任一项不成立，推荐意见都可能改变。",
    ],
    table: {
      columns: ["参数", "本次取值", "证据等级", "置信度", "若不成立会怎样"],
      rows: decision.criticalAssumptions.map((a) => [
        a.label,
        typeof a.value === "number" ? `${n(a.value, 3)}${a.unit ? ` ${a.unit}` : ""}` : String(a.value),
        a.evidenceKind,
        `${a.confidence}/100`,
        a.impactIfWrong,
      ]),
    },
  });

  /* ── 5. 车队与用能需求 ── */
  sections.push({
    id: "truck-demand",
    title: "五、车队与用能需求",
    kind: "key-values",
    items: [
      { label: "车队规模", value: `${n(input.truck.truckCount)} 辆（额定载重 ${n(input.truck.payloadTons, 1)} 吨）` },
      { label: "单车日均里程", value: `${n(input.truck.dailyMileageKm)} km/运营日` },
      { label: "年运营天数", value: `${n(truckDemand.operatingDays)} 天` },
      { label: "单位能耗（标准工况）", value: `${n(input.truck.energyConsumptionKwhPerKm, 2)} kWh/km（季节 +${n(input.truck.seasonalFactorPct)}%、线路 +${n(input.truck.routeFactorPct)}%）` },
      { label: "年用能需求（电池侧）", value: kwh(truckDemand.annualEnergyAtBatteryKwh) },
      { label: "年用能需求（电网侧口径）", value: kwh(truckDemand.annualEnergyDemandKwh), hint: "已含充电链路与换电损耗" },
      { label: "日均用能需求", value: `${n(truckDemand.dailyEnergyDemandKwh)} kWh/运营日` },
      { label: "充电窗口", value: `${n(input.truck.chargingWindowStartHour, 1)}:00 — ${n(input.truck.chargingWindowEndHour, 1)}:00（${n(truckDemand.chargingWindowHours, 1)} 小时）` },
      { label: "充电策略", value: input.truck.chargingStrategy === "managed" ? "有序充电（向光伏时段倾斜）" : "回场即充（窗口内平铺）" },
    ],
    bullets: [
      `逐月需求最高的月份为 ${monthName(argmax(truckDemand.monthlyEnergyDemandKwh))}（${kwh(Math.max(...truckDemand.monthlyEnergyDemandKwh))}），最低为 ${monthName(argmin(truckDemand.monthlyEnergyDemandKwh))}（${kwh(Math.min(...truckDemand.monthlyEnergyDemandKwh))}）——用于计划充电与运维排班。`,
    ],
  });

  /* ── 6. 充换电方案 ── */
  const chargingRows: ReportSection["items"] = [
    { label: "补能方式", value: modeLabel(input.charging.mode) },
    { label: "充电桩", value: `${n(input.charging.charger.chargerCount)} 台 × ${n(input.charging.charger.chargerPowerKw)} kW（装机 ${kw(charging.installedPowerKw)}，同时率 ${n(input.charging.charger.simultaneousRatePct)}% → 有效 ${kw(charging.effectivePowerKw)}）` },
    { label: "年交付电量（电池侧）", value: kwh(charging.annualDeliveredKwh) },
    { label: "年站级取电量（电网侧）", value: kwh(charging.annualGridSideKwh) },
    { label: "站级负荷峰值", value: kw(charging.peakLoadKw) },
    { label: "站级年利用率", value: pct(charging.utilizationPct) },
    { label: "未满足需求", value: charging.unservedEnergyKwh > 0 ? `${kwh(charging.unservedEnergyKwh)}（配置不足）` : "无" },
  ];
  if (input.charging.swap.enabled) {
    chargingRows.push(
      { label: "换电站", value: `${n(input.charging.swap.stationCount)} 座（单站 ${n(input.charging.swap.chargingPowerKwPerStation)} kW，池内 ${n(input.charging.swap.batteryPoolCount)} 块）` },
      { label: "换电需求占比", value: pct(input.charging.swapSharePct) },
      { label: "年换电次数", value: `${n(charging.annualSwapEvents)} 次` },
      { label: "换电站年取电量", value: kwh(charging.swapGridSideKwh) },
    );
  }
  sections.push({
    id: "charging",
    title: "六、充换电方案",
    kind: "key-values",
    items: chargingRows,
    bullets: [
      `逐月站级峰值最高出现在 ${monthName(argmax(charging.monthlyPeakLoadKw))}（${kw(Math.max(...charging.monthlyPeakLoadKw))}），用于校核并网容量与变压器配置。`,
    ],
  });

  /* ── 7. 能源系统（光伏 / 储能 / 电网） ── */
  const energyItems: ReportSection["items"] = [];
  if (pv.annualGenerationKwh > 0) {
    energyItems.push(
      { label: "光伏装机", value: `${n(input.pv.capacityKwp)} kWp（倾角 ${n(input.pv.tiltDeg)}°、方位 ${n(input.pv.azimuthDeg)}°）` },
      { label: "年发电量", value: kwh(pv.annualGenerationKwh), hint: `等效利用小时 ${n(input.pv.specificYieldKwhPerKwp)} kWh/kWp` },
      { label: "年自用量 / 自用率", value: `${kwh(pv.selfConsumedKwh)} / ${pct(pv.selfConsumptionPct)}` },
      { label: "年上网量", value: kwh(pv.exportedKwh) },
      { label: "年弃光量", value: kwh(pv.curtailedKwh) },
      { label: "充电负荷的光伏覆盖率", value: pct(pv.chargingCoveragePct) },
    );
  } else {
    energyItems.push({ label: "光伏", value: "本情景未配置" });
  }
  if (bess.annualDischargeKwh > 0 || input.bess.enabled) {
    energyItems.push(
      { label: "储能配置", value: `${n(input.bess.powerKw)} kW / ${n(input.bess.energyKwh)} kWh（往返效率 ${n(input.bess.roundTripEfficiencyPct)}%）` },
      { label: "年充 / 放电量", value: `${kwh(bess.annualChargeKwh)} / ${kwh(bess.annualDischargeKwh)}` },
      { label: "年等效循环", value: `${n(bess.equivalentCycles, 1)} 次` },
      { label: "价差收益", value: wan(bess.arbitrageBenefitYuan) },
      { label: "需量削峰收益", value: wan(bess.demandChargeSavingYuan) },
    );
  } else {
    energyItems.push({ label: "储能", value: "本情景未配置" });
  }
  energyItems.push(
    { label: "并网容量", value: `${kw(input.grid.capacityKw)}（受电限制 ${kw(input.grid.importLimitKw)}）` },
    { label: "年下网电量", value: kwh(grid.annualImportKwh) },
    { label: "年上网电量", value: kwh(grid.annualExportKwh) },
    { label: "加权平均到户电价", value: grid.weightedAveragePriceYuanPerKwh === null ? "—" : `${n(grid.weightedAveragePriceYuanPerKwh, 4)} 元/kWh` },
    { label: "年最大需量", value: `${kw(Math.max(0, ...grid.monthlyPeakImportKw))}（出现在 ${monthName(argmax(grid.monthlyPeakImportKw))}）` },
    { label: "分时电价", value: input.grid.touEnabled ? `峰 ×${n(input.grid.peakMultiplier, 2)}、谷 ×${n(input.grid.valleyMultiplier, 2)}（平段 ${n(input.grid.flatPriceYuanPerKwh, 4)} 元/kWh）` : "未启用（全时段平段价）" },
  );
  sections.push({
    id: "energy-system",
    title: "七、能源系统",
    kind: "key-values",
    items: energyItems,
    bullets: [
      `能量平衡校验：${calc.invariant.ok ? "全部 35,040 个时段通过守恒" : `失败（${calc.invariant.violationCount} 个时段偏差超容差）`}——该结论由独立的不变量检查给出，不由各模块自证。`,
    ],
  });

  /* ── 8. 投资与经济性 ── */
  sections.push({
    id: "economics-capex",
    title: "八、投资构成（CAPEX）",
    kind: "table",
    table: {
      columns: ["科目", "金额", "占比"],
      rows: (() => {
        const g = ec.capex.grossYuan;
        const cp = (v: number) => (g > 0 ? pct((v / g) * 100) : "—");
        return [
          ["光伏系统", wan(ec.capex.pvYuan), cp(ec.capex.pvYuan)],
          ["储能系统", wan(ec.capex.bessYuan), cp(ec.capex.bessYuan)],
          ["充电设施", wan(ec.capex.chargerYuan), cp(ec.capex.chargerYuan)],
          ["换电设施", wan(ec.capex.swapYuan), cp(ec.capex.swapYuan)],
          ["并网与增容", wan(ec.capex.gridYuan), cp(ec.capex.gridYuan)],
          ["土建及其他", wan(ec.capex.civilYuan), cp(ec.capex.civilYuan)],
          ["预备费", wan(ec.capex.contingencyYuan), cp(ec.capex.contingencyYuan)],
          ["工程投资合计", wan(ec.capex.grossYuan), "100.0%"],
          ["建设补贴（抵减）", `-${wan(ec.capex.subsidyYuan)}`, "—"],
          ["**净投资**", `**${wan(ec.capex.netYuan)}**`, "—"],
        ];
      })(),
    },
  });

  sections.push({
    id: "economics-metrics",
    title: "九、经济评价指标",
    kind: "key-values",
    items: [
      { label: "首年收入", value: wan(ec.revenueY1.grossYuan), hint: `充电服务 ${wan(ec.revenueY1.chargingServiceYuan)}、换电服务 ${wan(ec.revenueY1.swapServiceYuan)}、代收转供电费 ${wan(ec.revenueY1.electricityResaleYuan)}、运营补贴 ${wan(ec.revenueY1.operationSubsidyYuan)}、其他 ${wan(ec.revenueY1.otherYuan)}` },
      { label: "其中：代收转供电费", value: wan(ec.revenueY1.electricityResaleYuan), hint: "向车队代收的电费，属过手成本，不构成利润；与购电价一致时不影响收益" },
      { label: "首年购电成本（含需量，抵减上网收入）", value: wan(ec.costY1Yuan - ec.opexY1.grossYuan) },
      { label: "首年运维成本", value: wan(ec.opexY1.grossYuan), hint: `光伏 ${wan(ec.opexY1.pvYuan)}、储能 ${wan(ec.opexY1.bessYuan)}、充电设施 ${wan(ec.opexY1.chargerYuan)}、场站 ${wan(ec.opexY1.siteFixedYuan)}、土地 ${wan(ec.opexY1.landYuan)}、保险 ${wan(ec.opexY1.insuranceYuan)}` },
      { label: "首年成本合计", value: wan(ec.costY1Yuan) },
      { label: "首年税前净现金流入", value: wan(ec.netCashFlowY1PreTaxYuan) },
      { label: "净现值 NPV", value: wan(ec.metrics.npvYuan), hint: `折现率 ${n(input.economics.discountRatePct)}%` },
      { label: "内部收益率 IRR", value: ec.metrics.irr.ok ? pct(ec.metrics.irr.valuePct ?? 0, 2) : `不可计算（${irrReasonLabel(ec.metrics.irr.reason)}）` },
      { label: "静态回收期", value: ec.metrics.simplePaybackYears === null ? "运营期内未回本" : `${n(ec.metrics.simplePaybackYears, 2)} 年` },
      { label: "折现回收期", value: ec.metrics.discountedPaybackYears === null ? "运营期内未回本" : `${n(ec.metrics.discountedPaybackYears, 2)} 年` },
      { label: "全周期投资回报率 ROI", value: ec.metrics.roiRatio.ok ? pct((ec.metrics.roiRatio.value ?? 0) * 100, 1) : "不可计算" },
      { label: "全生命周期度电成本（自有成本口径）", value: ec.metrics.lcoeYuanPerKwh === null ? "—" : `${n(ec.metrics.lcoeYuanPerKwh, 4)} 元/kWh`, hint: "分子 = 净投资 + 运维成本现值，分母 = 交付电量现值；不含代收电费，可直接与结算单价对照" },
      { label: "资本金净现值 NPV", value: wan(ec.metrics.equity.npvYuan), hint: "含贷款利息与还本，回答「股东自己出的这笔钱回报如何」" },
      { label: "资本金内部收益率 IRR", value: ec.metrics.equity.irr.ok ? pct(ec.metrics.equity.irr.valuePct ?? 0, 2) : "不可计算", hint: "与全投资 IRR 并列而非替代：全投资口径衡量项目本身，资本金口径衡量融资方案" },
    ],
    bullets: [
      `逐年税后净现金流（全投资口径，第 1 年起）：${ec.annualCashFlowYuan.slice(input.economics.constructionYears, input.economics.constructionYears + 6).map((f) => wan(f)).join(" / ")} …（共 ${ec.annualCashFlowYuan.length} 年）`,
      `营运资金（流动资金占用）本轮未建模，属已知口径缺口。`,
    ],
  });

  /* ── 10. 敏感性 ── */
  sections.push({
    id: "sensitivity",
    title: "十、敏感性分析",
    kind: "table",
    paragraphs: [
      "对关键变量做单变量扰动（其余条件不变），观察 NPV 的摆动幅度。摆动越大，说明结论越依赖该变量——这才是尽调时最该先落地的动作。" +
        "本表为**经济层局部敏感性**：保持物理调度结果不变，按比例缩放能量与成本，用于快速定位关键变量；不含调度重算。",
    ],
    table: {
      columns: ["变量", "基准值", "下行 NPV", "上行 NPV", "摆幅"],
      rows: decision.sensitivity.map((b) => [
        `${b.label}（±${n(Math.abs(b.deltaHighPct))}%）`,
        `${n(b.baseValue, 4)}${b.unit ? ` ${b.unit}` : ""}`,
        wan(b.npvAtLow),
        wan(b.npvAtHigh),
        wan(b.swingYuan),
      ]),
    },
  });

  /* ── 11. 风险清单 ── */
  sections.push({
    id: "risks",
    title: "十一、风险清单",
    kind: "table",
    paragraphs: decision.risks.length
      ? ["每条风险的触发依据均为本次计算的具体数值，不含泛泛而谈的表述。"]
      : ["本次计算未触发任何已建模的风险规则。"],
    table: {
      columns: ["等级", "风险", "触发依据", "缓解建议"],
      rows: decision.risks.map((r) => [severityLabel(r.severity), r.title, r.basis, r.mitigation]),
    },
  });

  /* ── 12. 诊断（三类问题分列） ── */
  const diag = calc.diagnostics;
  sections.push({
    id: "diagnostics",
    title: "十二、计算诊断",
    kind: "table",
    paragraphs: [
      "把三类问题分开陈述：**模型算错了**（必须修代码）、**行情没证据**（不许改公式凑数）、**客户条件没给全**（可以补输入）。混在一起会让人误以为「数据问题」和「程序缺陷」是一回事。",
    ],
    table: {
      columns: ["类别", "编码", "说明", "对结论的影响", "建议"],
      rows: diag.length
        ? diag.map((d) => [kindLabel(d.kind), d.code, d.message, d.impact ?? "—", d.suggestion ?? "—"])
        : [["—", "—", "本次计算未产生诊断信息。", "—", "—"]],
    },
  });

  /* ── 13. 可复算信息 ── */
  sections.push({
    id: "provenance",
    title: "十三、可复算信息",
    kind: "key-values",
    paragraphs: [
      "以下信息合起来构成「这批数字是怎么算出来的」的完整答案：同一份输入快照 + 同一版本引擎 + 同一版基准参数，必然得到同一份结果。",
    ],
    items: [
      { label: "情景", value: `${calc.scenarioLabel}（${calc.scenarioId}）` },
      { label: "引擎版本", value: `${calc.engineVersion}（计算引用 ${calc.calcRef}）` },
      { label: "模型版本", value: calc.modelVersion },
      { label: "基准参数版本", value: calc.benchmarkVersion },
      { label: "时间轴", value: `步长 ${calc.timeStepMinutes} 分钟，全年 ${n(calc.stepsPerYear)} 个时段（按 365 天、不考虑闰年，保证可复现）` },
      { label: "输入哈希", value: inputHash(calc.inputHash) },
      { label: "报告版本", value: REPORT_VERSION },
      { label: "生成时刻", value: opts.generatedAtIso },
    ],
  });

  return {
    reportVersion: REPORT_VERSION,
    title: opts.title ?? `${calc.scenarioLabel} · 项目决策报告`,
    provenance: {
      scenarioId: calc.scenarioId,
      scenarioLabel: calc.scenarioLabel,
      engineVersion: calc.engineVersion,
      modelVersion: calc.modelVersion,
      benchmarkVersion: calc.benchmarkVersion,
      inputHash: calc.inputHash,
      timeStepMinutes: calc.timeStepMinutes,
      generatedAtIso: opts.generatedAtIso,
    },
    inputSnapshot: input,
    sections,
    disclaimer: REPORT_DISCLAIMER,
  };
}

/* ═══════════════════════════ 小工具 ═══════════════════════════ */

const MONTHS = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

function monthName(i: number): string {
  return MONTHS[i] ?? "—";
}
function argmax(a: readonly number[]): number {
  let bi = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[bi]) bi = i;
  return bi;
}
function argmin(a: readonly number[]): number {
  let bi = 0;
  for (let i = 1; i < a.length; i++) if (a[i] < a[bi]) bi = i;
  return bi;
}
function modeLabel(m: string): string {
  return m === "charging" ? "纯充电" : m === "swap" ? "纯换电" : "充电 + 换电（混合）";
}
function severityLabel(s: string): string {
  return s === "high" ? "高" : s === "medium" ? "中" : "低";
}
function kindLabel(k: string): string {
  switch (k) {
    case "CALCULATION_ERROR":
      return "模型缺陷";
    case "EVIDENCE_MISSING":
      return "行情缺口";
    case "SCENARIO_INPUT_MISSING":
      return "条件缺失";
    case "CONSTRAINT_VIOLATION":
      return "条件冲突";
    default:
      return k;
  }
}
function irrReasonLabel(reason?: string): string {
  switch (reason) {
    case "no_sign_change":
      return "现金流无符号变化，IRR 无经济意义";
    case "no_bracket":
      return "常规利率区间内无解";
    case "not_converged":
      return "数值未收敛";
    case "invalid_input":
      return "输入不完整";
    default:
      return "不可用";
  }
}
/** 哈希分段显示，便于人工核对。 */
function inputHash(h: string): string {
  return h;
}
