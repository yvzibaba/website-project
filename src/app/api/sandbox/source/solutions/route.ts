import { NextResponse } from "next/server";
import type { NextResponse as NR } from "next/server";
import { requireStaffWrite, errorResponse } from "@/server/api-guard";
import { findSolutionsBySandboxSource } from "@/server/sandbox-solution-source";
import { SANDBOX_SOURCE_FIELD } from "@/lib/sandbox-solution-source";

/**
 * /api/sandbox/source/solutions — 反查「某沙盘情景 / 项目 → 它导出过哪些产业方案」（中途重构 R8.6）。
 *
 * 门禁：受 `requireStaffWrite`（CSRF 同源 + REVIEWER/ADMIN）保护——反查会透出方案标题 / slug / 状态等内部治理
 *   信息，且导出本身即 staff-only（普通访客碰不到），故整条 R8.6 反查**零公开暴露**、与方案后台同权限。
 *
 * 入参：query `scenarioId` 和 / 或 `projectId`（至少其一，须合法 cuid）；二者都给则要求同一来源指针同时吻合。
 * 出参：`{ ok:true, field: <SANDBOX_SOURCE_FIELD>, count, items:[{id,title,slug,status,updatedAt,source}] }`。
 *   只读 `SolutionFinancial.assumptions.sandboxSource` JSONB 指针，**绝不重算、绝不外泄财务明细**（§7/§8）。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NR> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const scenarioId = url.searchParams.get("scenarioId") ?? undefined;
  const projectId = url.searchParams.get("projectId") ?? undefined;
  if (!scenarioId && !projectId) {
    return errorResponse("VALIDATION_ERROR", "须提供 scenarioId 或 projectId 之一", 400, {
      fields: { sandboxSource: ["缺少查询参数"] },
    });
  }

  const result = await findSolutionsBySandboxSource({ scenarioId, projectId });
  if (result.status === "invalid") {
    return errorResponse("VALIDATION_ERROR", "入参校验未通过", 400, { fields: result.fieldErrors });
  }
  if (result.status === "error") {
    const isProd = process.env.NODE_ENV === "production";
    return errorResponse("INTERNAL_ERROR", isProd ? "服务器内部错误" : result.error, 500);
  }
  return NextResponse.json({
    ok: true,
    field: SANDBOX_SOURCE_FIELD,
    count: result.count,
    items: result.items,
  });
}
