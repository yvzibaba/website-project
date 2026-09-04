import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { toErrorResponse } from "@/lib/errors";
import { REQUEST_ID_HEADER, isValidRequestId } from "@/lib/request-id";

/**
 * GET /api/health
 *
 * 健康检查端点。返回：
 *   - ok: 服务自身是否活着
 *   - db.ok: Postgres 是否可 SELECT 1
 *   - db.latency_ms: DB 往返延迟（Neon us-east-2 冷启动首次约 800–1500ms，热起来 100–300ms）
 *   - uptime_sec: Node 进程运行时长
 *   - version: package.json 版本
 *   - timestamp: ISO8601
 *   - requestId: 本次请求的追踪 id（与响应头 x-request-id 一致）
 *
 * 用途：
 *   1. Phase 4 冒烟：证明"Next.js Route Handler → Prisma Client → Neon"整条链路通；
 *   2. Phase 16 部署后作为 uptime monitoring 探针；
 *   3. 开发时随时 curl 一下确认服务健康。
 *
 * request-id 链路（Phase 4 里程碑 3）：
 *   proxy.ts 已在响应头写入 x-request-id；这里再从请求头读回并放进 JSON body，
 *   方便前端/监控同时从 header 和 body 拿到 id 做关联（宪法第 20 条可追溯）。
 *
 * force-dynamic：禁用静态化，每次都真跑一次 DB 查询。
 */
export const dynamic = "force-dynamic";

const log = logger.child({ module: "api/health" });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  const incomingId = request.headers.get(REQUEST_ID_HEADER);
  const requestId = isValidRequestId(incomingId) ? incomingId : undefined;
  const childLog = requestId ? log.child({ requestId }) : log;

  try {
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - startedAt;
    childLog.debug("health ok", { dbLatencyMs });
    return NextResponse.json({
      ok: true,
      service: "website-project",
      version: process.env.npm_package_version ?? "0.27.0",
      node: process.version,
      uptime_sec: Math.floor(process.uptime()),
      db: { ok: true, latency_ms: dbLatencyMs },
      timestamp: new Date().toISOString(),
      ...(requestId ? { requestId } : {}),
    });
  } catch (err) {
    childLog.error("health check failed", { err });
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(
      {
        ok: false,
        db: { ok: false },
        ...body,
        timestamp: new Date().toISOString(),
        ...(requestId ? { requestId } : {}),
      },
      { status },
    );
  }
}
