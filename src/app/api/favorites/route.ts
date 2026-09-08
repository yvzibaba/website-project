import type { NextResponse } from "next/server";
import {
  requireSameOriginActor,
  readJsonSafe,
  mutationResponse,
  errorResponse,
} from "@/server/api-guard";
import { addFavorite, removeFavorite } from "@/server/favorites";

/**
 * /api/favorites — 收藏的添加（POST）/ 移除（DELETE）（Phase 4 模块 C）。
 *
 * 门禁：CSRF 同源 + 必须登录（游客 401，提示语引导登录）。
 * body：`{ targetType: "CASE" | "SOLUTION", targetId }`；两条方法共用同一 zod 契约。
 * 语义：添加幂等（upsert，重复不报错）；移除幂等（deleteMany，未收藏也 ok）。
 * 目标不存在 → not_found（404），不产生悬挂收藏。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后收藏", 401);
  }
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await addFavorite(parsed.data, actor.user);
  return mutationResponse(result);
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后操作收藏", 401);
  }
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await removeFavorite(parsed.data, actor.user);
  return mutationResponse(result);
}
