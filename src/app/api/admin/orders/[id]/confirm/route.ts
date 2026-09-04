import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse } from "@/server/api-guard";
import { confirmOrderPaid } from "@/server/orders";

/**
 * POST /api/admin/orders/[id]/confirm — 后台确认收款（Phase 12 M2，PENDING→PAID）。
 * 最简支付闭环的人工闸门：线下/站外收款到账后，员工点确认。受 requireStaffWrite（CSRF + STAFF 角色）。
 * 数据层保证幂等（已 PAID 再点不刷新 paidAt、返 deduped）与状态机（终态不误伤），本路由零业务逻辑。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const result = await confirmOrderPaid(id, guard.actor);
  return mutationResponse(result);
}
