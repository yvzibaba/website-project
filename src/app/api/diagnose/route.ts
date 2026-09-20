import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { diagnoseFree } from "@app/kernel/server/decision-service";

/**
 * `/api/diagnose` —— **免登录免费诊断**（M4 · P5：免费层先给结论倾向，不只丢一张表单）。
 *
 * 与 `/decision/recommend` 的分工：
 *   - `recommend` 要求登录（它是"把手上的项目调到最优"，且单次跑上千套配置，算力贵）；
 *   - 本端点**允许游客**（它是公开漏斗的第一屏，回答"我这项目大方向成不成立"），
 *     单次只跑**一套**配置、约 27 ms，代价可控。
 *
 * 命脉：诊断结论出自唯一生产引擎（`diagnoseFree → diagnoseScenario → runCalculation`），
 * 不另写"轻量算法"，所以免费看到的数与登录后保存后算出的数**不可能分叉**。
 *
 * 门禁（本层唯一防刷手段，与 `/api/leads` 同一诚实边界）：
 *   - CSRF 同源（`requireSameOriginActor`，游客也过这一关，只是不要求登录）；
 *   - 按客户端 IP 的进程内存级滑动窗口：60 秒内最多 8 次（诊断比留资更"值得多点几次看看"，
 *     故比 leads 的 3 次略宽，但仍拦得住无脑刷）；命中 → 429。
 *   - **诚实边界**：非分布式、重启清零、拦不住代理 IP 池；真要上验证码 / WAF 属后续，
 *     刻意不在免费层堆依赖（宪法：更少依赖 / 更简单）。
 *
 * 不读写任何项目数据：输入完全来自请求体，无越权资源，故无 owner 判断。
 */
export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_HITS = 8;
const MAX_KEYS = 5000;

// 进程内存级：Map<ip, number[]>。单实例内共享，重启即清零（诚实边界见文件头注释）。
const hits = new Map<string, number[]>();

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function rateLimitAllow(ip: string, now: number): boolean {
  const cutoff = now - WINDOW_MS;
  const arr = (hits.get(ip) ?? []).filter((t) => t > cutoff);
  arr.push(now);
  const allowed = arr.length <= MAX_HITS;
  hits.set(ip, arr);
  if (hits.size > MAX_KEYS) {
    const dropCount = Math.ceil(hits.size / 2);
    let dropped = 0;
    for (const k of hits.keys()) {
      hits.delete(k);
      if (++dropped >= dropCount) break;
    }
  }
  return allowed;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request);
  if (!rateLimitAllow(ip, Date.now())) {
    return errorResponse("RATE_LIMITED", "诊断过于频繁，请稍后再试", 429);
  }

  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  return mutationResponse(diagnoseFree({ body: parsed.data }));
}
