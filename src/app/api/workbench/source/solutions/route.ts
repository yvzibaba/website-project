import { NextResponse } from "next/server";
import type { NextResponse as NR } from "next/server";
import { requireUserWrite, errorResponse } from "@/server/api-guard";
import { findSolutionsBySource, ownsSolutionSource } from "@app/kernel/server/solution-source-server";
import { SOLUTION_SOURCE_FIELD } from "@app/kernel/lib/solution-source";
import { STAFF_ROLES } from "@/server/authz";

/**
 * /api/workbench/source/solutions — 反查「某沙盘情景 / 项目 → 它导出过哪些产业方案」（中途重构 R8.6）。
 *
 * 门禁（V1.1 P4 买家闭环修复 · 审计 #10 同源）：由 `requireStaffWrite` 改为 `requireUserWrite`
 *   （CSRF 同源 + 必须登录）+ **属主双闸**：① 普通用户查询的情景/项目必须归其所有（`ownsSolutionSource`，
 *   越权 → 403）；② 结果按 `creatorId=会话 id` 过滤——只回自己导出的方案（历史无主导出仅 staff 可见）。
 *   staff（REVIEWER/ADMIN）保持全量后台视野。反查仍**零公开暴露**（未登录 401）、绝不外泄财务明细。
 *
 * 入参：query `scenarioId` 和 / 或 `projectId`（至少其一，须合法 cuid）；二者都给则要求同一来源指针同时吻合。
 * 出参：`{ ok:true, field: <SOLUTION_SOURCE_FIELD>, count, items:[{id,title,slug,status,updatedAt,source}] }`。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NR> {
  const guard = await requireUserWrite(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const scenarioId = url.searchParams.get("scenarioId") ?? undefined;
  const projectId = url.searchParams.get("projectId") ?? undefined;
  if (!scenarioId && !projectId) {
    return errorResponse("VALIDATION_ERROR", "须提供 scenarioId 或 projectId 之一", 400, {
      fields: { sandboxSource: ["缺少查询参数"] },
    });
  }

  const isStaff = STAFF_ROLES.includes(guard.user.role);
  if (!isStaff) {
    const owner = await ownsSolutionSource({ scenarioId, projectId }, guard.user);
    if (!owner.owned) {
      return errorResponse("FORBIDDEN", owner.reason ?? "只能反查属于自己的沙盘情景 / 项目", 403);
    }
  }

  const result = await findSolutionsBySource(
    { scenarioId, projectId },
    isStaff ? undefined : { restrictToCreatorId: guard.user.id },
  );
  if (result.status === "invalid") {
    return errorResponse("VALIDATION_ERROR", "入参校验未通过", 400, { fields: result.fieldErrors });
  }
  if (result.status === "error") {
    const isProd = process.env.NODE_ENV === "production";
    return errorResponse("INTERNAL_ERROR", isProd ? "服务器内部错误" : result.error, 500);
  }
  return NextResponse.json({
    ok: true,
    field: SOLUTION_SOURCE_FIELD,
    count: result.count,
    items: result.items,
  });
}
