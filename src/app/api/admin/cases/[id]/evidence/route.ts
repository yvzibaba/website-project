import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { addCaseEvidence } from "@/server/case-admin";

/**
 * POST /api/admin/cases/[id]/evidence — 给案例追加一条证据（Phase 13 M1，受门禁）。
 * 包住 addCaseEvidence（内部会联动 recompute 可信度）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;
  const result = await addCaseEvidence(id, body.data, guard.actor);
  return mutationResponse(result);
}
