import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { calculatePreview } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/projects/[id]/calculate` —— **唯一的生产计算入口**（只算不存）。
 *
 * 为什么把它放在这里、而不是让界面自己拼结果：
 *   工作台需要「改一个参数先看看会怎样」。若为这种预览另写一套轻量算法，
 *   页面上看到的数与保存后的数就会不一致——这是本项目最不能接受的失败方式。
 *   因此预览与落库共用同一个 `runCalculation()`，本端点只是把它原样返回。
 *
 * 为什么不校验项目归属：本端点**不读也不写任何项目数据**，输入完全来自请求体，
 * 因此没有可越权的资源。仍然要求登录，避免它被当作匿名的公开算力入口。
 *
 * 返回：`{ calculated: true, result, report }` 或
 *      `{ calculated: false, reason, detail, diagnostics }`——
 *      失败时**绝不**返回半成品结果。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) return errorResponse("UNAUTHORIZED", "请先登录后使用计算", 401);

  // 路由段 [id] 用于把计算绑定到「正在编辑哪个项目」的语义上（审计与限流），
  // 但本端点不据此读写数据库，故不解析成查询条件。
  await params;

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  return mutationResponse(calculatePreview({ body: parsed.data }));
}
