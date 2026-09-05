import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffWrite, mutationResponse, readJsonSafe, errorResponse } from "@/server/api-guard";
import { CuidSchema } from "@/lib/validation";
import { upgradeSolutionFinancialProvenance } from "@/server/sandbox-provenance-store";

/**
 * POST /api/sandbox/solution/provenance — 提交「真实来源链接 + 置信度」，把某条沙盘来源 `SolutionFinancial`
 * 从 ASSUMPTION 受控升级为 FACT（中途重构 R8.5 · 总控最高优先级「商业闭环」第五块拼图）。
 *
 * 门禁（宪法安全底线 + 「AI 做劳动、人做关键决策」）：受 `requireStaffWrite`（CSRF 同源 + REVIEWER/ADMIN）
 *   保护——能把一条占位假设「认证成可售卖事实」是**关键人工决策**，普通访客 / 买家绝碰不到。
 *
 * 刻意边界：
 *   - 落库前**必过** R8.4 纯函数闸门 `planProvenanceUpgrade`：无合法 http(s) 来源 / 无 [0,100] 数值置信度
 *     → `upgradeSolutionFinancialProvenance` 返回 `blocked`（409）并透传原因，**绝不落库**（§12/§20）。
 *   - 只改溯源、**绝不重算或篡改任何经济数字**（§8）；升级后沙盘来源识别与可复算审计仍成立（集成测试钉死）。
 *   - 不改发布状态 / 不定价 / 不自动上架——发布仍由 `publishGuard` 把关（§21）。
 *
 * 入参：`{ financialId: cuid, sourceUrl?, confidence?, note? }`。结果由 `mutationResponse` 统一翻译
 *   （ok→200 透 solutionId/financialId/version/evidenceKind/upgradeRef；blocked→409；not_found→404）。
 */
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  financialId: CuidSchema,
  sourceUrl: z.string().trim().max(2000).nullish(),
  confidence: z.number().nullish(),
  note: z.string().trim().max(2000).nullish(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const body = BodySchema.safeParse(parsed.data);
  if (!body.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of body.error.issues) {
      const key = issue.path.join(".") || "_";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return errorResponse("VALIDATION_ERROR", "入参校验未通过", 400, { fields: fieldErrors });
  }

  const { financialId, sourceUrl, confidence, note } = body.data;
  const result = await upgradeSolutionFinancialProvenance(
    financialId,
    { sourceUrl: sourceUrl ?? null, confidence: confidence ?? null, note: note ?? null },
    guard.actor,
  );
  return mutationResponse(result);
}
