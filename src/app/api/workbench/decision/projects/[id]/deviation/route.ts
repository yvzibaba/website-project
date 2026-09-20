import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, errorResponse } from "@/server/api-guard";
import { analyzeProjectForecastVsActual } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/projects/[id]/deviation` —— 预测 vs 实测**偏差分析**（只读）。
 *
 * GET：把该项目（可选 `?scenarioId=` 指定情景）的**存档预测**与**回填实测**对齐，
 *      返回逐指标偏差 + 同量纲金额影响。
 *
 * 关键诚实边界（R6 · M13）：
 *   - 预测取自情景成功计算时冻结的 `forecastSnapshot`，**本端点绝不为对比重跑引擎**——
 *     用今天的模型回头改昨天的预测，会让「偏差」失去意义（FORECAST 必须不可变）；
 *   - 影响只做同量纲换算（钱=FACT，电量×预测隐含单价=ASSUMPTION），**不重算 NPV/现金流**；
 *   - 一切「没测 / 无同口径预测 / 口径不一致」如实标注，绝不当成 0 或 -100%。
 * 门禁：同源 + 登录 + owner-or-staff（越权在服务层动库前即拒）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后查看偏差分析", 401);

  const { id } = await params;
  const scenarioId = new URL(request.url).searchParams.get("scenarioId");
  return mutationResponse(
    await analyzeProjectForecastVsActual({ projectId: id, scenarioId, user: actor.user }),
  );
}
