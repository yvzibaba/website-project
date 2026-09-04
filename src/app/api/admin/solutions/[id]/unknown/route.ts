import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { addSolutionUnknown } from "@/server/solution-admin";

/**
 * POST /api/admin/solutions/[id]/unknown — 给方案追加一条关键未知变量（Phase 13 M1，受门禁）。
 * 数据层会同步刷新 solution.unknownVariableCount（宪法第 7 条：程序复算而非口算）。
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
  const result = await addSolutionUnknown(id, body.data, guard.actor);
  return mutationResponse(result);
}
