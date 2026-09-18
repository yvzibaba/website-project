import { z } from "zod";
import { EvidenceTypeSchema, type EvidenceType } from "@/lib/validation";

/**
 * 案例评分内核（Phase 7 M1，纯函数 · 无 DB 依赖 · server 域逻辑）。
 *
 * 为什么存在（宪法第 7 条：关键数字须来源可追溯 + 公式可复算 + 假设可改，程序计算 > LLM 口算）：
 *   在此之前 `Case.opportunityScore` / `Case.evidenceConfidence` 只是两个手填/种子写入的 `Int?`
 *   魔数，无法复算、无法审计、无法在假设变化时重算。本模块把总控 Prompt §10「案例评分体系」与
 *   DATABASE.md §3 的评分口径落成**可复算程序 + 版本化公式**（见 docs/SCORING_V1.md）。
 *
 * 铁律（总控 §10 / 规则 9）：综合评分 ≠「项目一定成功」。评分只表达"机会相对优先级 + 证据强度"，
 *   必须与 evidenceConfidence、unknownVariableCount 一起呈现，禁止单独拿高分当成功承诺。
 *
 * 设计约定：
 *   - 全部为纯函数 + 判别联合返回（ok:false 带 issues），不抛裸异常、不静默 clamp 越界输入；
 *   - 所有权重/系数集中为导出常量（单一事实源），便于将来统一调参并版本化（宪法第 13 条）；
 *   - 维度权重是**事实**（照抄总控 §10）；证据可信度公式是**本项目的 v1 假设/设计**（总控只给了
 *     示例值未给公式），已在 docs/SCORING_V1.md 明确标注为待校准假设，参数可调。
 */

/* ─────────────────────────── 机会评分（综合价值，100 分制） ─────────────────────────── */

/** 评分公式版本（宪法第 13 条：调权重/改公式必须升版本并记录原因，可回滚）。 */
export const SCORING_RUBRIC_VERSION = "1.0.0";

/**
 * 维度极性：
 *   - positive：得分越高对机会越有利（如商业价值）；贡献 = raw。
 *   - inverse：该维度本身是"负面强度"（竞争越激烈 / 实施越难 → 机会越低）；贡献 = max - raw。
 *     让录入者按直觉填"竞争强度 0=无竞争…5=白热化""实施难度 0=极易…5=极难"，由程序负责反向，
 *     避免人工把方向填反（这是本项目的**设计选择**，见 docs/SCORING_V1.md「假设」）。
 */
export type DimensionPolarity = "positive" | "inverse";

export interface OpportunityDimension {
  key: string;
  label: string;
  max: number;
  polarity: DimensionPolarity;
}

/**
 * 10 个维度与权重（**事实**，照抄总控 Prompt §10 / DATABASE.md §3）。max 之和恰为 100。
 */
export const OPPORTUNITY_DIMENSIONS: readonly OpportunityDimension[] = [
  { key: "commercialValue", label: "商业价值", max: 20, polarity: "positive" },
  { key: "marketDemand", label: "市场需求", max: 15, polarity: "positive" },
  { key: "techMaturity", label: "技术成熟度", max: 15, polarity: "positive" },
  { key: "localizationSpace", label: "中国本土化空间", max: 10, polarity: "positive" },
  { key: "costAdvantage", label: "成本优势", max: 10, polarity: "positive" },
  { key: "replicability", label: "可复制性", max: 10, polarity: "positive" },
  { key: "supplyChainMaturity", label: "供应链成熟度", max: 5, polarity: "positive" },
  { key: "competitionIntensity", label: "竞争强度", max: 5, polarity: "inverse" },
  { key: "policyEnvironment", label: "政策环境", max: 5, polarity: "positive" },
  { key: "implementationDifficulty", label: "实施难度", max: 5, polarity: "inverse" },
] as const;

/** 机会评分满分（= 各维度 max 之和，恒等于 100；用 reduce 计算而非硬编码，防维度改动后失真）。 */
export const OPPORTUNITY_MAX = OPPORTUNITY_DIMENSIONS.reduce((s, d) => s + d.max, 0);

export type OpportunityInput = Record<string, number>;

/** 机会评分入参 Zod schema：10 个维度各为 0..max 的整数（逐维度动态生成，防漏填/越界）。 */
export const OpportunityInputSchema = z.object(
  Object.fromEntries(
    OPPORTUNITY_DIMENSIONS.map((d) => [
      d.key,
      z
        .number({ message: `${d.label} 必须是数字` })
        .int(`${d.label} 必须是整数`)
        .min(0, `${d.label} 不能小于 0`)
        .max(d.max, `${d.label} 不能超过 ${d.max}`),
    ]),
  ) as Record<string, z.ZodTypeAny>,
);

