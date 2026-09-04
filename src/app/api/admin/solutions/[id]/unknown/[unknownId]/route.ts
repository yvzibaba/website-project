import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse } from "@/server/api-guard";
import { removeSolutionUnknown } from "@/server/solution-admin";

/**
 * DELETE /api/admin/solutions/[id]/unknown/[unknownId] — 删除方案的一条关键未知变量（Phase 13 M1，受门禁）。
 * 数据层按 unknownId 回查所属 solution、删除并刷新 unknownVariableCount；[id] 仅路由可读性，定位键是 unknownId。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; unknownId: string }>;
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { unknownId } = await params;
  const result = await removeSolutionUnknown(unknownId, guard.actor);
  return mutationResponse(result);
}
