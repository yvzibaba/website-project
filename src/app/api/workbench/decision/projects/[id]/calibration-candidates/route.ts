import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import {
  listProjectCalibrationCandidates,
  detectAndPersistCandidates,
} from "@app/kernel/server/decision-service";
import type { CalibrationStatus } from "@app/kernel/engine/deviation";

/**
 * `/api/workbench/decision/projects/[id]/calibration-candidates` —— 校准候选（分析产出 + 人工复核队列）。
 *
 * GET ：列该项目的校准候选（可 `?status=` 过滤，供「待复核」视图）。纯读，不改任何东西。
 * POST：**检测**该项目存档预测 vs 实测的系统性偏差，并落库为候选（幂等，按 dedupeKey）。
 *        body 可选 `{ scenarioId?, config?:{minSamples?,biasThresholdPct?} }`。
 *
 * 这是「分析」而非「改模」：POST 只往 CalibrationCandidate 一张表写**建议**，
 * 绝不触碰 BENCHMARK / ENGINE / 情景 / 报告；是否据建议改参数，发生在随后的人工审核（PATCH）之后，
 * 且 ACCEPTED 只代表「人已认可该建议」，真正落地改基准仍是另需人工流程（宪法：财务口径留创始人）。
 * 门禁：同源 + 登录 + owner-or-staff。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const ALLOWED_STATUSES = new Set(["CANDIDATE", "UNDER_REVIEW", "ACCEPTED", "REJECTED"]);

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后查看校准候选", 401);

  const { id } = await params;
  const status = new URL(request.url).searchParams.get("status");
  if (status && !ALLOWED_STATUSES.has(status)) {
    return errorResponse("VALIDATION_ERROR", "非法的候选状态过滤值", 400, {
      allowed: [...ALLOWED_STATUSES],
    });
  }
  return mutationResponse(
    await listProjectCalibrationCandidates({
      projectId: id,
      user: actor.user,
      status: (status ?? undefined) as CalibrationStatus | undefined,
    }),
  );
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后检测校准候选", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  const body = (parsed.data ?? {}) as { scenarioId?: string | null; config?: unknown };
  return mutationResponse(
    await detectAndPersistCandidates({
      projectId: id,
      scenarioId: body.scenarioId ?? null,
      user: actor.user,
      config: body.config,
    }),
  );
}
