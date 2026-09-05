import type { NextResponse } from "next/server";
import {
  requireSameOriginActor,
  readJsonSafe,
  mutationResponse,
  errorResponse,
} from "@/server/api-guard";
import { createDbCallRecorder } from "@/server/model-calls";
import { explainSandboxScenario, sandboxReportInputSchema } from "@/server/sandbox-explain";

/**
 * /api/sandbox/explain — 对**当前沙盘情景的确定性报告**追加一段 AI 自然语言解释（中途重构 R6.2）。
 *
 * 门禁：CSRF 同源 + **必须登录**（`requireSameOriginActor` 只做同源并注入服务端会话身份，再判 user）。
 *   刻意要求登录而非放行游客：真实 DeepSeek 会花真金白银、且 §31 成本须可归因到某人；无密钥进不了服务端
 *   （密钥仅 env，绝不进 bundle）。这既是「谁能烧钱」的最小诚实门禁，也不像 requireStaffWrite 那样把普通
 *   用户挡在演示之外（沙盘是给人人看的决策演示，登录即可解释，无需 staff 角色）。
 *
 * 铁律（§7 / 第 16 条）：LLM **只解释不算数**——输入是前端已算好的 `SandboxReport`（其数字全来自引擎），
 *   服务端不重算、不接受客户端传入的「新结论」，只把报告原样喂给编排器解释；成本经 ModelCall 记录器落库。
 *   请求体 `{ report: SandboxReport, question?: string }`；判别联合由 `mutationResponse` 统一翻译。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // 1) CSRF + 身份（游客先挡一道登录）。
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  if (!actor.user) {
    return errorResponse("UNAUTHORIZED", "请先登录后使用 AI 解释（该项会消耗真实模型额度、需归因到人）", 401);
  }

  // 2) 解析并结构校验报告（不合规则 400，绝不把脏结构喂给模型）。
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.data ?? {}) as Record<string, unknown>;
  const reportParse = sandboxReportInputSchema.safeParse(body.report);
  if (!reportParse.success) {
    return errorResponse("VALIDATION_ERROR", "报告结构不合法", 400, {
      fields: { report: reportParse.error.issues.map((i) => i.message).slice(0, 8) },
    });
  }
  const question = typeof body.question === "string" ? body.question : undefined;

  // 3) 请求作用域落库记录器（§31）：把本次解释的 CallRecord 持久化到 ModelCall，响应前 await flush。
  const recorder = createDbCallRecorder();
  const result = await explainSandboxScenario(reportParse.data, { question }, { recorder });
  await recorder.flush();

  // 4) 统一翻译（ok→200 · blocked→409（报告不完整拒解释）· error→500 · invalid→400）。
  return mutationResponse(result);
}
