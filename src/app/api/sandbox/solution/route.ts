import type { NextResponse } from "next/server";
import { requireUserWrite, mutationResponse, readJsonSafe, errorResponse } from "@/server/api-guard";
import { persistSandboxSolutionDraft } from "@/server/sandbox-solution-store";
import { ownsSandboxSource } from "@/server/sandbox-solution-source";
import { hasEntitlement } from "@/server/feature-flags";
import { logger } from "@/lib/logger";

/**
 * /api/sandbox/solution — 把沙盘「产业方案草案」（R8.1 `sandbox-solution.ts` 在浏览器现算出的草稿）
 * 落库成一条真实 **DRAFT** `Solution`（中途重构 R8.2 · 总控最高优先级「商业闭环」第二块拼图）。
 *
 * 门禁（V1.1 P4 买家闭环修复 · 审计 #10）：由 `requireStaffWrite` 改为 `requireUserWrite`
 *   （CSRF 同源 + **必须登录**，任意角色）+ **属主核验** `ownsSandboxSource`——若草案带来源情景/项目指针，
 *   必须属于当前登录用户（staff 豁免，同 canAccessProject 口径）。修复前真实买家被门禁挡在门外，
 *   「导出 → 定价 → 购买」闭环断裂；滥用风险按方案 §5 #6 预批结论收敛：产物一律 DRAFT、
 *   定价与发布仍在 staff 后台经 publishGuard 决定，本端点不赋予任何人超过建 DRAFT 的权力。
 *   导出能力另挂 Pro entitlement 软开关（`SANDBOX_ENTITLEMENT_EXPORT`，V1.1 默认开，计费系统留桩）。
 *
 * 刻意边界：**绝不自动发布**——只建 DRAFT；服务端不复算经济数字（与 R6.2/R6.3 同口径），
 *   只结构校验后原样落库；creatorId 由会话注入盖到方案行（供「我的导出」反查属主过滤）。
 *   结果由 `mutationResponse` 统一翻译（ok→200 透 solutionId/financialCount/unknownCount/warnings/publishBlockers）。
 */
export const dynamic = "force-dynamic";

const log = logger.child({ module: "api/sandbox/solution" });

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireUserWrite(request);
  if (!guard.ok) return guard.response;

  if (!hasEntitlement("export")) {
    return errorResponse("FORBIDDEN", "导出产业方案暂未开放，请联系客服开通", 403);
  }

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const body = (parsed.data ?? {}) as Record<string, unknown>;
  const owner = await ownsSandboxSource(
    body.sandboxSource as { scenarioId?: string; projectId?: string } | undefined,
    guard.user,
  );
  if (!owner.owned) {
    log.warn("export denied: sandboxSource not owned by session user", { userId: guard.user.id });
    return errorResponse("FORBIDDEN", owner.reason ?? "只能导出属于自己的沙盘项目 / 情景", 403);
  }

  const result = await persistSandboxSolutionDraft(parsed.data, guard.actor, { creatorId: guard.user.id });
  return mutationResponse(result);
}
