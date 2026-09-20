import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, errorResponse } from "@/server/api-guard";
import { removeActual } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/actuals/[id]` —— 删除一条实测记录。
 *
 * 需要同时给出 `?projectId=`：实测记录本身不含 owner 信息，
 * 必须先定位到项目才能判归属（避免凭一个实测 id 就删别人的数据）。
 * 门禁：同源 + 登录 + owner-or-staff。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后删除实测数据", 401);

  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return errorResponse("VALIDATION_ERROR", "缺少 projectId，无法确认这条实测数据属于哪个项目", 400);
  }

  const { id } = await params;
  return mutationResponse(await removeActual({ actualId: id, projectId, user: actor.user }));
}
