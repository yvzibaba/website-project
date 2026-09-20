/**
 * 免登录「免费诊断」（M4 · P5）——把引擎的结论**收敛成一句话倾向 + 明显否证**，
 * 让还没登录、还没建项目的人，也能拿到"这个项目大方向上成不成立"的真判断，
 * 而不是只丢给他一张表单。
 *
 * ## 为什么这决定产品定位（以及为什么它是"漏斗"而不是"玩具"）
 *
 * 决策平台的公开入口如果只有"填表→留联系方式"，那么用户在被说服之前就要先付出，
 * 转化率极低。P5 要求免费层先给出**结论倾向**：能不能算通、硬约束过不过、
 * NPV 是正是负、多久回本、有没有"一眼就该否决"的问题。这些判断全部出自
 * **唯一生产引擎** `runCalculation()`，与登录后保存的项目、生成的报告**同一台机器、同一套公式**。
 * 也就是说：免费诊断给出的数不是"简化估算"，而是真结论的一个切面。
 *
 * ## 三条不妥协
 *
 * 1. **不另写算法**。宪法第 1 条：只有一台引擎。本模块**不实现任何能量/财务计算**，
 *    只是把 `runCalculation()` 的产物（可行性、NPV、回收期、诊断码）投影成一个
 *    对外的"倾向 + 否证"结构。这样"免费看到的数"与"付费保存后算出的数"不可能分叉。
 * 2. **不编造门槛**。判向只用两条客观事实：引擎自己判的 `feasibility.feasible`、
 *    以及全投资 NPV 是否 `> 0`。不引入任何"我觉得 5 年回本算好"这类拍脑袋阈值——
 *    那种阈值既不可追溯，又把主观偏好伪装成模型结论。
 * 3. **诚实标深算边界**。免费层给的是**结论切面**，明确列出被留在付费深算里的东西
 *    （敏感性、逐参数归因、配置寻优、完整报告、假设与风险清单），且**绝不虚构联系方式**。
 *
 * ## 确定性
 *
 * 纯函数：同一输入 → 逐字节相同的输出。不读时钟、不用随机、不含 `elapsedMs`。
 */

import { ENGINE_VERSION, MODEL_VERSION, runCalculation } from "@app/kernel/engine/engine";
import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import { round } from "@app/kernel/server/finance";
import type { CalculationResult, Diagnostic, ScenarioInput } from "@app/kernel/engine/types";

/** 诊断口径版本（改"判向规则 / 否证口径 / 深算边界清单"= 必须升版）。 */
export const DIAGNOSE_VERSION = "1.0.0";

export function diagnoseCalcRef(): string {
  return `diag@${DIAGNOSE_VERSION}`;
}

/* ═══════════════════════════ 输出契约 ═══════════════════════════ */

/**
 * 免费诊断的四档倾向。
 *  - `not_computable` 这套配置在当前模型下算不出可信结果（数据/约束层面的硬问题）。
 *  - `infeasible`     能算，但引擎判定硬约束不满足（例如供电能力不足、约束违背）。
 *  - `borderline`     能算、可行，但全投资 NPV ≤ 0——按当前参数这门生意不划算。
 *  - `promising`      能算、可行、全投资 NPV > 0——大方向为正，值得往下深算。
 */
export type DiagnosisVerdict = "not_computable" | "infeasible" | "borderline" | "promising";

export interface Falsification {
  /** 稳定机读码（来自引擎诊断码；无对应码时用归纳出的 `blocker:<n>`）。 */
  code: string;
  /** 面向用户的中文说明（过公开界面用语规范）。 */
  message: string;
  /** 相关字段路径，便于 UI 定位。 */
  field?: string;
  /** 数值证据（如缺口 kWh / 万元）。 */
  value?: number;
  unit?: string;
  /** 可执行建议。 */
  suggestion?: string;
}

/** 免费层给出的单条判读信号（每条都挂引擎产出的具体数值，不空泛）。 */
export interface DiagnosisSignal {
  label: string;
  detail: string;
  tone: "good" | "attention" | "bad";
}

export interface DiagnosisKeyNumbers {
  /** 引擎硬约束是否通过（算不通时为 null）。 */
  feasible: boolean | null;
  /** 全投资净现值（元；算不通为 null）。 */
  npvYuan: number | null;
  /** NPV 的方向；算不通为 unknown。 */
  npvSign: "positive" | "non_positive" | "unknown";
  /** 静态回收期（年；不可回收或算不通为 null）。 */
  simplePaybackYears: number | null;
  /** 全投资 IRR（%；引擎判不可解或算不通为 null）。 */
  irrPct: number | null;
  /** 净资本支出（元；算不通为 null）。 */
  capexNetYuan: number | null;
  /** 充电未满足能量（kWh/年；> 0 是"配置装不下"的硬否证；算不通为 null）。 */
  unservedEnergyKwh: number | null;
}

export interface DiagnosisOutcome {
  /** 诊断本身总能成形（算不通也是一种结论），故恒为 true。 */
  ok: true;
  diagnoseRef: string;
  engineVersion: string;
  modelVersion: string;
  benchmarkVersion: string;
  /** 输入内容指纹——与"按同一输入保存项目后算出的结果"逐位可比。 */
  inputHash: string;

