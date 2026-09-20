import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, errorResponse } from "@/server/api-guard";
import { calibrationLandscape } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/calibration/landscape` —— 跨项目方向性概览（只读，§19/§20）。
 *
 * GET：在**当前用户可访问**的项目范围内，把同一「指标 + 口径 + 区域」的方向一致偏差聚合起来，
 *      回答「这个偏差是个案，还是我在多个项目/同一区域反复出现的方向性问题？」
 *      支持 `?metric=`、`?regionId=` 过滤。
 *
 * 诚实纪律：
 *   - 只读聚合，不写库、不重算——逐项目复用与偏差面板**同一条**纯分析路径，口径必然一致；
 *   - 加权 / 不加权两套均值都给，并显式标 `systemic`，绝不把相反方向平均成 0 就当「模型没问题」（§20）；
 *   - 越权在服务层挡死：项目集合来自 `listDecisionProjects(会话用户 id)`，天然只含本人可访问项。
 * 门禁：同源 + 登录。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后查看跨项目方向性概览", 401);

  const url = new URL(request.url);
  const metric = url.searchParams.get("metric") ?? undefined;
  const regionId = url.searchParams.get("regionId");
  return mutationResponse(
    await calibrationLandscape({ user: actor.user, metric, regionId: regionId ?? null }),
  );
}
