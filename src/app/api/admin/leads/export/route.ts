import { NextResponse } from "next/server";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { errorResponse } from "@/server/api-guard";
import { getLeadPipelineRows, LEAD_PIPELINE_VERSION } from "@/server/lead-pipeline";
import { toCsv } from "@/server/lead-pipeline-model";

/**
 * GET /api/admin/leads/export —— R7-D/mandate §五「留资漏斗批量视图 → CSV 导出」（只读 · 零新表）。
 *
 * 权限（严格）：导出含企业 / 联系人 / 邮箱 / 电话归属等隐私，**仅 STAFF（REVIEWER/ADMIN）** 可取；
 *   未登录 401、越权 403（不泄露"存在此资源"）。只读、不写、不推进任何状态。
 *   （GET 无副作用，走 `requireRole` 只门禁、不要求 CSRF；写侧路由才用 `requireStaffWrite`。）
 *
 * CSV 安全：所有单元格经 `toCsv` → `csvCell` **公式注入防护**（`= + - @ \t \r` 开头加 `'`）
 *   + RFC4180 双引号转义；前置 UTF-8 BOM 让 Excel 正确按 UTF-8 解中文。
 * 诚实：`?status=` 白名单过滤（非法值当无过滤），行集与 `/admin/leads` 批量表同源（同一
 *   `getLeadPipelineRows`，无第二套系统）。文件名带 Asia/Shanghai 日期戳，`x-pipeline-version` 回显口径版本。
 */
export const dynamic = "force-dynamic";

function dateStamp(): string {
  // Asia/Shanghai 的 YYYYMMDD（Intl 分段拼装，不依赖 moment/dayjs）。
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) {
    if (authz.reason === "unauthenticated") return errorResponse("UNAUTHORIZED", "请先登录", 401);
    return errorResponse("FORBIDDEN", "需 REVIEWER 或 ADMIN 角色", 403);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const res = await getLeadPipelineRows({ status, limit: 200 });
  if (!res.ok) return errorResponse("INTERNAL_ERROR", res.error, 500);

  const csv = "\uFEFF" + toCsv(res.rows); // BOM：Excel 按 UTF-8 解中文不乱码
  const filename = `leads-pipeline-${dateStamp()}.csv`;
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "x-pipeline-version": LEAD_PIPELINE_VERSION,
      "x-row-count": String(res.rows.length),
    },
  });
}
