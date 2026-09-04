import { NextResponse } from "next/server";
import type { Order } from "@prisma/client";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { errorResponse } from "@/server/api-guard";
import { PaginationSchema } from "@/lib/validation";
import { listOrdersForAdmin } from "@/server/orders";

/**
 * GET /api/admin/orders — 后台订单列表（Phase 12 M2，受 REVIEWER/ADMIN 门禁）。
 *
 * 只读端点：GET 是安全方法、无状态变更，故不做 CSRF（会话 cookie SameSite=Lax 已防跨站读取），
 * 仅 `requireRole(STAFF_ROLES)` 挡下未登录/越权——与后台案例读层同一门禁口径。
 * 支持 `?status=`（PENDING/PAID/REFUNDED/CANCELED 之一，非法值当作无过滤，宽松处理读请求）
 * 与 `?page=&pageSize=`（复用 PaginationSchema，pageSize 上限 100 防拉爆）。
 */
export const dynamic = "force-dynamic";

const ORDER_STATUSES: readonly string[] = ["PENDING", "PAID", "REFUNDED", "CANCELED"];

export async function GET(request: Request): Promise<NextResponse> {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) {
    if (authz.reason === "unauthenticated") {
      return errorResponse("UNAUTHORIZED", "需要登录后台", 401);
    }
    return errorResponse("FORBIDDEN", "需要审核员或管理员权限", 403, { required: authz.required });
  }

  const sp = new URL(request.url).searchParams;
  const parsed = PaginationSchema.safeParse({
    page: sp.get("page") ?? undefined,
    pageSize: sp.get("pageSize") ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse("VALIDATION_ERROR", "分页参数非法", 400, { fields: { page: ["非法"], pageSize: ["非法"] } });
  }
  const statusRaw = sp.get("status");
  const status = statusRaw && ORDER_STATUSES.includes(statusRaw) ? (statusRaw as Order["status"]) : undefined;

  const result = await listOrdersForAdmin({ status, page: parsed.data.page, pageSize: parsed.data.pageSize });
  return NextResponse.json(result);
}
