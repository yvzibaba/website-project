import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { createSolution } from "@/server/solution-admin";

/**
 * POST /api/admin/solutions — 新建方案（Phase 13 M1，受 requireRole(STAFF_ROLES) + CSRF 门禁）。
 * 数据层强制 status=DRAFT（不允许直建已发布），发布须走 PATCH + publishGuard。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;
  const result = await createSolution(body.data, guard.actor);
  return mutationResponse(result);
}
