import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse } from "@/server/api-guard";
import { removeSolutionFinancial } from "@/server/solution-admin";

/**
 * DELETE /api/admin/solutions/[id]/financial/[financialId] — 删除方案的一条财务测算（Phase 13 M1，受门禁）。
 * 数据层按 financialId 回查其所属 solution 并写 ChangeLog；[id] 仅作路由可读性，真正的定位键是 financialId。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; financialId: string }>;
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { financialId } = await params;
  const result = await removeSolutionFinancial(financialId, guard.actor);
  return mutationResponse(result);
}
