import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse } from "@/server/api-guard";
import { removeCaseEvidence } from "@/server/case-admin";

/**
 * DELETE /api/admin/cases/[id]/evidence/[evidenceId] — 删除一条证据（Phase 13 M1，受门禁）。
 * 数据层按 evidenceId 回查其所属案例并联动 recompute；[id] 仅作 RESTful 路径上下文
 * （V1 仅 REVIEWER/ADMIN 可写，跨员工删除任意证据不构成越权，故不在此重复校验归属）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; evidenceId: string }>;
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { evidenceId } = await params;
  const result = await removeCaseEvidence(evidenceId, guard.actor);
  return mutationResponse(result);
}
