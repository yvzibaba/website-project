import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { restoreSandboxScenarioVersion } from "@/server/sandbox-projects";

/**
 * /api/sandbox/scenarios/[id]/restore (POST) — 回滚到某历史版本（R6.3）。
 *
 * 语义（§4 / 规则 7 可复算）：取该版本的参数分层 → **重新跑引擎**写回情景当前态（version++）；
 *   刻意重算而非直接搬旧 calcResult——引擎升版后回滚会得到同参数下的最新结果，且 now/政策窗随版本一起回放。
 * 门禁：CSRF + 登录 + owner-or-staff；store 侧还会挡「版本不属于此情景」（forbidden→403）。
 * 请求体 `{ versionId }`。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后回滚沙盘版本", 401);
  }
  const { id } = await params;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;
  const result = await restoreSandboxScenarioVersion(id, parsed.data, { user: actor.user });
  return mutationResponse(result);
}
