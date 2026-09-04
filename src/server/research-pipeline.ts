import { z } from "zod";
import {
  runTask,
  type CallRecord,
  type CallRecorder,
  type ChatProvider,
  type ModelTaskKind,
  type ModelTier,
} from "@/server/model-router";

/**
 * §33 多角色研究流水线（Phase 9 M2 骨架，纯逻辑 · **无 DB 依赖** · server 域逻辑）。
 *
 * 为什么存在（宪法「AI 是产业研究系统非内容生成器」「高价值方案须走 Research→Bull→Bear→Judge→QA
 *   多角色，禁止单模型直出最终方案作为生产流程」「结论须区分 事实/假设/推断/预测」「AI 做大量劳动、
 *   人做关键决策」，总控 §33）：单个模型一次直出的"最终方案"既不可信也不合规——它会把推断/预测包装成
 *   事实、缺乏反方证据、无人工把关。本模块把这条**强制的多角色对抗式研究流程**落成可复算的程序契约：
 *   ① 每个角色都必须产经 Zod 校验的**结构化 JSON**（§17），任一环校验失败或 provider 报错就**诚实早退**
 *   （绝不编造下一环输入、绝不半渲染脏结论）；② QA 是**门禁**而非走过场——未达阈值 / 未批准 / 标记需人工
 *   复核时，流水线返回 `needs_human_review`（一个"暂缓、待人裁决"的非终态），**绝不静默放行成 `complete`**；
 *   ③ 全程复用 Phase 9 M1 的 `runTask`（provider 解耦、成本记录），每角色打 `agent` 标签、透传 caseId /
 *   solutionId，末尾聚合整条链的**程序计算成本**（§31），供上层成本看板按方案/案例归因。
 *
 * M2 骨架的刻意边界（宪法「V1 只做核心闭环、能简单就简单、禁止提前把系统做复杂」+ 阻塞 ROADMAP #4）：
 *   - **不接真实模型也能跑满契约**：全部角色调用走 `runTask`，离线用 M1 的确定性 `StubProvider` + 逐角色
 *     `fixtures`（透传成 `respondWith`）即可把五段流程 + schema 校验 + QA 门控 + 成本聚合**测死**；真实供应商
 *     到位只需注入实现 `ChatProvider` 的类，本模块一行不改（真实 provider 忽略 `respondWith`/`fixtures`）。
 *   - **不落库、不出 HTTP、不出 UI**：方案/案例的持久化、后台呈现属后续里程碑；这里只立"编排契约"，
 *     与 `scoring.ts`、`model-router.ts` 同构（纯函数 + 判别联合）。**不投机建 `SolutionDraft` 等表**。
 *   - 各角色 schema、`DEFAULT_ROLE_TIERS`、`DEFAULT_QA_THRESHOLD` 均为**本项目 v1 设计假设**（宪法第 6/7 条：
 *     假设可标注、可调、可复算）；调整须升 `PIPELINE_VERSION` 并说明原因（第 13 条版本化，支持回滚）。
 *   - 本文件按 server 域逻辑对待（**本仓约定不 `import "server-only"`**，vitest/纯 node 下会抛错）。
 */

/* ─────────────────────────── 版本 & 角色定义（§33 固定序） ─────────────────────────── */

/** 流水线契约版本（改角色顺序 / schema / 阈值 / 返回结构须升版本并记录原因，可回滚）。 */
export const PIPELINE_VERSION = "1.0.0";

/**
 * 角色顺序——逐字对齐总控 §33：研究 → 找支持证据（bull）→ 找推翻证据（bear）→ 裁决（judge）→ 质检门禁（qa）。
 * 顺序即"证据先正反两面充分展开、再裁决、最后独立质检把关"的对抗式结构，不可打乱、不可跳步。
 */
export const PIPELINE_ROLES = ["research", "bull", "bear", "judge", "qa"] as const;
export type PipelineRole = (typeof PIPELINE_ROLES)[number];