  verdict: DiagnosisVerdict;
  verdictLabel: string;
  /** 一句话结论倾向（程序生成，非 LLM）。 */
  headline: string;

  keyNumbers: DiagnosisKeyNumbers;
  /** 明显否证：一眼就该否决 / 必须先解决的问题。空数组 = 无硬否证。 */
  falsifications: Falsification[];
  /** 免费层的少数几条判读。 */
  signals: DiagnosisSignal[];
  /** 诚实披露：哪些深算被留在付费/登录之后（避免用户以为免费层就是全貌）。 */
  deepWorkWithheld: string[];
  /** 走向下一步的一句话出口（不含任何虚构联系方式）。 */
  paidNextStep: string;
  /** 结论可信度说明：基准多为 ASSUMPTION，需人工核实。 */
  confidenceNote: string;
  /** 恒为 true：任何结论都需专业人工确认（诚实边界）。 */
  needsProfessionalReview: true;
}

/* ═══════════════════════════ 内部工具 ═══════════════════════════ */

/** 把引擎诊断里的"硬否证"（约束违背）挑出来，映射成对外的否证条目。 */
function falsificationsFromDiagnostics(diagnostics: Diagnostic[]): Falsification[] {
  return diagnostics
    .filter((d) => d.kind === "CONSTRAINT_VIOLATION" || d.kind === "CALCULATION_ERROR")
    .map((d) => ({
      code: d.code,
      message: d.message,
      ...(d.field ? { field: d.field } : {}),
      ...(typeof d.value === "number" ? { value: d.value } : {}),
      ...(d.unit ? { unit: d.unit } : {}),
      ...(d.suggestion ? { suggestion: d.suggestion } : {}),
    }));
}

const VERDICT_LABEL: Record<DiagnosisVerdict, string> = {
  not_computable: "算不出可信结果",
  infeasible: "当前配置不成立（有硬约束没过）",
  borderline: "能成立，但按当前参数不划算",
  promising: "大方向为正，值得往下深算",
};

/* ═══════════════════════════ 主函数 ═══════════════════════════ */

/**
 * 对一份情景输入做免费诊断（**只读输入、只算不存**）。
 *
 * 输入必须是与计算/落库/推荐**同一个 `ScenarioInput` 契约**——本模块不接受"简化版输入"，
 * 否则免费层与付费层会走两套校验，迟早出现"免费说可行、保存后不可行"的分裂。
 */
