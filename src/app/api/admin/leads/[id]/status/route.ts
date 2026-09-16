import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe, errorResponse } from "@/server/api-guard";
import { updateLeadStatus, LEAD_STATUSES, type LeadStatus } from "@/server/leads";

/**
 * POST /api/admin/leads/[id]/status — 后台标记留资跟进状态（V1.1 P6 · 商业闭环「状态管理」补全）。
 *
 * 为什么：`updateLeadStatus` 数据层早已实现，但 P4 只落了「列表 + 详情展开」，**没接路由/按钮**，
 * 一线跟进结果无处回写（记于 P4 尾巴）。P6 邀请真实用户前的可靠性验证把「后台查看 → 状态管理」
 * 列为必查路径，故补上这条唯一的写入口，闭环成立。
 *
 * 门禁：`requireStaffWrite`（CSRF 同源 + STAFF 角色）——留资含企业/邮箱/电话隐私，只允许工作人员改状态。
 * 状态白名单校验放在数据层（updateLeadStatus 对未知状态返回 invalid），本路由零业务逻辑：
 * 只把 body.status 原样交给数据层，再经 mutationResponse 统一翻译（ok→200 / invalid→400 / not_found→404）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const status = (parsed.data as { status?: unknown })?.status;
  if (typeof status !== "string" || !(LEAD_STATUSES as readonly string[]).includes(status)) {
    return errorResponse("VALIDATION_ERROR", "未知的留资状态", 400, { allowed: [...LEAD_STATUSES] });
  }

  const { id } = await params;
  return mutationResponse(await updateLeadStatus(id, status as LeadStatus));
}
