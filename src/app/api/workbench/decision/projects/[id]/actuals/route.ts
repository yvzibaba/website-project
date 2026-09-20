import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { listActuals, saveActual } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/projects/[id]/actuals` —— 实测数据回填（预测 → 实测闭环的入口）。
 *
 * GET：列出该项目的实测记录。
 * POST：写入/更新一条实测记录（**幂等**：同项目同期间重复提交即更新）。
 *       未提供的字段一律留 `null`（= 没测），绝不落成 0——0 在实测语义里是"确实为零"，
 *       把两者混淆会让「预测 vs 实测」的偏差分析得出反向结论。
 * 门禁：同源 + 登录 + owner-or-staff。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后查看实测数据", 401);

  const { id } = await params;
  return mutationResponse(await listActuals({ projectId: id, user: actor.user }));
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后录入实测数据", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  return mutationResponse(await saveActual({ projectId: id, user: actor.user, body: parsed.data }));
}
