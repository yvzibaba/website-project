import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { getCurrentUser } from "@/server/authz";
import { createDecisionProjectForUser, listMyDecisionProjects } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/projects` —— V2 决策平台的项目集合端点。
 *
 * 为什么另起 `decision/` 命名空间而不是复用 `/api/workbench/projects`：
 *   后者已由 V1 简化年度模型占用，其请求体是 `{ name, regionId, layers }`，
 *   结果也是 V1 口径的 `calcResult`。把 V2 的 `scenarioInput` 塞进同一个 POST，
 *   两个完全不同的输入契约会在同一端点上互相打架（且必然改写 V1 的历史结果）——
 *   这属于「V1 结论被静默改写」的停止条件。因此 V2 独立成命名空间，只增不改。
 *
 * GET：列出**当前会话用户自己的** V2 项目（含基线情景摘要列）。未登录 → 401。
 * POST：创建 V2 项目 + 基线情景。门禁：CSRF 同源 + **必须登录**；
 *       ownerId 由服务端会话强制注入，绝不接受客户端传入（防冒名）。
 *       服务端**现算**落库（不搬页面数字）：改参数 → 重跑引擎 → 结果变。
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return errorResponse("UNAUTHORIZED", "请先登录后查看我的项目", 401);
  return mutationResponse(await listMyDecisionProjects({ user }));
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后创建项目", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  return mutationResponse(await createDecisionProjectForUser({ user: actor.user, body: parsed.data }));
}
