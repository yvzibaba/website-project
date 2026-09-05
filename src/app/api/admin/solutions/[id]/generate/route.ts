import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe } from "@/server/api-guard";
import { generateSolutionContent } from "@/server/solution-generation";
import { createDbCallRecorder } from "@/server/model-calls";

/**
 * /api/admin/solutions/[id]/generate — 触发一条 §33 多角色流水线为该**草稿**方案生成正文并落库
 * （Phase 8 M3，受 requireStaffWrite 门禁；生产环境经 createChatProvider 走真实模型、无 key 回落确定性桩）。
 *
 * 刻意边界：只写 `Solution.body` 分节，**永不自动发布**（发布仍走 PATCH + publishGuard 由人决定）；
 * 已发布方案直接返回 409（不自动改写线上正文）。可选请求体 `{ question?: string }` 覆写研究问题。
 */
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const data = parsed.data as Record<string, unknown> | null;
  const rawQuestion = data && typeof data.question === "string" ? data.question : undefined;
  // 长度兜底（防超长 prompt 灌入）；非法/缺失 → undefined 交编排器派生默认问题。
  const question = rawQuestion && rawQuestion.trim().length > 0 ? rawQuestion.trim().slice(0, 2000) : undefined;

  // 请求作用域的落库记录器：把流水线各角色的 CallRecord（成本/延迟/状态/归因）持久化到 ModelCall 表（Phase 9 M5 / §31）。
  const recorder = createDbCallRecorder();
  const result = await generateSolutionContent(id, { question, recorder });
  // 等在途成本写入落定再响应（§31 成本可追踪；观测失败仍被 recorder 内部吞掉、不影响本次结果）。
  await recorder.flush();
  return mutationResponse(result);
}
