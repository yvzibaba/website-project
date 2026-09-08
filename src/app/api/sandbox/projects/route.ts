import type { NextResponse } from "next/server";
import {
  requireSameOriginActor,
  readJsonSafe,
  mutationResponse,
  errorResponse,
} from "@/server/api-guard";
import { getCurrentUser } from "@/server/authz";
import { createSandboxProject, listSandboxProjects } from "@/server/sandbox-projects";

/**
 * /api/sandbox/projects — 沙盘项目集合端点（Phase 4 模块 B 扩展）。
 *
 * POST：从「当前沙盘情景」创建一个持久化项目（含基线情景）（中途重构 R6.3）。
 *   门禁：CSRF 同源 + **必须登录**（游客 401）。ownerId 由服务端会话强制注入，绝不接受客户端传入（防冒名）。
 *   命脉（§4）：body 里的 `layers` 交给 `sandbox-store` 现算落库（服务端重跑引擎，非搬页面数字）；
 *   R6.3 起服务端会复活 `now` 与政策日期窗，确保落库结果与用户在页面上看到的**逐位一致**。
 *   请求体 `{ name, description?, regionId?, layers }`；结果判别联合由 `mutationResponse` 统一翻译。
 *
 * GET（Phase 4 模块 B）：列出**当前会话用户自己的**项目（含基线情景摘要列），供「我的项目」列表。
 *   未登录 → 401；只透出展示/摘要列，不外泄大 JSON。
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return errorResponse("UNAUTHORIZED", "请先登录后查看我的项目", 401);
  }
  const result = await listSandboxProjects({ user });
  return mutationResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后保存沙盘项目", 401);
  }
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await createSandboxProject(parsed.data, { user: actor.user });
  return mutationResponse(result);
}
