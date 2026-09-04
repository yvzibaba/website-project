import { NextResponse, type NextRequest } from "next/server";
import {
  REQUEST_ID_HEADER,
  isValidRequestId,
  sanitizeForLog,
} from "@/lib/request-id";

/**
 * Next.js 16 Proxy（原 middleware，16.x 重命名为 proxy.ts）。
 *
 * 职责（宪法第 20 条可追溯 / 第 21 条安全）：
 *   1. 为每个入站请求分配/透传 x-request-id，写回响应头，贯穿日志与错误响应；
 *   2. 输出结构化访问日志（JSON 一行），含 method/path/status/耗时/ua/ip 摘要；
 *   3. 基础安全头（X-Content-Type-Options / X-Frame-Options / Referrer-Policy）；
 *   4. 跳过静态资源与 Next 内部路径，避免噪音。
 *
 * 不做的事（宪法第 22 条 V1 不做）：
 *   - 不做认证/鉴权（Phase 6 用户系统时在 Route Handler 层做，proxy 保持轻量）；
 *   - 不做限流（Phase 9 AI Agent 成本闸门时再做，需要持久化计数器）；
 *   - 不做 i18n 重定向（V1 只有中文）。
 *
 * 运行环境：Next.js proxy 默认跑在 Edge Runtime。本文件只用到 NextResponse + 纯字符串处理，
 * 不 import node:* 模块，Edge 安全。request-id.ts 里的 randomUUID 走 node:crypto，
 * 因此这里用 extractOrGenerateRequestId 时注意：Edge 下需要 Web Crypto 兜底。
 * 为保持 Edge 兼容，本文件自带一个基于 Math.random + Date.now 的轻量 id 生成器，
 * 仅在客户端未传 id 时使用；服务端 Route Handler 仍可用 request-id.ts 的 UUID 版本。
 */

const SKIP_PREFIXES = ["/_next", "/favicon.ico"];
const SKIP_EXTENSIONS = [".js", ".css", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf"];

export const config = {
  // 排除静态资源，减少无意义日志
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function shouldSkip(pathname: string): boolean {
  if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (SKIP_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return true;
  return false;
}

/** Edge 兼容的 request-id 生成器（不依赖 node:crypto）。 */
function edgeGenerateRequestId(): string {
  // Edge Runtime 提供 Web Crypto randomUUID()，与 request-id.ts 的 node:crypto UUID 格式一致。
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // 极端兜底（无 Web Crypto）：用连字符保持字符集与 isValidRequestId 一致（不含下划线）。
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${time}-${rand}`;
}

function resolveRequestId(headerValue: string | null): { id: string; fromClient: boolean } {
  // 客户端自带合法 id：直接采纳，无需任何 node:* 依赖（Edge 安全）。
  if (isValidRequestId(headerValue)) {
    return { id: headerValue, fromClient: true };
  }
  // 服务端生成：优先 UUID（与 request-id.ts 一致），Edge 下 node:crypto 不可用时回落轻量生成器。
  return { id: edgeGenerateRequestId(), fromClient: false };
}

export function proxy(request: NextRequest): NextResponse {
  const start = performance.now();
  const { pathname, search } = request.nextUrl;
  const incomingId = request.headers.get(REQUEST_ID_HEADER);
  const { id: requestId, fromClient } = resolveRequestId(incomingId);
  const safeId = sanitizeForLog(requestId);

  // 把 request-id 注入下游请求头，让 Route Handler / Server Component 即使客户端没传也能读到
  // （NextResponse.next({ request: { headers } }) 是 Next.js 修改入站请求头的标准方式）。
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, safeId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, safeId);

  // 基础安全头（宪法第 21 条）。CSP 留到 Phase 14 上线前统一配（需要 nonce 机制）。
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  if (shouldSkip(pathname)) return response;

  const durationMs = Math.round(performance.now() - start);
  const ua = sanitizeForLog(request.headers.get("user-agent") ?? "");
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "";

  // 结构化访问日志（JSON 一行，便于后续接 Loki/CloudWatch）。
  // 注意：proxy 跑在 Edge，console.log 会被 Next 收集到函数日志。
  console.log(
    JSON.stringify({
      level: "info",
      type: "access",
      requestId: safeId,
      fromClient,
      method: request.method,
      path: sanitizeForLog(pathname),
      query: sanitizeForLog(search),
      durationMs,
      ua: ua.slice(0, 200),
      ip,
      timestamp: new Date().toISOString(),
    }),
  );

  return response;
}
