import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { compareScenarios } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/compare` —— 两情景**差异归因**（M6 · 只算不存）。
 *
 * 它把"场景比较"从"并排摆两个数"升级成"差在哪几个参数、各差多少"：
 * 输入两个已存档情景 id，服务端读各自输入快照，用唯一引擎入口 `runCalculation()`
 * 做逐参数一阶反事实归因，返回指标对照 + 参数差异 + 边际贡献 + 残差与诚实声明。
 *
 * 与推荐端点一样：结果不落库、要求登录、要求同源，且资源级授权在服务层逐情景校验，
 * 防止借归因窥探他人项目。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后使用情景对比归因", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  return mutationResponse(await compareScenarios({ body: parsed.data, user: actor.user }));
}
