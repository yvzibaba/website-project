import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse } from "@/server/api-guard";
import { resolveFeedback } from "@/server/feedback";

/**
 * POST /api/admin/feedback/[id]/resolve — 后台标记反馈已处理（Phase 4 模块 C）。
 * 受 requireStaffWrite（CSRF + STAFF 角色）；数据层幂等（已 RESOLVED 再标不报错）。本路由零业务逻辑。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const result = await resolveFeedback(id);
  return mutationResponse(result);
}