/**
 * 角色 → (任务类型, 层级) 的默认映射（**v1 设计假设**，§32「不要所有任务都用最贵模型」）。
 * research 与 judge 是"复杂研究 / 核心判断"→ high；bull / bear / qa 是结构化取证 / 质检 → medium。
 * 可被 `PipelineDeps.tierOverrides` 逐角色覆写（真实供应商定价/能力确认后调优）。
 */
export const DEFAULT_ROLE_TASKKIND: Record<PipelineRole, ModelTaskKind> = {
  research: "research",
  bull: "structured_output",
  bear: "structured_output",
  judge: "structured_output",
  qa: "structured_output",
};
export const DEFAULT_ROLE_TIERS: Record<PipelineRole, ModelTier> = {
  research: "high",
  bull: "medium",
  bear: "medium",
  judge: "high",
  qa: "medium",
};

/** QA 放行阈值（v1 假设）：`qualityScore` 低于此值即判 `needs_human_review`，绝不自动放行。 */
export const DEFAULT_QA_THRESHOLD = 70;

/* ─────────────────────────── 各角色输出 schema（§17 结构化中间格式） ─────────────────────────── */

/** 四类结论标签——呼应宪法「区分 事实 / 假设 / 推断 / 预测」，禁把推断/预测包装成事实。 */
export const EVIDENCE_KINDS = ["FACT", "ASSUMPTION", "INFERENCE", "PREDICTION"] as const;

const confidenceInt = z.number().int().min(0).max(100);

export const researchSchema = z.object({
  summary: z.string().min(1),
  // findings 允许为空（诚实：确实没查到就不硬凑），但 summary 必须非空。
  findings: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidenceKind: z.enum(EVIDENCE_KINDS),
        confidence: confidenceInt,
      }),
    )
    .default([]),
});
export type ResearchOutput = z.infer<typeof researchSchema>;

export const bullSchema = z.object({
  // 正方：找支持证据。允许 points 为空（诚实：没有支持证据就如实说没有，不编造）。
  points: z
    .array(
      z.object({
        claim: z.string().min(1),
        evidence: z.string().min(1),
        strength: confidenceInt,
      }),
    )
    .default([]),
});
export type BullOutput = z.infer<typeof bullSchema>;

export const bearSchema = z.object({
  // 反方：找推翻证据。允许 points 为空（诚实：找不到反证也如实记录，不为凑数编造风险）。
  points: z
    .array(
      z.object({
        claim: z.string().min(1),
        evidence: z.string().min(1),
        severity: confidenceInt,
      }),
    )
    .default([]),
});
export type BearOutput = z.infer<typeof bearSchema>;

export const judgeSchema = z.object({
  verdict: z.enum(["supported", "mixed", "weakened"]),
  rationale: z.string().min(1),
  confidence: confidenceInt,
});
export type JudgeOutput = z.infer<typeof judgeSchema>;

export const qaSchema = z.object({
  approved: z.boolean(),
  qualityScore: confidenceInt,
  needsHumanReview: z.boolean(),
  issues: z.array(z.string()).default([]),
});
export type QAOutput = z.infer<typeof qaSchema>;

const ROLE_SCHEMA: Record<PipelineRole, z.ZodTypeAny> = {
  research: researchSchema,
  bull: bullSchema,
  bear: bearSchema,
  judge: judgeSchema,
  qa: qaSchema,
};

/* ─────────────────────────── 入参 & 依赖 ─────────────────────────── */

export interface PipelineInput {
  /** 待评估的研究问题 / 候选方案主张。 */
  question: string;
  /** 成本归因（§31 每案例/每方案看板；透传进每次 CallRecord）。 */
  caseId?: string;
  solutionId?: string;
}

export interface PipelineDeps {
  provider?: ChatProvider;
  recorder?: CallRecorder;
  /**
   * 离线确定性回放（仅对 `StubProvider` 生效，真实 provider 忽略）：逐角色给定期望结构化输出，
   * 透传成 `runTask.respondWith`。让全套契约在无 API Key 下可复算测试（阻塞 #4 未解时亦能测死流程）。
   */
  fixtures?: Partial<Record<PipelineRole, unknown>>;
  /** 逐角色覆写层级（真实供应商能力/定价确认后调优）。 */
  tierOverrides?: Partial<Record<PipelineRole, ModelTier>>;
  /** QA 放行阈值覆盖（默认 `DEFAULT_QA_THRESHOLD`）。 */
  qaThreshold?: number;
}

