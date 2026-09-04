import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { createOrder } from "@/server/orders";
import { logger } from "@/lib/logger";

/**
 * POST /api/orders — 用户下单（Phase 12 M2，购买闭环的公开入口，游客亦可）。
 *
 * 门禁与 M1 后台写端点不同：下单是**买家行为**，绝不能套 REVIEWER/ADMIN 角色门（会把所有真实
 * 买家挡在门外）。这里只做 CSRF 同源 + 从服务端会话读取可选身份（`requireSameOriginActor`）：
 *   - 登录用户：userId **强制取自会话**、并覆盖客户端传入的任何 userId（杜绝冒名给别人下单）；
 *   - 游客：无 userId，靠其自填的 buyerEmail 认领订单与后续解锁（Order 行落库）。
 * 金额、可下单性（PUBLISHED + 有价）、重复下单幂等等全部由 orders 数据层裁决——本路由零业务逻辑，
 * 只加 CSRF 与身份注入这一层薄壳（宪法第 16 条：门禁/翻译口径单一）。
 */

const log = logger.child({ module: "api/orders" });

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireSameOriginActor(request);
  if (!guard.ok) return guard.response;

  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;

  // 剥掉客户端可能夹带的 userId/actor（身份只认服务端会话），保留 solutionId/buyerEmail/buyerName/buyerType。
  const raw = { ...((body.data ?? {}) as Record<string, unknown>) };
  delete raw.userId;
  delete raw.actor;
  const payload = { ...raw, userId: guard.user?.id ?? undefined };

  const result = await createOrder(payload, guard.actor ?? undefined);
  if (result.status === "ok") {
    log.info("order placed via HTTP", { orderId: result.orderId, by: guard.user ? "user" : "guest", deduped: !!result.deduped });
  }
  return mutationResponse(result);
}
