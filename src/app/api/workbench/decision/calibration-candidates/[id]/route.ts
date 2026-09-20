import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { reviewCandidate } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/calibration-candidates/[id]` —— **人工审核**一条校准候选。
 *
 * PATCH：把候选推向 UNDER_REVIEW / ACCEPTED / REJECTED（body `{ to, note? }`）。
 *        这是整条 R6 分析链的**人工审核门**所在：机器只提出建议，状态迁移必须由人显式做出，
 *        且 store 层状态机只允许合法前进（已定论不回退为待办）。
 *
 * 诚实与安全边界：
 *   - **ACCEPTED 不等于系统已自动改基准/引擎**——本端点只更新 CalibrationCandidate 一张表的审核字段，
 *     绝不联动改任何生产模型（落地改参仍另需人工流程，财务口径留创始人拍板）；
 *   - 审核人 `reviewedBy` 只从服务端会话注入（`human:<id>`），绝不信客户端传入；
 *   - 归属校验在服务层按**候选所属项目**执行（owner 本人或 STAFF；无主区域候选仅 STAFF），越权即拒。
 * 门禁：同源 + 登录 + owner-or-staff。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后审核校准候选", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  return mutationResponse(await reviewCandidate({ candidateId: id, user: actor.user, body: parsed.data }));
}