/* ─────────────────────────── 结果（判别联合） ─────────────────────────── */

export interface PipelineOutputs {
  research?: ResearchOutput;
  bull?: BullOutput;
  bear?: BearOutput;
  judge?: JudgeOutput;
  qa?: QAOutput;
}

export interface PipelineCost {
  /** 本条流水线实际产生的角色调用次数（早退时 < 5）。 */
  calls: number;
  /** 程序计算的整条链估算成本（USD，≤6 位小数），供按方案/案例归因（§31）。 */
  totalCostUsd: number;
}

export interface PipelineRunMeta {
  outputs: PipelineOutputs;
  callRecords: CallRecord[];
  cost: PipelineCost;
  /** 本次实际生效的逐角色层级（含覆写后）。 */
  roleTiers: Record<PipelineRole, ModelTier>;
}

export type PipelineResult =
  /** QA 门禁通过：可作为"经多角色研究 + 人工可复核"的成果交付。 */
  | ({ status: "complete" } & PipelineRunMeta)
  /** QA 未批准 / 低于阈值 / 标记需人工：暂缓、待关键决策，**非终态、不放行**（宪法「人做关键决策」）。 */
  | ({ status: "needs_human_review"; reason: string } & PipelineRunMeta)
  /** 某角色 provider 报错或输出不过 schema：**诚实早退**，保留已完成部分与成本记录，绝不编造续跑。 */
  | {
      status: "failed";
      stage: PipelineRole;
      kind: "provider_error" | "schema_invalid";
      message?: string;
      issues?: z.ZodError["issues"];
      outputs: PipelineOutputs;
      callRecords: CallRecord[];
      cost: PipelineCost;
      roleTiers: Record<PipelineRole, ModelTier>;
    };

/* ─────────────────────────── Prompt 构造（确定性：无时钟 / 无随机） ─────────────────────────── */

function roleInstruction(role: PipelineRole): string {
  switch (role) {
    case "research":
      return "你是产业研究员。围绕问题做尽职研究，给出简要综述与若干条区分事实/假设/推断/预测的发现（每条标注 evidenceKind 与 confidence）。只依据问题本身，不臆造未提供的数字。";
    case "bull":
      return "你是多头分析师（正方）。仅从下方已有研究出发，找出支持该主张的证据点（claim+evidence+strength）。若确无支持证据，如实返回空 points，绝不编造。";
    case "bear":
      return "你是空头分析师（反方）。主动寻找能推翻或削弱该主张的证据点（claim+evidence+severity）。若确无反证，如实返回空 points，绝不为凑数编造风险。";
    case "judge":
      return "你是裁判。综合正方与反方证据，给出裁决 verdict(supported|mixed|weakened)、理由 rationale 与整体置信 confidence。不得把推断/预测当已确认事实。";
    case "qa":
      return "你是质检门禁。审查整条研究是否可交付：给出 approved、qualityScore(0-100)、needsHumanReview 与 issues 列表。证据链薄弱、来源存疑或涉高风险领域时应拒绝或要求人工复核。";
  }
}

/** 把已完成角色的结构化输出并入下一角色 prompt，形成可复算、确定性的上下文传递。 */
function buildPrompt(role: PipelineRole, input: PipelineInput, outputs: PipelineOutputs): string {
  const parts = [roleInstruction(role), `问题：${input.question}`];
  if (role !== "research") parts.push(`已有研究摘要：${JSON.stringify(outputs.research ?? null)}`);
  if (role === "judge" || role === "qa") {
    parts.push(`正方证据：${JSON.stringify(outputs.bull ?? null)}`);
    parts.push(`反方证据：${JSON.stringify(outputs.bear ?? null)}`);
  }
  if (role === "qa") parts.push(`裁判裁决：${JSON.stringify(outputs.judge ?? null)}`);
  return parts.join("\n");
}

