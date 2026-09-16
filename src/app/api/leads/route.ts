import type { NextResponse } from "next/server";
import { requireSameOriginActor, readJsonSafe, mutationResponse, errorResponse } from "@/server/api-guard";
import { createLead } from "@/server/leads";

/**
 * /api/leads — 公开留资（RFQ）提交（V1.1 P4 · 商业闭环最小可用）。
 *
 * 门禁：CSRF 同源 + **允许游客**（同 /api/feedback 策略，不要求 staff）。
 * userId 归因只来自服务端会话（登录则记、游客则空），绝不取自请求体。
 *
 * 频控（本层唯一防刷手段）：
 *   - 单实例**进程内存级**滑动窗口，按客户端 IP（x-forwarded-for 首段）计，
 *     60 秒内最多 3 次；键数上限 5000 防内存膨胀，超过则清最早一半（LRU-ish 简版）。
 *   - **诚实边界**：非分布式、重启即清零，也拦不住代理 IP 池——留资表单的兜底其实是
 *     「后台人工阅读 + 1 个工作日内联系」的流程承诺，不是自动化风控；
 *     接真·验证码 / 上游 WAF 属 V1-B（刻意暂不做，宪法：更少依赖 / 更简单）。
 *   - 命中限流 → 429 RATE_LIMITED（错误体与全站一致）。
 */
export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_HITS = 3;
const MAX_KEYS = 5000;

// 进程内存级：Map<ip, number[]>。仅在单实例内共享，重启即清零（本文件顶部已注释诚实边界）。
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
  if (arr.length > MAX_HITS) {
    // 未通过：仍回写窗口（保持"继续刷仍继续拦"的语义），但**不**放宽。
    hits.set(ip, arr);
    return false;
  }
  hits.set(ip, arr);
  // 简易内存回收：键数超阈值时清最早一半（Map 保持插入序，遍历时先到的即更早写入）。
  if (hits.size > MAX_KEYS) {
    const dropCount = Math.ceil(hits.size / 2);
    let dropped = 0;
    for (const k of hits.keys()) {
      hits.delete(k);
      if (++dropped >= dropCount) break;
    }
  }
  return true;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request);
  if (!rateLimitAllow(ip, Date.now())) {
    return errorResponse("RATE_LIMITED", "提交过于频繁，请稍后再试", 429);
  }
  const actor = await requireSameOriginActor(request);
  if (!actor.ok) return actor.response;
  const parsed = await readJsonSafe(request);
  if (!parsed.ok) return parsed.response;

  const result = await createLead(parsed.data, actor.user);
  return mutationResponse(result);
}
