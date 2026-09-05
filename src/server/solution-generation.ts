import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type { ChatProvider, CallRecorder } from "@/server/model-router";
import {
  runResearchPipeline,
  PIPELINE_VERSION,
  type PipelineResult,
  type PipelineRole,
  type QAOutput,
  type JudgeOutput,
} from "@/server/research-pipeline";
import { createChatProvider } from "@/server/deepseek-provider";
import { SOLUTION_SECTIONS, type SolutionSectionKey } from "@/server/solution-body";
import { updateSolution, type SolutionMutationResult } from "@/server/solution-admin";

/**
 * 方案正文 AI 生成（Phase 8 M3 / 承接 Phase 9 M4，server-only）。
 *
 * 为什么（宪法「AI 是产业研究系统非内容生成器」「高价值方案须走 Research→Bull→Bear→Judge→QA 多角色、
 *   禁止单模型直出最终方案」「结论须区分 事实/假设/推断/预测」「AI 做大量劳动、人做关键决策」「禁止 AI
 *   自动公开发布」）：Phase 9 M1/M2/M3 已把「统一 Model Router + §33 多角色流水线 + 真实 DeepSeek 供应商」
 *   三件套建好并测死，但**至今零调用方**——`runResearchPipeline` / `createChatProvider` 在 src/ 里无人接线。
 *   本模块把这条流水线**接到具体方案生成**（ROADMAP Phase 9 M4 明列的下一步），让「案例 → 产业解决方案」
 *   这一商业闭环关键节点第一次能被真实驱动：跑一条 §33 流水线 → 把五段结构化产出**映射进 `Solution.body`
 *   的 34 分节** → 经既有 `updateSolution` 落库（自动获得 version++ + ChangeLog 审计）。
 *
 * 刻意边界（宪法「V1 只做核心闭环、能简单就简单、禁止提前把系统做复杂」「关键数字须来源可追溯/程序计算」）：
 *   - **绝不自动发布**：本模块永不写 `status=PUBLISHED`。流水线 `complete` 也只落正文，发布仍是人的决策
 *     （走既有 `updateSolution` 的 publishGuard）。对**已发布**方案直接拒绝改写线上正文（返回 blocked）。
 *   - **绝不臆造数字/来源**：§33 流水线只产出研究/正反证据/裁决/质检，**不含**成本模型/ROI/回收期/来源链接。
 *     这些分节**保持空缺**（`parseSolutionBody` 会诚实标「待补充」），映射器只在 `aiAnnotations` 里显式登记
 *     「哪些分节刻意未生成、须程序计算 + 人工补充」——把「AI 没做的事」也透明化（呼应规则 12 结构化完整性、
 *     规则 6/9 不确定性显式列出）。财务测算属 Finance Agent（重要计算必须程序完成）、来源须可追溯，均**不**由
 *     语言模型口算填充，本里程碑刻意不碰。
 *   - **区分事实/假设/推断/预测**：`aiAnnotations` 逐条按 `evidenceKind` 分箱（facts 只计数、assumptions/
 *     inferences/predictions 全量透出 + 附裁判置信与 QA 门禁结果），把「模型说的哪些是猜测」摆到台面上供人复核。
 *   - **provider 解耦、离线可测**：编排器 `generateSolutionContent` 默认注入 `createChatProvider()`（生产有 key
 *     走真实 DeepSeek、无 key 回落确定性 Stub），测试注入 `StubProvider + fixtures` 即可**无网络、无 key**把
 *     整条「流水线 → 映射 → 落库」闭环测死（与 M1/M2/M3 同构）。映射器 `mapPipelineToSolution` 是**纯函数**，
 *     无 DB / 无时钟 / 无随机，可复算。
 *   - 本文件按 server 域逻辑对待（**本仓约定不 `import "server-only"`**，vitest / 纯 node 下会抛错）。
 */

const log = logger.child({ module: "server/solution-generation" });

/* ─────────────────────────── 版本（第 13 条：可回滚、改结构须升版） ─────────────────────────── */

/** 生成契约版本（映射的分节集合 / aiAnnotations 结构 / 落库策略变更须升版并说明原因）。 */
export const SOLUTION_GENERATION_VERSION = "1.0.0";

/** 合法的 body 分节键集（映射器产出的每个键都必须落在此内，防漂移；单测锁死此不变式）。 */
export const SOLUTION_SECTION_KEYS: ReadonlySet<string> = new Set<string>(
  SOLUTION_SECTIONS.map((s) => s.key as SolutionSectionKey),
);