/* ─────────────────────────── 编排主函数 ─────────────────────────── */

function sumCostUsd(records: CallRecord[]): number {
  return Math.round(records.reduce((s, r) => s + r.estimatedCostUsd, 0) * 1e6) / 1e6;
}

function metaOf(
  outputs: PipelineOutputs,
  callRecords: CallRecord[],
  roleTiers: Record<PipelineRole, ModelTier>,
): PipelineRunMeta {
  return {
    outputs,
    callRecords,
    cost: { calls: callRecords.length, totalCostUsd: sumCostUsd(callRecords) },
    roleTiers,
  };
}

/**
 * 跑一条 §33 多角色流水线。契约（全部经 M1 `runTask`，成本/记录/错误归一不在此重复实现）：
 *   1. 按 `PIPELINE_ROLES` 固定序逐角色调 `runTask`（带各自 Zod schema、层级、`agent=pipeline:<role>`、
 *      caseId/solutionId 归因、离线 `fixtures`→`respondWith`）；
 *   2. 任一角色 `provider_error` / `schema_invalid` → **立即早退 `failed`**（带 stage+kind），已产生的
 *      CallRecord 全部保留（成本可追踪），绝不臆造后续输入；
 *   3. 五段皆 `ok` 后过 **QA 门禁**：`approved=false` 或 `qualityScore < threshold` 或 `needsHumanReview=true`
 *      → `needs_human_review`（暂缓、非终态）；否则 `complete`；
 *   4. 无论何种结局都聚合本链程序计算成本（`cost.totalCostUsd`）供按方案/案例归因（§31）。
 * `runTask` 永不抛裸异常，本函数据此也不抛（编排层无额外可失败步骤）。
 */
export async function runResearchPipeline(
  input: PipelineInput,
  deps: PipelineDeps = {},
): Promise<PipelineResult> {
  const outputs: PipelineOutputs = {};
  const callRecords: CallRecord[] = [];
  const roleTiers: Record<PipelineRole, ModelTier> = { ...DEFAULT_ROLE_TIERS };
  const threshold = deps.qaThreshold ?? DEFAULT_QA_THRESHOLD;

  for (const role of PIPELINE_ROLES) {
    const tier = deps.tierOverrides?.[role] ?? DEFAULT_ROLE_TIERS[role];
    roleTiers[role] = tier;
    const prompt = buildPrompt(role, input, outputs);

    const res = await runTask(
      {
        taskKind: DEFAULT_ROLE_TASKKIND[role],
        prompt,
        schema: ROLE_SCHEMA[role],
        tier,
        respondWith: deps.fixtures?.[role],
        agent: `pipeline:${role}`,
        caseId: input.caseId,
        solutionId: input.solutionId,
      },
      { provider: deps.provider, recorder: deps.recorder },
    );

    callRecords.push(res.record);

    if (res.status === "provider_error") {
      return {
        status: "failed",
        stage: role,
        kind: "provider_error",
        message: res.message,
        ...metaOf(outputs, callRecords, roleTiers),
      };
    }
    if (res.status === "schema_invalid") {
      return {
        status: "failed",
        stage: role,
        kind: "schema_invalid",
        issues: res.issues,
        ...metaOf(outputs, callRecords, roleTiers),
      };
    }

    // ok：把经 schema 校验的 JSON 收进对应槽位（z.infer 类型由 schema 保证）。
    (outputs as Record<PipelineRole, unknown>)[role] = res.output.json;
  }

  const qa = outputs.qa as QAOutput;
  const gateReasons: string[] = [];
  if (!qa.approved) gateReasons.push("QA 未批准（approved=false）");
  if (qa.qualityScore < threshold) gateReasons.push(`质量分 ${qa.qualityScore} 低于放行阈值 ${threshold}`);
  if (qa.needsHumanReview) gateReasons.push("QA 标记需人工复核");

  if (gateReasons.length > 0) {
    return { status: "needs_human_review", reason: gateReasons.join("；"), ...metaOf(outputs, callRecords, roleTiers) };
  }
  return { status: "complete", ...metaOf(outputs, callRecords, roleTiers) };
}
