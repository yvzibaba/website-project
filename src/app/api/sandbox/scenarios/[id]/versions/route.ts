import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import type { SessionUser } from "@/server/authz";
import { saveSandboxScenarioVersion, readSandboxScenarioVersions } from "@/server/sandbox-projects";

/**
 * /api/sandbox/scenarios/[id]/versions — 版本时间线（R6.3）。
 *
 *  POST：把情景**当前已算好**的态冻结为一个不可变版本（seq = 该场景 max+1），供回滚 / 逐版本报告（§9 / 规则 13）。
 *  GET ：列某情景的版本时间线（倒序，精简字段）。
 * 门禁：CSRF + 登录 + owner-or-staff；越权在动库前拦（forbidden→403）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

async function actorOrFail(request: Request): Promise<
  { user: SessionUser } | { response: NextResponse }
> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return { response: actor.response };
  if (!actor.user) return { response: errorResponse("UNAUTHORIZED", "请先登录后操作沙盘版本", 401) };
  return { user: actor.user };
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const gate = await actorOrFail(request);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;
  const result = await saveSandboxScenarioVersion(id, parsed.data, { user: gate.user });
  return mutationResponse(result);
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const gate = await actorOrFail(request);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  const result = await readSandboxScenarioVersions(id, { user: gate.user });
  return mutationResponse(result);
}