/* ─────────────────────────── 纯映射器：PipelineResult → Solution.body 分节 ─────────────────────────── */

export interface GeneratedSolutionContent {
  /** 仅含流水线能诚实填充的分节（键 ∈ SOLUTION_SECTIONS），绝不臆造其它分节内容。 */
  body: Record<string, unknown>;
  /** 本次实际填了哪些分节（供审计/前端「完成度 n/34」与测试断言）。 */
  filledSectionKeys: string[];
  /** §33 流水线的终态（含 failed——即便失败也保留已完成部分成果，暂缓≠丢失）。 */
  pipelineStatus: "complete" | "needs_human_review" | "failed";
  /** 是否需要人工介入：仅 `complete` 为 false；其余一律 true（人做关键决策）。 */
  needsHumanReview: boolean;
  /** 人工复核/失败原因（complete 时无）。 */
  reviewReason?: string;
  judgeVerdict?: JudgeOutput["verdict"];
  qa?: QAOutput;
  /** 本条流水线程序计算成本（透传自 result.cost，§31 按方案归因）。 */
  cost: { calls: number; totalCostUsd: number };
  /** 派生的关键未知变量条数（非 FACT 研究发现的条数）。 */
  unknownCount: number;
}

/** 与 solution-body.isEmptyValue 同源的「有内容」判定（空串/空数组/空对象/null/undefined 视为无）。 */
function hasContent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
  return true; // number / boolean（含 0 / false）视为有内容
}

/** 把研究发现的非 FACT 条按 evidenceKind 分箱（facts 仅计数）。 */
function partitionFindings(findings: { statement: string; evidenceKind: string; confidence: number }[]) {
  const facts: typeof findings = [];
  const assumptions: typeof findings = [];
  const inferences: typeof findings = [];
  const predictions: typeof findings = [];
  for (const f of findings) {
    if (f.evidenceKind === "FACT") facts.push(f);
    else if (f.evidenceKind === "ASSUMPTION") assumptions.push(f);
    else if (f.evidenceKind === "INFERENCE") inferences.push(f);
    else if (f.evidenceKind === "PREDICTION") predictions.push(f);
  }
  return { facts, assumptions, inferences, predictions };
}

/**
 * 纯函数：把一条 §33 流水线结果映射成方案正文分节 + 审计元数据。**无副作用、无 DB、无时钟/随机**。
 * 契约：
 *   1. 只填 6 类能诚实支撑的分节：bullCase / bearCase / riskAnalysis / unknowns / aiAnnotations（+ 有内容时）。
 *      空 points / 空 findings 的分节**不写**（isEmpty 兜底，不制造空占位噪音）。
 *   2. **绝不**触碰 成本模型/收入模型/ROI/回收期/来源 等分节（流水线无此数据；属程序计算 + 人工溯源范畴）。
 *   3. `failed` 也保留已完成部分（如 research 成功、bull 失败 → 仍透出 unknowns/aiAnnotations），但
 *      `needsHumanReview=true` 且 `reviewReason` 指名失败阶段。
 *   4. 永不产出 `status`（发布与否由人决定）。
 */
