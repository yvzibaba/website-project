/**
 * R8 · 上游产业项目池「筛选」纯函数（零依赖 · kernel 白名单内 · 程序算非 LLM 打分）。
 *
 * ## 为什么是这个形状（mandate §九）
 * 明确「不要新造完全不同的评分体系」「输出 Candidate / Reject / Need More Evidence / Ready for
 * Project，**而不是一个漂亮的 AI 分数**」。于是这里是一台**有序的门槛状态机**，逐闸判定 + 留痕，
 * 最终裁决取「**第一个未通过闸门**」所绑定的裁决值；全过 → READY_FOR_PROJECT。
 *
 * 筛选顺序（§九原文）：发现 → 证据 → 参数完整度 → 约束 → 经济性 → 产业价值 → 进入项目池。
 * 复用既有口径概念（证据 kind/confidence、参数完整度、约束、经济性信号、产业价值），
 * 但**不 import 引擎/基准/参数层**（保持内核白名单纯净、且发现期草料不该被当计算真源）。
 *
 * ## 诚实
 * 每个 gate 带人类可读 `reason`；`reasons` 汇总所有未过项，供后台工作区直接展示"还差什么"，
 * 不粉饰、不合并成一个数字。
 */

export const CANDIDATE_SCREENING_VERSION = "1.0.0"; // 1.0.0（R8）：首版有序六闸裁决。

/** 裁决四态（严格对齐 mandate §九输出，不多不少）。 */
export type ScreeningVerdict =
  | "CANDIDATE"
  | "REJECT"
  | "NEED_MORE_EVIDENCE"
  | "READY_FOR_PROJECT";

/** 单个证据项（对齐 CandidateProject.evidence JSONB 形状；这里只声明用到的字段）。 */
export interface ScreeningEvidenceItem {
  kind?: string | null; // FACT | ASSUMPTION | INFERENCE | PREDICTION（复用既有 EvidenceType 语义）
  confidence?: number | null; // 0..100
  sourceUrl?: string | null;
}

/** 严格筛选输入（由 `toScreeningInput` 从草料归一而来，或直接构造以便单测精确复现）。 */
export interface CandidateScreeningInput {
  titlePresent: boolean;
  regionPresent: boolean;
  technologyPresent: boolean;
  /** 证据条目（含 kind/confidence）。 */
  evidence: ScreeningEvidenceItem[];
  /** 关键参数完整度 0..1（发现期"能填的填了多少"）。 */
  paramCompleteness: number;
  /** 硬约束 / 一票否决项（非空即 REJECT，如被禁技术路线、许可证高风险未核、无落地路径）。 */
  disqualifiers: string[];
  /** 是否已有经济性信号（哪怕粗口径）。 */
  hasEconomics: boolean;
  /** 是否已确证产业价值。 */
  industryValuePresent: boolean;
}

/** 单道闸门判定留痕。 */
export interface ScreeningGate {
  key: "DISCOVERY" | "EVIDENCE" | "PARAMS" | "CONSTRAINTS" | "ECONOMICS" | "INDUSTRY_VALUE";
  label: string;
  passed: boolean;
  reason: string;
}

/** 裁决结果。 */
export interface ScreeningOutcome {
  verdict: ScreeningVerdict;
  /** 有序六闸逐条留痕（含通过与否）。 */
  gates: ScreeningGate[];
  /** 所有未过闸门的原因（READY_FOR_PROJECT 时为空数组）。 */
  reasons: string[];
  /** 用到的阈值常量快照（可复算、可追溯，规则 7）。 */
  thresholds: typeof SCREENING_THRESHOLDS;
}

/** 阈值集中定义，命名 + 导出，便于审计与测试钉死（非魔数散落）。 */
export const SCREENING_THRESHOLDS = {
  /** 高置信证据最少条数（confidence >= EVIDENCE_CONF_FLOOR 且 kind 非 ASSUMPTION/PREDICTION 之外仍计入）。 */
  MIN_EVIDENCE_ITEMS: 3,
  /** 计入条目的最低置信度。 */
  EVIDENCE_CONF_FLOOR: 50,
  /** 参数完整度下限（0..1）。 */
  PARAM_COMPLETENESS_FLOOR: 0.6,
} as const;

