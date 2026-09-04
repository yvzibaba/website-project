import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { toErrorResponse } from "@/lib/errors";

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
 *
 * 用途：
 *   1. Phase 4 冒烟：证明"Next.js Route Handler → Prisma Client → Neon"整条链路通；
 *   2. Phase 16 部署后作为 uptime monitoring 探针；
 *   3. 开发时随时 curl 一下确认服务健康。
 *
 * force-dynamic：禁用静态化，每次都真跑一次 DB 查询。
 */
export const dynamic = "force-dynamic";

const log = logger.child({ module: "api/health" });

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - startedAt;
    log.debug("health ok", { dbLatencyMs });
    return NextResponse.json({
      ok: true,
      service: "website-project",
      version: process.env.npm_package_version ?? "0.4.0",
      node: process.version,
      uptime_sec: Math.floor(process.uptime()),
      db: { ok: true, latency_ms: dbLatencyMs },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log.error("health check failed", { err });
    const { status, body } = toErrorResponse(err);
    return NextResponse.json(
      {
        ok: false,
        db: { ok: false },
        ...body,
        timestamp: new Date().toISOString(),
      },
      { status },
    );
  }
}
