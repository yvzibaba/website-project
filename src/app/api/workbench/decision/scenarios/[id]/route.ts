import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, errorResponse } from "@/server/api-guard";
import { deleteScenario, readOneDecisionScenario } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/scenarios/[id]` —— 单个 V2 情景的读 / 删。
 *
 * GET：读回完整快照（输入 / 决策 / 报告 / 版本指纹），供工作台九段式详情与报告视图消费。
 *      该快照是**只读**的：任何修改都必须走重算端点（改输入 → 重跑引擎），
 *      不允许在这里直接改结果字段。
 * DELETE：删除一个**非基线**情景。基线情景不可删除——它是这个项目唯一可复算的对照基准，
 *      删掉之后「这个方案比不装光伏好多少」这类结论就永远无法重放。
 * 门禁：同源 + 登录 + owner-or-staff。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后查看情景", 401);

  const { id } = await params;
  return mutationResponse(await readOneDecisionScenario({ scenarioId: id, user: actor.user }));
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后删除情景", 401);

  const { id } = await params;
  return mutationResponse(await deleteScenario({ scenarioId: id, user: actor.user }));
}