export function mapPipelineToSolution(result: PipelineResult): GeneratedSolutionContent {
  const { outputs, cost } = result;
  const body: Record<string, unknown> = {};

  // ── 正方证据（Bull）：有非空 points 才写 ──
  if (outputs.bull && Array.isArray(outputs.bull.points) && outputs.bull.points.length > 0) {
    body.bullCase = outputs.bull.points.map((p) => ({
      claim: p.claim,
      evidence: p.evidence,
      strength: p.strength,
    }));
  }

  // ── 反方证据（Bear）：有非空 points 才写 ──
  if (outputs.bear && Array.isArray(outputs.bear.points) && outputs.bear.points.length > 0) {
    body.bearCase = outputs.bear.points.map((p) => ({
      claim: p.claim,
      evidence: p.evidence,
      severity: p.severity,
    }));
  }

  // ── 风险分析：把反方风险按严重度排序 + 裁判结论一并承载（仅在 bear 或 judge 存在时）──
  if (outputs.bear || outputs.judge) {
    const risks = (outputs.bear?.points ?? [])
      .map((p) => ({ risk: p.claim, severity: p.severity }))
      .sort((a, b) => b.severity - a.severity);
    const riskAnalysis: Record<string, unknown> = { risks };
    if (outputs.judge) {
      riskAnalysis.judgeVerdict = outputs.judge.verdict;
      riskAnalysis.judgeRationale = outputs.judge.rationale;
    }
    if (risks.length > 0 || outputs.judge) body.riskAnalysis = riskAnalysis;
  }

  // ── 关键未知变量：研究发现里所有非 FACT 条（不确定性的显式清单）──
  const findings = outputs.research?.findings ?? [];
  const { facts, assumptions, inferences, predictions } = partitionFindings(findings);
  const unknownItems = [...assumptions, ...inferences, ...predictions].map((f) => ({
    statement: f.statement,
    kind: f.evidenceKind,
    confidence: f.confidence,
  }));
  if (unknownItems.length > 0) body.unknowns = unknownItems;

  // ── AI 假设/推断/预测的明确标注（宪法第 18/12 条：把「模型哪些是猜的」摆到台面 + 登记刻意未生成的分节）──
  if (outputs.research || outputs.judge || outputs.qa) {
    body.aiAnnotations = {
      generationVersion: SOLUTION_GENERATION_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      factualStatementCount: facts.length, // 事实只计数（正文不逐条复述，避免与来源分节混淆）
      assumptions,
      inferences,
      predictions,
      judge: outputs.judge
        ? { verdict: outputs.judge.verdict, confidence: outputs.judge.confidence }
        : undefined,
      qa: outputs.qa
        ? {
            approved: outputs.qa.approved,
            qualityScore: outputs.qa.qualityScore,
            needsHumanReview: outputs.qa.needsHumanReview,
            issues: outputs.qa.issues,
          }
        : undefined,
      // 诚实登记：以下分节**刻意未由本次 AI 生成**——须程序计算 / 人工补充 / 可追溯来源，绝不口算填充。
      notGenerated: [
        "costModel",
        "revenueModel",
        "roi",
        "payback",
        "sensitivity",
        "sources",
      ],
    };
  }

  const filledSectionKeys = Object.keys(body).filter((k) => SOLUTION_SECTION_KEYS.has(k) && hasContent(body[k]));

  const needsHumanReview = result.status !== "complete";
  let reviewReason: string | undefined;
  if (result.status === "needs_human_review") reviewReason = result.reason;
  else if (result.status === "failed") {
    const detail = result.kind === "provider_error" ? result.message : result.issues?.[0]?.message;
    reviewReason = `§33 流水线在阶段 ${result.stage} 失败（${result.kind}）${detail ? `：${detail}` : ""}`;
  }

  return {
    body,
    filledSectionKeys,
    pipelineStatus: result.status,
    needsHumanReview,
    reviewReason,
    judgeVerdict: outputs.judge?.verdict,
    qa: outputs.qa,
    cost: { calls: cost.calls, totalCostUsd: cost.totalCostUsd },
    unknownCount: unknownItems.length,
  };
}

/* ─────────────────────────── 编排器：加载 → 跑流水线 → 映射 → 落库 ─────────────────────────── */

export interface GenerateDeps {
  /** 覆盖 provider（测试注入 StubProvider+fixtures 离线跑；缺省用 createChatProvider()）。 */
  provider?: ChatProvider;
  /** 成本记录器（缺省沿用流水线内部，不落 ModelCall 表属后续里程碑）。 */
  recorder?: CallRecorder;
  /** 离线确定性回放（仅 StubProvider 生效）；真实 provider 忽略。 */
  fixtures?: Partial<Record<PipelineRole, unknown>>;
  /** 覆盖研究问题（缺省由方案标题 + 案例标题确定性派生）。 */
  question?: string;
  /** QA 放行阈值覆写（透传流水线）。 */
  qaThreshold?: number;
  /** 审计标注（写入 ChangeLog.changedBy；缺省 `ai:pipeline`）。 */
  actor?: string;
}

export interface GenerateSolutionResult extends SolutionMutationResult {
  generation?: {
    pipelineStatus: GeneratedSolutionContent["pipelineStatus"];
    needsHumanReview: boolean;
    reviewReason?: string;
    filledSectionKeys: string[];
    unknownCount: number;
    cost: GeneratedSolutionContent["cost"];
    /** 本次实际写入库的分节条数（0 表示无可写内容，未改库）。 */
    wroteSections: number;
  };
}

