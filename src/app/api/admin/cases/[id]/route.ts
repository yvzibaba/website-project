import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { updateCase, deleteCase } from "@/server/case-admin";

/**
 * /api/admin/cases/[id] — 更新（PATCH）与删除（DELETE）案例（Phase 13 M1，受门禁）。
 * 包住 Phase 7 M5 的 updateCase / deleteCase（后者仍保留「挂 PUBLISHED 方案 → blocked」守卫）。
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
  const result = await updateCase(id, body.data, guard.actor);
  return mutationResponse(result);
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const result = await deleteCase(id, guard.actor);
  return mutationResponse(result);
}
