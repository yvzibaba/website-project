import { z } from "zod";

/**
 * Server-side environment schema.
 *
 * 宪法第 5 条（可验证）+ 第 20 条（诚实）：
 *   - 环境变量必须在运行时通过 Zod 校验后才被业务代码使用；
 *   - 校验失败时抛出可读的错误，列出所有出错字段，避免"隐式默认值 → 生产事故"。
 *
 * 客户端可见的变量必须以 `NEXT_PUBLIC_` 前缀，本文件只处理服务端。
 *
 * 使用方式：
 *   import { getEnv } from "@/lib/env";
 *   const env = getEnv();  // 惰性求值 + 单例缓存
 */

const ServerEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgresql://") || v.startsWith("postgres://"),
      "DATABASE_URL must be a postgresql:// or postgres:// URL",
    ),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // 站点公开 URL（用于 metadataBase、绝对链接、sitemap）。开发环境可缺省，走默认值。
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let _cached: ServerEnv | null = null;

/**
 * 惰性解析 process.env。首次调用时校验，之后返回缓存对象。
 * @throws Error 当必需字段缺失或格式非法时，抛出含字段级细节的错误。
 */
export function getEnv(): ServerEnv {
  if (_cached) return _cached;
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment variables:\n${lines.join("\n")}\n` +
        `Hint: copy .env.example to .env and fill in real values.`,
    );
  }
  _cached = parsed.data;
  return _cached;
}

/**
 * 仅用于测试：清空缓存，让下一次 getEnv() 重新读 process.env。
 */
export function __resetEnvCache(): void {
  _cached = null;
}
