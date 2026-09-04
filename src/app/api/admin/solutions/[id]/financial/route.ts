import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { addSolutionFinancial } from "@/server/solution-admin";

/**
 * POST /api/admin/solutions/[id]/financial — 给方案追加一条财务测算（Phase 13 M1，受门禁）。
 * Decimal 字段以字符串入参（数据层避免 JS 浮点污染）。
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
  const result = await addSolutionFinancial(id, body.data, guard.actor);
  return mutationResponse(result);
}
