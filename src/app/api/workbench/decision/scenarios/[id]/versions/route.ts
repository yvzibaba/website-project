import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import type { SessionUser } from "@/server/authz";
import { saveDecisionVersion, readDecisionVersions } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/scenarios/[id]/versions` —— V2 情景的**版本时间线**（R5 版本治理）。
 *
 *  GET ：列该情景已冻结的不可变版本（回看「这一版当时按哪个 engine/benchmark/schema、哪份输入哈希算的、为什么变」）。
 *        纯读提取，绝不重算——历史数字保持冻结时的原样。
 *  POST ：把情景**当前已存**的结果显式冻结为一个新版本（打里程碑，不改当前态）。
 *
 * 与 V1 的 `/api/workbench/scenarios/[id]/versions` 分属两套语义（V1 年度沙盘 / V2 决策平台），
 * 各走各自的 service；同存于 ProjectVersion 表但列切片互不串台（见 schema R5 注释）。
 * 门禁：同源 + 登录 + owner-or-staff；越权在动库前拦（forbidden→403）。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

async function actorOrFail(request: Request): Promise<{ user: SessionUser } | { response: NextResponse }> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return { response: actor.response };
  if (!actor.user) return { response: errorResponse("UNAUTHORIZED", "请先登录后操作决策版本", 401) };
  return { user: actor.user };
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const gate = await actorOrFail(request);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  return mutationResponse(await readDecisionVersions({ scenarioId: id, user: gate.user }));
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const gate = await actorOrFail(request);
  if ("response" in gate) return gate.response;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;
  const { id } = await params;
  return mutationResponse(await saveDecisionVersion({ scenarioId: id, user: gate.user, body: parsed.data }));
}