export function diagnoseScenario(input: ScenarioInput): DiagnosisOutcome {
  const base = {
    ok: true as const,
    diagnoseRef: diagnoseCalcRef(),
    engineVersion: ENGINE_VERSION,
    modelVersion: MODEL_VERSION,
    benchmarkVersion: BENCHMARK_VERSION,
    needsProfessionalReview: true as const,
    deepWorkWithheld: [
      "敏感性龙卷风（哪个变量一动，结论就翻）",
      "逐参数差异归因（每一块钱 NPV 来自哪一处配置）",
      "自动配置寻优（在上千套配置里找最优并解释落选原因）",
      "完整多段决策报告与可导出文档",
      "需人工核实的关键假设清单与风险登记",
    ],
  };

  const calc = runCalculation(input);

  /* ── 算不通：这本身就是最硬的否证，如实给出，绝不粉饰成"还行" ── */
  if (!calc.ok) {
    const falsifications = falsificationsFromDiagnostics(calc.diagnostics);
    // 引擎失败时 diagnostics 未必含 CONSTRAINT_VIOLATION；把失败原因本身也记为一条否证，
    // 保证"算不出可信结果"永远有可读的理由，而不是空白。
    if (falsifications.length === 0) {
      falsifications.push({
        code: `calc_failed:${calc.reason}`,
        message: calc.detail,
      });
    }
    return {
      ...base,
      // 算不通时引擎不产出可复算的输入指纹，这里如实留空（UI 显示「—」），绝不拿 calcRef 冒充哈希。
      inputHash: "",
      verdict: "not_computable",
      verdictLabel: VERDICT_LABEL.not_computable,
      headline: "这套配置在当前模型下算不出可信结果——先解决下面这些硬问题，再谈回报。",
      keyNumbers: {
        feasible: null,
        npvYuan: null,
        npvSign: "unknown",
        simplePaybackYears: null,
        irrPct: null,
        capexNetYuan: null,
        unservedEnergyKwh: null,
      },
      falsifications,
      signals: [
        {
          label: "计算状态",
          detail: `引擎未能算出可信结果（原因：${calc.reason}）。`,
          tone: "bad",
        },
      ],
      paidNextStep: "把输入补全（尤其是服务费、车队规模、充电窗口与并网容量）后重算，再考虑存为项目做完整决策。",
      confidenceNote: "未能计算，暂无结论可评价。",
    };
  }

  /* ── 算得通：从引擎产物投影结论倾向，不重新算任何东西 ── */
  const c: CalculationResult = calc;
  const feas = c.decision.feasibility;
  const m = c.economics.metrics;
  const npv = m.npvYuan;
  const payback = m.simplePaybackYears;
  const irr = m.irr.ok ? (m.irr.valuePct ?? null) : null;
  const capexNet = c.economics.capex.netYuan;
  const unserved = c.charging.unservedEnergyKwh;

  /* 明显否证：约束违背 + 可行性 blockers + "装不下"（未满足能量 > 0）。 */
  const falsifications = falsificationsFromDiagnostics(c.diagnostics);
  for (const b of feas.blockers) {
    falsifications.push({
      code: `blocker:${falsifications.length}`,
      message: b,
    });
  }
  if (unserved > 1e-6) {
    falsifications.push({
      code: "charging_unserved_energy",
      message: `按当前充电配置，每年约有 ${round(unserved, 0).toLocaleString("zh-CN")} kWh 的电充不进去，车队需求没被满足。`,
      value: round(unserved, 0),
      unit: "kWh/年",
      suggestion: "增加充电桩数量或功率、延长充电窗口，或复核单车日里程与周转时间。",
    });
  }

  const verdict: DiagnosisVerdict = !feas.feasible ? "infeasible" : npv > 0 ? "promising" : "borderline";

  const headline = buildHeadline(verdict, { npv, payback, irr });

  const signals: DiagnosisSignal[] = [];
  signals.push({
    label: "硬约束",
    detail: feas.feasible
      ? "引擎判定的可行性硬约束全部通过。"
      : `有 ${feas.blockers.length} 项硬约束未通过，当前配置不成立。`,
    tone: feas.feasible ? "good" : "bad",
  });
  signals.push({
    label: "全投资净现值 NPV",
    detail:
      npv > 0
        ? `为正（约 ${round(npv / 1e4, 1).toLocaleString("zh-CN")} 万元），按当前参数这门生意创造价值。`
        : `不大于零（约 ${round(npv / 1e4, 1).toLocaleString("zh-CN")} 万元），按当前参数这门生意不划算。`,
    tone: npv > 0 ? "good" : "bad",
  });
  if (payback != null) {
    // 不给回收期安"好坏阈值"——那是主观偏好，会伪装成模型结论。中性陈述，tone 走 attention。
    signals.push({
      label: "静态回收期",
      detail: `约 ${payback.toFixed(1)} 年收回全部投资。`,
      tone: "attention",
    });
  } else {
    signals.push({
      label: "静态回收期",
      detail: "在项目期内未收回投资（回收期不可用）。",
      tone: "attention",
    });
  }
  if (irr != null) {
    signals.push({
      label: "全投资 IRR",
      detail: `约 ${round(irr, 2)}%。`,
      tone: "attention",
    });
  }

  return {
    ...base,
    inputHash: c.inputHash,
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    headline,
    keyNumbers: {
      feasible: feas.feasible,
      npvYuan: round(npv, 0),
      npvSign: npv > 0 ? "positive" : "non_positive",
      simplePaybackYears: payback,
      irrPct: irr == null ? null : round(irr, 2),
      capexNetYuan: round(capexNet, 0),
      unservedEnergyKwh: round(unserved, 0),
    },
    falsifications,
    signals,
    paidNextStep: buildPaidNextStep(verdict),
    confidenceNote:
      "本结论基于山西重卡默认基准（多为待核实的假设 ASSUMPTION），仅供方向判断；" +
      "签约、投资、放款前必须以真实合同价与本地电价逐项复核。",
  };
}

/* ═══════════════════════════ 文案生成（程序拼装，非 LLM） ═══════════════════════════ */

function buildHeadline(
  verdict: DiagnosisVerdict,
  n: { npv: number; payback: number | null; irr: number | null },
): string {
  const wan = round(n.npv / 1e4, 1).toLocaleString("zh-CN");
  const pb = n.payback == null ? "项目期内未回本" : `约 ${n.payback.toFixed(1)} 年回本`;
  switch (verdict) {
    case "promising":
      return `方向为正：硬约束通过，全投资 NPV 约 ${wan} 万元，${pb}。值得存成项目做完整决策。`;
    case "borderline":
      return `能成立但不划算：硬约束通过，而全投资 NPV 约 ${wan} 万元（不大于零），${pb}。需要调整配置或价格才谈得上回报。`;
    case "infeasible":
      return `当前配置不成立：有硬约束未通过，先解决"能不能建成/供得上"，再算回报。`;
    case "not_computable":
    default:
      return "算不出可信结果，请先补全输入。";
  }
}

function buildPaidNextStep(verdict: DiagnosisVerdict): string {
  if (verdict === "promising") {
    return "把这套配置存成项目，即可解锁自动寻优、逐参数归因与完整决策报告。";
  }
  if (verdict === "borderline") {
    return "存成项目后用敏感性分析与配置寻优，看调哪几处能让 NPV 转正、以及值不值得调。";
  }
  return "存成项目后逐项核对约束与需求输入，再用自动寻优找出让硬约束过关的配置。";
}
