import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, errorResponse } from "@/server/api-guard";
import { readOneDecisionScenario } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/scenarios/[id]/report` —— 取一个情景的**决策报告**快照。
 *
 * 为什么报告要单独一个端点，而不是塞进情景详情一起返回：
 *   报告体量远大于详情（13 个章节、含表格），而工作台载入时通常只需要摘要与决策。
 *   分开之后「打开报告」才拉报告，详情页保持轻量。两者读的是**同一份落库快照**，
 *   因此不存在「详情与报告数字不一致」的可能。
 *
 * 门禁：同源 + 登录 + owner-or-staff。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后查看报告", 401);

  const { id } = await params;
  const result = await readOneDecisionScenario({ scenarioId: id, user: actor.user });
  if (result.status !== "ok") return mutationResponse(result);

  const scenario = result.scenario as { id: string; name: string; engineVersion: string | null; report: unknown; calcStatus: string; calcError?: string | null };
  return mutationResponse({
    status: "ok",
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    calcStatus: scenario.calcStatus,
    engineVersion: scenario.engineVersion,
    report: scenario.report,
    // 报告为空时把原因一并说明，避免前端只能显示「暂无报告」而不知道是没算还是没有
    reportUnavailableReason:
      scenario.report == null
        ? scenario.calcStatus === "ok"
          ? "该情景的结果快照缺失报告字段（可能由历史版本写入），请重算后查看。"
          : `该情景最近一次计算未通过（状态：${scenario.calcStatus}），因此没有报告。${scenario.calcError ? `原因：${scenario.calcError}` : ""}`
        : null,
  });
}
