import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { recommendPreview } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/recommend` —— **自动推荐**（配置寻优，只算不存）。
 *
 * 与 `/decision/projects/[id]/calculate` 的关系：
 *   后者算「你给的那一套」配置，前者算「一整个配置空间」并给出推荐。
 *   两者共用同一个 `runCalculation()` 与同一个输入契约，因此
 *   「推荐时看到的数」与「按推荐保存后算出来的数」在结构上一致。
 *
 * 为什么这条路径必须存在：
 *   如果只提供"你填参数、我给数字"，那么**搜索是用户在替软件做**——
 *   他得自己猜十几套配置、逐套填、逐套比。自动推荐把这项工作拿回来，
 *   这才对得起"项目决策平台"这个定位（而不是"参数计算器"）。
 *
 * 为什么不读写项目数据：本端点输入完全来自请求体，没有可越权的资源，
 * 因此不需要项目级授权；但仍然要求登录，避免它变成匿名的公开算力入口。
 *
 * 返回：`{ recommended: true, result }` 或
 *      `{ recommended: false, reason, detail, diagnostics }`——
 *      失败时**绝不**返回半成品推荐。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后使用自动推荐", 401);

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  return mutationResponse(recommendPreview({ body: parsed.data }));
}
