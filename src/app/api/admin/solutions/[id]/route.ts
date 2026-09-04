import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { updateSolution, deleteSolution } from "@/server/solution-admin";

/**
 * /api/admin/solutions/[id] — 更新（PATCH，含发布迁移走 publishGuard）与删除（DELETE，
 * 有 Order 关联则 blocked）方案（Phase 13 M1，受门禁）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;
  const result = await updateSolution(id, body.data, guard.actor);
  return mutationResponse(result);
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const result = await deleteSolution(id, guard.actor);
  return mutationResponse(result);
}