/** 由方案/案例标题确定性派生研究问题（无时钟/随机，可复算）。 */
function buildQuestion(title: string, caseTitle?: string | null): string {
  const scope = caseTitle ? `（源自案例「${caseTitle}」）` : "";
  return `针对产业解决方案「${title}」${scope}，做多角色尽职研究：技术可行性、关键成本/ROI 假设、中国供应链与本土化落地风险，并给出正反证据与裁决。`;
}

/**
 * 生成方案正文并落库（**永不自动发布**）。流程：
 *   1) 载入方案（含所属案例标题）；不存在 → not_found。
 *   2) **已发布方案拒绝自动改写线上正文** → blocked（须先撤回草稿/复制新草稿，人做关键决策）。
 *   3) 跑一条 §33 流水线（provider 解耦：默认 createChatProvider，测试注入 Stub+fixtures）。
 *   4) 纯映射成 body 分节（诚实：只填能支撑的、不臆造财务/来源）。
 *   5) **合并**进既有 body（保留人工已填分节），经 `updateSolution` 落库（自动 version++ + ChangeLog）。
 *      无任何可写分节时**不改库**，仍回 ok + 成本/状态（诚实：跑了但没产出可写内容）。
 * 全程判别联合返回，不抛裸异常（流水线与 updateSolution 各自已归一错误）。
 */
export async function generateSolutionContent(
  solutionId: string,
  deps: GenerateDeps = {},
): Promise<GenerateSolutionResult> {
  const sol = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: {
      id: true,
      title: true,
      status: true,
      body: true,
      caseId: true,
      case: { select: { title: true } },
    },
  });
  if (!sol) return { status: "not_found", solutionId };

  if (sol.status === "PUBLISHED") {
    log.warn("generation blocked on published solution", { solutionId });
    return {
      status: "blocked",
      solutionId,
      fieldErrors: {
        status: ["方案已发布，AI 生成不自动改写线上正文；请先撤回为草稿或复制新草稿后再生成（人做关键决策）"],
      },
    };
  }

  const question = deps.question?.trim() || buildQuestion(sol.title, sol.case?.title);
  const provider = deps.provider ?? createChatProvider();

  const pipeline = await runResearchPipeline(
    { question, caseId: sol.caseId, solutionId: sol.id },
    { provider, recorder: deps.recorder, fixtures: deps.fixtures, qaThreshold: deps.qaThreshold },
  );

  const gen = mapPipelineToSolution(pipeline);

  // 无任何可诚实填充的分节 → 不改库（但仍透出成本/终态，诚实反映「跑了没产出可写内容」）。
  if (gen.filledSectionKeys.length === 0) {
    log.info("generation produced no writable sections; skipped persist", {
      solutionId,
      pipelineStatus: gen.pipelineStatus,
    });
    return {
      status: "ok",
      solutionId,
      generation: {
        pipelineStatus: gen.pipelineStatus,
        needsHumanReview: gen.needsHumanReview,
        reviewReason: gen.reviewReason,
        filledSectionKeys: gen.filledSectionKeys,
        unknownCount: gen.unknownCount,
        cost: gen.cost,
        wroteSections: 0,
      },
    };
  }

  // 合并：保留人工/历史已填分节，只叠加本次映射的分节（不整体覆盖，宪法「少破坏」）。
  const existingBody =
    sol.body && typeof sol.body === "object" && !Array.isArray(sol.body)
      ? (sol.body as Record<string, unknown>)
      : {};
  const mergedBody = { ...existingBody, ...gen.body };

  const upd = await updateSolution(solutionId, { body: mergedBody }, deps.actor ?? "ai:pipeline");
  if (upd.status !== "ok") return { ...upd };

  log.info("solution content generated", {
    solutionId,
    pipelineStatus: gen.pipelineStatus,
    wroteSections: gen.filledSectionKeys.length,
    costUsd: gen.cost.totalCostUsd,
  });
  return {
    status: "ok",
    solutionId,
    generation: {
      pipelineStatus: gen.pipelineStatus,
      needsHumanReview: gen.needsHumanReview,
      reviewReason: gen.reviewReason,
      filledSectionKeys: gen.filledSectionKeys,
      unknownCount: gen.unknownCount,
      cost: gen.cost,
      wroteSections: gen.filledSectionKeys.length,
    },
  };
}
