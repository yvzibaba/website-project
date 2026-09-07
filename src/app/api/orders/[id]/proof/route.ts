import type { NextResponse } from "next/server";
import {
  requireSameOriginActor,
  mutationResponse,
  readJsonSafe,
  errorResponse,
} from "@/server/api-guard";
import { submitPaymentProof, getOrderById, type OrderView } from "@/server/orders";
import { logger } from "@/lib/logger";

/**
 * POST /api/orders/[id]/proof — 买家提交付款凭证（Phase 12 M4，过渡版人工收款闭环）。
 *
 * 门禁与 `/api/orders`（下单）同源一致：这是**买家行为**，绝不套 staff 角色门，只做
 * `requireSameOriginActor`（CSRF 同源 + 从服务端会话读取身份，不信客户端传入的身份/金额）。
 * 本版 UI 购买需登录，故提交凭证也**要求已登录属主**：
 *   - 未登录 → 401（游客拿不到可核验的身份，无法证明「这是他的单」）；
 *   - 属主核对：order.userId==会话 id 或 order.buyerEmail==会话邮箱（归一小写）。
 *     非属主统一返回 404（与订单详情页一致，绝不区分「存在但无权」与「不存在」，防 IDOR 枚举）。
 * 业务全在 orders 数据层（仅 PENDING 可提交、幂等刷新、状态/金额不动），本路由零业务逻辑。
 */

const log = logger.child({ module: "api/orders/proof" });

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isOwner(order: OrderView, user: { id: string; email: string }): boolean {
  if (order.userId && order.userId === user.id) return true;
  if (order.buyerEmail && order.buyerEmail === user.email.toLowerCase()) return true;
  return false;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireSameOriginActor(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;

  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;

  if (!guard.user) {
    return errorResponse("UNAUTHORIZED", "需要登录后查看并提交付款凭证", 401);
  }

  const found = await getOrderById(id);
  if (found.status === "error") {
    return errorResponse("INTERNAL_ERROR", "订单查询失败", 500);
  }
  // 不存在 / 非属主 一律 404：不用「存在但无权」泄露订单是否存在（宁严毋松）。
  if (found.status !== "found" || !found.data || !isOwner(found.data, guard.user)) {
    return errorResponse("NOT_FOUND", "订单不存在", 404);
  }

  const result = await submitPaymentProof(id, body.data, guard.actor ?? undefined);
  if (result.status === "ok") {
    log.info("payment proof submitted via HTTP", { orderId: id, by: "user" });
  }
  return mutationResponse(result);
}
