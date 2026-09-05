import type { NextResponse } from "next/server";
import { requireSameOriginActor, mutationResponse, errorResponse } from "@/server/api-guard";
import { readSandboxProject } from "@/server/sandbox-projects";

/**
 * /api/sandbox/projects/[id] — 读回一个沙盘项目（含其情景列表精简视图）（中途重构 R6.3）。
 *
 * 门禁：CSRF 同源 + 登录 + **owner-or-staff**（越权在查库拿到 owner 后由编排层判 forbidden→403）。
 * 只回精简视图（不外泄大 JSON 快照 / Decimal），供 UI 载入历史项目继续编辑。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后访问沙盘项目", 401);
  }
  const { id } = await params;
  const result = await readSandboxProject(id, { user: actor.user });
  return mutationResponse(result);
}
