import type { NextResponse } from "next/server";
import {
  requireSameOriginActor,
  readJsonSafe,
  mutationResponse,
  errorResponse,
} from "@/server/api-guard";
import { copySandboxProject } from "@/server/sandbox-projects";

/**
 * /api/sandbox/projects/[id]/copy — 复制一个沙盘项目（Phase 4 模块 B，§四「复制」）。
 *
 * 门禁：CSRF 同源 + 必须登录（游客 401）+ 资源级 owner-or-staff（在编排层动库前判定）。
 * 语义：读源项目基线情景参数分层 → createProject 现算重跑落库为**新项目**（新 id、独立版本线），
 * 副本 ownerId 恒为当前会话用户。可选 body `{ name? }`；缺省名 = 「源名（副本）」。
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后复制沙盘项目", 401);
  }
  const { id } = await params;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await copySandboxProject(id, parsed.data, { user: actor.user });
  return mutationResponse(result);
}
