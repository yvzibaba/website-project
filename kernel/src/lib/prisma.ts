import { PrismaClient } from "@prisma/client";

/**
 * Prisma Client 单例。
 *
 * 为什么需要这个模式：
 *   Next.js 开发模式的热重载会多次执行模块，如果每次 `new PrismaClient()`
 *   都会打开一批新连接，很快耗尽 Neon 免费层的连接池。
 *   把实例挂到 globalThis 上可以在热重载之间复用同一个 client。
 *
 * 生产环境（NODE_ENV=production）不会热重载，但保留 globalThis 挂载也无害。
 *
 * 日志策略（宪法第 20 条诚实、第 5 条可验证）：
 *   - development：query + error + warn，方便调试；
 *   - test：仅 error，避免测试输出被查询日志淹没；
 *   - production：仅 error，减少噪音；query 日志后续由 logger 结构化输出。
 */

const globalForPrisma = globalThis as unknown as {
  __prismaClient?: PrismaClient;
};

function buildLogLevels(): Array<"query" | "info" | "warn" | "error"> {
  const env = process.env.NODE_ENV;
  if (env === "development") return ["query", "warn", "error"];
  if (env === "test") return ["error"];
  return ["error"];
}

export const prisma: PrismaClient =
  globalForPrisma.__prismaClient ??
  new PrismaClient({
    log: buildLogLevels(),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prismaClient = prisma;
}

/** 显式关闭（仅测试与脚本用；应用运行时不应主动 disconnect）。 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
