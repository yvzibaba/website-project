import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse } from "@/server/api-guard";
import { cancelOrder } from "@/server/orders";

/**
 * POST /api/admin/orders/[id]/cancel — 后台取消待支付订单（Phase 12 M2，PENDING→CANCELED）。
 * 仅待支付单可取消（已支付属 V1 无退款流程，数据层会返 blocked，退款待 ROADMAP #5）。
 * 受 requireStaffWrite（CSRF + STAFF 角色），本路由零业务逻辑。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const result = await cancelOrder(id, guard.actor);
  return mutationResponse(result);
}
