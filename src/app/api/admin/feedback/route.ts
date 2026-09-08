import { NextResponse } from "next/server";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { errorResponse } from "@/server/api-guard";
import { listFeedback, listFeedbackSchema } from "@/server/feedback";

/**
 * GET /api/admin/feedback — 后台反馈列表（Phase 4 模块 C）。
 * 只读端点：GET 是安全方法、无状态变更，不做 CSRF，仅 requireRole(STAFF_ROLES)
 * 挡未登录/越权（与后台订单读层同一门禁口径）。query：`?status=OPEN|RESOLVED&limit=n`。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) {
    if (authz.reason === "unauthenticated") {
      return errorResponse("UNAUTHORIZED", "需要登录后台", 401);
    }
    return errorResponse("FORBIDDEN", "需要审核员或管理员权限", 403, { required: authz.required });
  }

  const url = new URL(request.url);
  const parsed = listFeedbackSchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "查询参数不合法", 400);
  }
  const result = await listFeedback({ status: parsed.data.status, limit: parsed.data.limit });
  if (!result.ok) {
    return errorResponse("INTERNAL_ERROR", "反馈列表查询失败", 500);
  }
  // 读列表走 NextResponse.json 直出（对齐 GET /api/admin/orders 口径；mutationResponse 是写端点专用形状）。
  return NextResponse.json({ ok: true, items: result.items });
}
