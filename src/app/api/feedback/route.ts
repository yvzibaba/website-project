import type { NextResponse } from "next/server";
import {
  requireSameOriginActor,
  readJsonSafe,
  mutationResponse,
} from "@/server/api-guard";
import { createFeedback } from "@/server/feedback";

/**
 * /api/feedback — 公开反馈提交（Phase 4 模块 C）。
 *
 * 门禁：CSRF 同源（requireSameOriginActor）+ **允许匿名**（未登录照样收）。
 * userId 归因只来自服务端会话（登录则记、匿名则空），绝不取自请求体（SECURITY）。
 * body：`{ kind, message, email?, page? }`；zod 白名单 + 长度上限在数据层。
 * 已知取舍：无验证码/频率限制（公开端点可被刷，P2 记录在完成报告，绝不静默假装已防护）。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await createFeedback(parsed.data, actor.user);
  return mutationResponse(result);
}
