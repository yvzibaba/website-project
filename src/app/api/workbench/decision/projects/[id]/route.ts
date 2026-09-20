import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, errorResponse } from "@/server/api-guard";
import { readOneDecisionProject } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/projects/[id]` —— 读回一个 V2 项目（项目头 + V2 情景摘要）。
 *
 * 门禁：CSRF 同源 + 登录 + **owner-or-staff**（越权在查库拿到 owner 后由编排层判 forbidden→403）。
 * 只回摘要视图（不外泄大 JSON 快照 / Decimal），供工作台载入。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后访问项目", 401);

  const { id } = await params;
  return mutationResponse(await readOneDecisionProject({ projectId: id, user: actor.user }));
}
