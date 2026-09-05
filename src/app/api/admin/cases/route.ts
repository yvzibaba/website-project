import { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe, errorResponse } from "@/server/api-guard";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { createCase } from "@/server/case-admin";
import { listAdminCases } from "@/server/admin-cases";

/**
 * /api/admin/cases — 案例「后台」写入口（POST · Phase 13 M1）+ 只读清单（GET · R8.2 新增）。
 *
 * 两条子路径刻意共用同一文件、各守各的门禁口径（第 16 条单一真源）：
 *   - POST：`requireStaffWrite`（CSRF 同源 + REVIEWER/ADMIN）包住 `createCase` 数据层，actor 由服务端会话注入。
 *   - GET ：`requireRole(STAFF_ROLES)`（读、无副作用故不套 CSRF）暴露 `listAdminCases` 全量清单为只读 JSON，
 *     专供 R8.2「导出产业方案」面板**选案例**——`Solution.caseId` 是必填外键（R6.4 regionId 的 P2003 教训），
 *     导出前必须由人从真实存在的案例中挑一个，而非手填 cuid。全量清单含候选态 / DEMO 夹具，故仍卡 staff。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;
  const result = await createCase(body.data, guard.actor);
  return mutationResponse(result);
}

export async function GET(): Promise<NextResponse> {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) {
    if (authz.reason === "unauthenticated") {
      return errorResponse("UNAUTHORIZED", "需要登录后台", 401);
    }
    return errorResponse("FORBIDDEN", "需要审核员或管理员权限", 403, { required: authz.required });
  }

  const result = await listAdminCases();
  return NextResponse.json({
    ok: result.ok,
    items: result.items,
    total: result.total,
    truncated: result.truncated,
    ...(result.error ? { error: result.error } : {}),
  });
}
