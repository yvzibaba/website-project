import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { persistSandboxSolutionDraft } from "@/server/sandbox-solution-store";

/**
 * /api/sandbox/solution — 把沙盘「产业方案草案」（R8.1 `sandbox-solution.ts` 在浏览器现算出的草稿）
 * 落库成一条真实 **DRAFT** `Solution`（中途重构 R8.2 · 总控最高优先级「商业闭环」第二块拼图）。
 *
 * 门禁（宪法安全底线 + 「AI 做劳动、人做关键决策」）：受 `requireStaffWrite`（CSRF 同源 + REVIEWER/ADMIN）
 *   保护——能建/改方案后台本就是 staff 权限，导出桥**不赋予任何人超过** `POST /api/admin/solutions` 的权力；
 *   普通访客 / 买家碰不到。落库全程委托 `sandbox-solution-store` → `solution-admin` 已测函数：
 *   `caseId` 外键预检（案例不存在给清楚的 `invalid.caseId`，绝不 500）、强制 DRAFT、写 ChangeLog。
 *
 * 刻意边界：**绝不自动发布**——只建 DRAFT；能否售卖由人在后台补真实数据 + 定价后经 `publishGuard` 决定。
 *   服务端不复算经济数字（与 R6.2/R6.3 同口径），只结构校验后原样落库；结果由 `mutationResponse`
 *   统一翻译（ok→200 透 solutionId/financialCount/unknownCount/warnings/publishBlockers）。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await persistSandboxSolutionDraft(parsed.data, guard.actor);
  return mutationResponse(result);
}
