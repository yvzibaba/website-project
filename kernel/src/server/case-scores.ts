import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  computeCaseScores,
  CaseScoresSchema,
  type CaseScores,
  type EvidenceLike,
} from "@/server/scoring";
import type { EvidenceType } from "@/lib/validation";

const log = logger.child({ module: "server/case-scores" });

/**
 * 评分持久化与复算（Phase 7 M2，server 域逻辑）。
 *
 * 为什么（宪法第 7/13 条）：M1 把评分变成可复算纯函数，但分数仍只是 Case 上手填的标量魔数。
 *   M2 把"输入"与"输出"都落库：`scoreInput`（10 维度原始录入分，人工/Agent 填）是输入，
 *   `scoreBreakdown`（computeCaseScores 的完整输出，含 rubricVersion + 每维度贡献 + 证据明细）是输出，
 *   两个标量 opportunityScore/evidenceConfidence 由本模块从 breakdown 同步写入（便于排序/索引）。
 *   任何时候都能用 `recomputeCaseScores` 从 scoreInput + evidences 重算，假设/权重变了就升 rubricVersion 重跑。
 *
 * 诚实铁律（宪法第 20 条）：没有 scoreInput 的案例**跳过**，绝不反推/编造输入分；
 *   scoreInput 非法（越界/缺维度）→ 返回 invalid + issues，不写库、不静默截断。
 */

export type RecomputeOneResult =
  | { status: "computed"; caseId: string; scores: CaseScores }
  | { status: "skipped"; caseId: string; reason: "no_score_input" }
  | { status: "invalid"; caseId: string; issues: string[] }
  | { status: "not_found"; caseId: string }
  | { status: "error"; caseId: string; error: string };

/** 把 prisma Evidence 行映射成评分内核需要的最小形状。 */
function toEvidenceLike(e: {
  type: string;
  confidence: number | null;
  sourceUrl: string | null;
}): EvidenceLike {
  return {
    type: e.type as EvidenceType,
    confidence: e.confidence,
    sourceUrl: e.sourceUrl,
  };
}

/**
 * 重算单个案例的评分并持久化。
 * 读 scoreInput + evidences → computeCaseScores → CaseScoresSchema 复核 → 写 scoreBreakdown + 两标量。
 */
export async function recomputeCaseScores(caseId: string): Promise<RecomputeOneResult> {
  try {
    const c = await prisma.case.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        scoreInput: true,
        evidences: { select: { type: true, confidence: true, sourceUrl: true } },
      },
    });
    if (!c) return { status: "not_found", caseId };
    if (c.scoreInput == null) return { status: "skipped", caseId, reason: "no_score_input" };

    const evidences = c.evidences.map(toEvidenceLike);
    const scores = computeCaseScores({ opportunity: c.scoreInput, evidences });
    if (!scores.ok) return { status: "invalid", caseId, issues: scores.issues };

    // 入库前用 Zod 复核结构（宪法第 7 条：可追溯；防内核将来改动产出非法形状）
    const parsed = CaseScoresSchema.safeParse(scores);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "_"}: ${i.message}`);
      log.error("recomputeCaseScores: breakdown failed schema check", { caseId, issues });
      return { status: "invalid", caseId, issues };
    }

    await prisma.case.update({
      where: { id: caseId },
      data: {
        scoreBreakdown: parsed.data as unknown as object,
        opportunityScore: parsed.data.opportunityScore,
        evidenceConfidence: parsed.data.evidenceConfidence,
      },
    });
    return { status: "computed", caseId, scores: parsed.data as CaseScores };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("recomputeCaseScores failed", { err, caseId });
    return { status: "error", caseId, error: message };
  }
}

export interface RecomputeAllSummary {
  total: number;
  computed: number;
  skipped: number;
  invalid: number;
  notFound: number;
  error: number;
  /** 逐案例结果（脚本/后台展示用；大库时可改分页）。 */
  results: RecomputeOneResult[];
}

/**
 * 重算全部案例的评分（每日流水线/后台/迁移后校准用）。
 * V1 顺序处理（库小、Neon 冷启动友好）；案例量增大后可改分批并发（宪法第 4 条：够用即可，不提前优化）。
 */
export async function recomputeAllCaseScores(): Promise<RecomputeAllSummary> {
  const rows = await prisma.case.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  const summary: RecomputeAllSummary = {
    total: rows.length,
    computed: 0,
    skipped: 0,
    invalid: 0,
    notFound: 0,
    error: 0,
    results: [],
  };
  for (const r of rows) {
    const res = await recomputeCaseScores(r.id);
    summary.results.push(res);
    switch (res.status) {
      case "computed":
        summary.computed += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "invalid":
        summary.invalid += 1;
        break;
      case "not_found":
        summary.notFound += 1;
        break;
      case "error":
        summary.error += 1;
        break;
    }
  }
  return summary;
}
