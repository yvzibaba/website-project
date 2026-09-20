import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { recalculateScenario } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/scenarios/[id]/recalculate` —— 重算一个情景。
 *
 * 体：`{ patch?: <增量补丁>, templateId?: string }`（二者互斥）。
 *   - `patch` 是**在存档输入之上**的增量：之所以不从客户端接收整份输入，
 *     是为了让「只改一个参数」不会因为客户端漏传字段而静默重置其他参数；
 *   - `templateId` 用于整体切换到另一个声明式情景模板，此时会**继承**当前服务费
 *     （服务费属经营策略，切模板不该把它抹掉）。
 *
 * 重算成功后立即落库并返回新的 `calcStatus`；失败时清空全部结果列并留下 `calcError`，
 * 绝不让旧数字继续挂在外面冒充新结论。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后重算情景", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const { id } = await params;
  return mutationResponse(await recalculateScenario({ scenarioId: id, user: actor.user, body: parsed.data }));
}
