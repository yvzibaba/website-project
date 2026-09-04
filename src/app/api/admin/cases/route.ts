import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { createCase } from "@/server/case-admin";

/**
 * POST /api/admin/cases — 新建案例（Phase 13 M1，受 requireRole(STAFF_ROLES) + CSRF 门禁）。
 * 薄薄一层包住 Phase 7 M5 的 createCase 数据层，actor 由服务端会话注入。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;
  const result = await createCase(body.data, guard.actor);
  return mutationResponse(result);
}