function clamp01(x: number): number {
  if (typeof x !== "number" || !Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 核心裁决：按 §九 顺序走六闸，取第一个未过闸的绑定裁决；全过 → READY_FOR_PROJECT。
 * 纯函数、不抛错、无副作用（脏输入靠 clamp / 兜底吃成保守值，倾向 NEED_MORE_EVIDENCE 而非误放行）。
 */
export function screenCandidate(input: CandidateScreeningInput): ScreeningOutcome {
  const t = SCREENING_THRESHOLDS;
  const evidence = Array.isArray(input?.evidence) ? input.evidence : [];
  const disqualifiers = Array.isArray(input?.disqualifiers) ? input.disqualifiers.filter(Boolean) : [];
  const paramCompleteness = clamp01(input?.paramCompleteness ?? 0);

  const strongEvidence = evidence.filter(
    (e) => typeof e?.confidence === "number" && Number.isFinite(e.confidence) && e.confidence >= t.EVIDENCE_CONF_FLOOR,
  ).length;

  const gates: ScreeningGate[] = [];
  // 绑定：某闸未过时应判定的裁决。
  let verdict: ScreeningVerdict | null = null;
  const reasons: string[] = [];

  const settle = (g: ScreeningGate, failVerdict: ScreeningVerdict) => {
    gates.push(g);
    if (!g.passed) {
      reasons.push(`${g.label}：${g.reason}`);
      if (verdict === null) verdict = failVerdict; // 只取第一个未过闸
    }
  };

  // ① 发现（DISCOVERY）：标题是底线；缺地区/技术属"还没摸清" → 补证据。
  {
    const passed = input?.titlePresent === true;
    settle(
      {
        key: "DISCOVERY",
        label: "发现",
        passed,
        reason: passed
          ? `基本要素齐（地区${input?.regionPresent ? "✓" : "✗"} / 技术${input?.technologyPresent ? "✓" : "✗"}）`
          : "缺标题，无法识别为一个候选项目",
      },
      "REJECT",
    );
    // title 有但 region/tech 缺 → 记 NEED_MORE_EVIDENCE（不改已定的第一个未过闸逻辑，这里补一道软闸）
    if (passed && (!input?.regionPresent || !input?.technologyPresent)) {
      settle(
        {
          key: "DISCOVERY",
          label: "发现",
          passed: false,
          reason: `缺${!input?.regionPresent ? " 地区" : ""}${!input?.technologyPresent ? " 技术路线" : ""}，发现不完整`,
        },
        "NEED_MORE_EVIDENCE",
      );
    }
  }

  // ② 证据（EVIDENCE）
  settle(
    {
      key: "EVIDENCE",
      label: "证据",
      passed: strongEvidence >= t.MIN_EVIDENCE_ITEMS,
      reason: `高置信证据 ${strongEvidence} 条（需 ≥ ${t.MIN_EVIDENCE_ITEMS}，置信 ≥ ${t.EVIDENCE_CONF_FLOOR}）`,
    },
    "NEED_MORE_EVIDENCE",
  );

  // ③ 参数完整度（PARAMS）
  settle(
    {
      key: "PARAMS",
      label: "参数完整度",
      passed: paramCompleteness >= t.PARAM_COMPLETENESS_FLOOR,
      reason: `完整度 ${(paramCompleteness * 100).toFixed(0)}%（需 ≥ ${t.PARAM_COMPLETENESS_FLOOR * 100}%）`,
    },
    "NEED_MORE_EVIDENCE",
  );

  // ④ 约束（CONSTRAINTS）：硬约束一票否决
  settle(
    {
      key: "CONSTRAINTS",
      label: "约束",
      passed: disqualifiers.length === 0,
      reason: disqualifiers.length === 0 ? "无一票否决项" : `命中否决：${disqualifiers.join("、")}`,
    },
    "REJECT",
  );

  // ⑤ 经济性（ECONOMICS）：缺 → 留在池中观察（不拒、不直接 ready）
  settle(
    {
      key: "ECONOMICS",
      label: "经济性",
      passed: input?.hasEconomics === true,
      reason: input?.hasEconomics ? "已有经济性信号（粗口径亦可）" : "尚无经济性信号，留池观察",
    },
    "CANDIDATE",
  );

  // ⑥ 产业价值（INDUSTRY_VALUE）：缺 → 留在池中
  settle(
    {
      key: "INDUSTRY_VALUE",
      label: "产业价值",
      passed: input?.industryValuePresent === true,
      reason: input?.industryValuePresent ? "已确证产业价值" : "产业价值待确证，留池观察",
    },
    "CANDIDATE",
  );

  const finalVerdict: ScreeningVerdict = verdict ?? "READY_FOR_PROJECT";
  return {
    verdict: finalVerdict,
    gates,
    reasons: finalVerdict === "READY_FOR_PROJECT" ? [] : reasons,
    thresholds: t,
  };
}

/** 归一前的松散草料形状（直接吃 CandidateProject 行的字段，含 JSONB）。 */
export interface CandidateLike {
  title?: string | null;
  region?: string | null;
  technology?: string | null;
  evidence?: unknown; // JSONB 数组
  paramCompleteness?: number | null;
  disqualifiers?: unknown; // string[] | JSONB
  hasEconomics?: boolean | null;
  industryValuePresent?: boolean | null;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * 把 CandidateProject 行（含 JSONB evidence / 松散布尔）归一成严格 `CandidateScreeningInput`。
 * 宽容脏数据：缺字段一律降级为"未满足"，倾向保守（不误放行）。
 */
export function toScreeningInput(c: CandidateLike): CandidateScreeningInput {
  const evidence = asArray<ScreeningEvidenceItem>(c.evidence);
  const disqualifiers = asArray<string>(c.disqualifiers).filter((x) => nonEmpty(x));
  return {
    titlePresent: nonEmpty(c.title),
    regionPresent: nonEmpty(c.region),
    technologyPresent: nonEmpty(c.technology),
    evidence,
    paramCompleteness: typeof c.paramCompleteness === "number" ? c.paramCompleteness : 0,
    disqualifiers,
    hasEconomics: c.hasEconomics === true,
    industryValuePresent: c.industryValuePresent === true,
  };
}

/** 便捷：直接从草料一步出裁决。 */
export function assessCandidate(c: CandidateLike): ScreeningOutcome {
  return screenCandidate(toScreeningInput(c));
}