export interface DimensionResult {
  key: string;
  label: string;
  max: number;
  polarity: DimensionPolarity;
  /** 录入的原始分（0..max）。 */
  raw: number;
  /** 对总分的实际贡献（inverse 维度 = max - raw）。 */
  contribution: number;
}

export type OpportunityResult =
  | { ok: true; total: number; max: number; breakdown: DimensionResult[] }
  | { ok: false; issues: string[] };

/**
 * 计算机会评分（综合价值，0..100）。
 * total = Σ contribution，其中 positive 维度 contribution=raw，inverse 维度 contribution=max-raw。
 * 入参非法（缺维度/越界/非整数）→ ok:false + 逐条 issues，绝不静默截断（诚实优先）。
 */
export function computeOpportunityScore(input: unknown): OpportunityResult {
  const parsed = OpportunityInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "_"}: ${i.message}`,
    );
    return { ok: false, issues };
  }
  const data = parsed.data as OpportunityInput;
  const breakdown: DimensionResult[] = OPPORTUNITY_DIMENSIONS.map((d) => {
    const raw = data[d.key];
    const contribution = d.polarity === "inverse" ? d.max - raw : raw;
    return { key: d.key, label: d.label, max: d.max, polarity: d.polarity, raw, contribution };
  });
  const total = breakdown.reduce((s, b) => s + b.contribution, 0);
  return { ok: true, total, max: OPPORTUNITY_MAX, breakdown };
}

/* ─────────────────────────── 证据可信度（Evidence Confidence，0..100） ─────────────────────────── */

/**
 * 证据类型权重（**v1 假设**，总控未给公式）：事实最强、预测最弱，呼应宪法第 6 条对
 * 事实/假设/推断/预测的分层。可调，改动须升 SCORING_RUBRIC_VERSION 并记录于 docs/SCORING_V1.md。
 */
export const EVIDENCE_TYPE_WEIGHTS: Readonly<Record<EvidenceType, number>> = {
  FACT: 1.0,
  ASSUMPTION: 0.5,
  INFERENCE: 0.4,
  PREDICTION: 0.3,
};

/**
 * 证据可信度公式参数（**v1 假设**，集中一处便于调参）：
 *   - unsourcedFactor：无 sourceUrl 的证据打折（无来源的结论更不可信）；
 *   - defaultConfidence：证据未填 confidence 时的缺省可信度（中性偏低）。
 */
export const EVIDENCE_CONFIDENCE_PARAMS = {
  unsourcedFactor: 0.6,
  defaultConfidence: 50,
} as const;

/** 参与证据可信度计算所需的最小证据形状（与 prisma Evidence 兼容，便于直接传入查询结果）。 */
export interface EvidenceLike {
  type: EvidenceType;
  confidence?: number | null;
  sourceUrl?: string | null;
}

export interface EvidenceConfidenceResult {
  /** 0..100 整数；无证据时为 0（诚实：没有证据就没有可信度）。 */
  value: number;
  evidenceCount: number;
  byType: Record<EvidenceType, number>;
  /** 加权分子 Σ(w·q·sourceFactor)，调试/审计用。 */
  weightedNumerator: number;
  /** 权重分母 Σw，调试/审计用。 */
  weightTotal: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 由证据集合计算证据可信度（0..100）。公式（v1）：
 *   每条证据 i：w_i = 类型权重；q_i = clamp(confidence_i ?? 缺省, 0, 100)/100；
 *             sf_i = 有 sourceUrl ? 1 : unsourcedFactor。
 *   value = round( 100 · Σ(w_i·q_i·sf_i) / Σ(w_i) )；证据为空 → 0。
 * 纯函数、可复算；单条证据时类型权重在比值中约掉，value 只由 q·sf 决定（测试覆盖此边界）。
 */
export function computeEvidenceConfidence(
  evidences: readonly EvidenceLike[],
): EvidenceConfidenceResult {
  const byType: Record<EvidenceType, number> = {
    FACT: 0,
    ASSUMPTION: 0,
    INFERENCE: 0,
    PREDICTION: 0,
  };
  let weightedNumerator = 0;
  let weightTotal = 0;

  for (const e of evidences) {
    // 只接受已知类型；未知类型跳过（防御脏数据，不静默当成 FACT）
    if (!EvidenceTypeSchema.safeParse(e.type).success) continue;
    byType[e.type] += 1;
    const w = EVIDENCE_TYPE_WEIGHTS[e.type];
    const rawConf =
      typeof e.confidence === "number" && Number.isFinite(e.confidence)
        ? e.confidence
        : EVIDENCE_CONFIDENCE_PARAMS.defaultConfidence;
    const q = clamp(rawConf, 0, 100) / 100;
    const sf = e.sourceUrl && e.sourceUrl.trim().length > 0 ? 1 : EVIDENCE_CONFIDENCE_PARAMS.unsourcedFactor;
    weightedNumerator += w * q * sf;
    weightTotal += w;
  }

  const evidenceCount = evidences.length;
  const value =
    weightTotal === 0 ? 0 : Math.round((100 * weightedNumerator) / weightTotal);
  return { value, evidenceCount, byType, weightedNumerator, weightTotal };
}

/* ─────────────────────────── 关键未知变量数 ─────────────────────────── */

/**
 * 关键未知变量数 = 非 FACT 证据条数（ASSUMPTION/INFERENCE/PREDICTION 都是"尚未被事实确证"的变量）。
 * 呼应宪法第 6 条：把不确定的东西显式计数、显式暴露，而不是藏进一个综合分里。
 */
export function countKeyUnknowns(evidences: readonly EvidenceLike[]): number {
  return evidences.filter((e) => EvidenceTypeSchema.safeParse(e.type).success && e.type !== "FACT")
    .length;
}

/* ─────────────────────────── 组合：一次算出案例三件套 ─────────────────────────── */

export interface CaseScoresInput {
  opportunity: unknown;
  evidences?: readonly EvidenceLike[];
}

export interface CaseScores {
  ok: boolean;
  rubricVersion: string;
  /** 机会评分 0..100；入参非法时为 null（并附 issues）。 */
  opportunityScore: number | null;
  opportunityMax: number;
  opportunityBreakdown: DimensionResult[] | null;
  /** 证据可信度 0..100（无证据 = 0）。 */
  evidenceConfidence: number;
  evidenceCount: number;
  evidenceByType: Record<EvidenceType, number>;
  /** 关键未知变量数（非 FACT 证据条数）。 */
  unknownVariableCount: number;
  issues: string[];
}

/**
 * 一次性计算案例的三件套：机会评分 + 证据可信度 + 关键未知变量数（总控 §10 的输出契约）。
 * 机会评分非法不影响证据两项照常计算（各自独立），ok 只反映机会评分是否有效。
 */
export function computeCaseScores({ opportunity, evidences = [] }: CaseScoresInput): CaseScores {
  const opp = computeOpportunityScore(opportunity);
  const conf = computeEvidenceConfidence(evidences);
  const unknowns = countKeyUnknowns(evidences);
  return {
    ok: opp.ok,
    rubricVersion: SCORING_RUBRIC_VERSION,
    opportunityScore: opp.ok ? opp.total : null,
    opportunityMax: OPPORTUNITY_MAX,
    opportunityBreakdown: opp.ok ? opp.breakdown : null,
    evidenceConfidence: conf.value,
    evidenceCount: conf.evidenceCount,
    evidenceByType: conf.byType,
    unknownVariableCount: unknowns,
    issues: opp.ok ? [] : opp.issues,
  };
}

/** 评分结果 Zod schema（供 M2 持久化 Case.scoreBreakdown 时校验入库结构，宪法第 7 条可追溯）。 */
export const CaseScoresSchema = z.object({
  ok: z.boolean(),
  rubricVersion: z.string(),
  opportunityScore: z.number().int().min(0).max(OPPORTUNITY_MAX).nullable(),
  opportunityMax: z.number().int(),
  opportunityBreakdown: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        max: z.number().int(),
        polarity: z.enum(["positive", "inverse"]),
        raw: z.number(),
        contribution: z.number(),
      }),
    )
    .nullable(),
  evidenceConfidence: z.number().int().min(0).max(100),
  evidenceCount: z.number().int().min(0),
  evidenceByType: z.object({
    FACT: z.number().int(),
    ASSUMPTION: z.number().int(),
    INFERENCE: z.number().int(),
    PREDICTION: z.number().int(),
  }),
  unknownVariableCount: z.number().int().min(0),
  issues: z.array(z.string()),
});
