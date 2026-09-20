import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { addScenarioToProject, listScenarioSummaries } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/projects/[id]/scenarios` —— 项目下的情景集合。
 *
 * GET：列出该项目的 V2 情景摘要（用于情景对比表）。
 * POST：追加一个新情景；体 `{ name, scenarioInput }`。
 *       服务端**现算落库**，因此新增的情景一落库就带着可复算的结果，
 *       不存在「先存空壳、以后再补算」的中间态。
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
  return mutationResponse(await listScenarioSummaries({ projectId: id, user: actor.user }));
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后新增情景", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  return mutationResponse(
    await addScenarioToProject({ projectId: id, user: actor.user, body: parsed.data }),
  );
}
