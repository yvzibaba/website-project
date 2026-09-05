import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { updateSandboxScenario } from "@/server/sandbox-projects";

/**
 * /api/sandbox/scenarios/[id] (PUT) — 改某情景的参数分层 → **服务端重跑引擎**落新快照（version++）（R6.3）。
 *
 * 门禁：CSRF + 登录 + owner-or-staff。这是 §4 命脉在持久层的落点：改参数 → 服务端重算 → 结果变，
 *   而非把页面数字搬回数据库；`layers` 原样交编排层（含 now / 政策日期窗），由 store 复活后喂引擎。
 * 请求体 `{ layers }`；结果判别联合由 `mutationResponse` 统一翻译。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function PUT(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后修改沙盘情景", 401);
  }
  const { id } = await params;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await updateSandboxScenario(id, parsed.data, { user: actor.user });
  return mutationResponse(result);
}
