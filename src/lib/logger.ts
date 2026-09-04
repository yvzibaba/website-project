/**
 * 结构化 JSON 日志器（薄壳，不依赖 pino）。
 *
 * 设计目标（宪法第 4 条 MVP 优先、第 20 条诚实）：
 *   - 输出 JSON 单行，便于后续接 ELK / Loki / Datadog；
 *   - 内置敏感字段脱敏（password/token/secret/apikey/database_url 等），
 *     避免误将 DATABASE_URL 或用户密码写进日志；
 *   - level 阈值控制，生产 info、开发 debug；
 *   - child(bindings) 支持模块级上下文（如 { module: "cases" }）。
 *
 * Phase 9 会引入 AI 调用成本 / Agent trace 记录，届时可在此之上扩展。
 */

export type Level =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

const LEVEL_PRIORITY: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "authorization",
  "auth",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "cookie",
  "set-cookie",
  "database_url",
  "db_url",
  "connection_string",
  "connectionstring",
  "private_key",
  "privatekey",
  "credit_card",
  "card_number",
  "cvv",
  "ssn",
]);

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function") return `[Function: ${(value as Function).name || "anonymous"}]`;
  if (t === "symbol") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined ? { cause: redact(value.cause, seen) } : {}),
    };
  }
  if (t === "object") {
    const obj = value as object;
    if (seen.has(obj)) return CIRCULAR;
    seen.add(obj);
    if (Array.isArray(obj)) return obj.map((v) => redact(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, seen);
    }
    return out;
  }
  return value;
}

export interface LogFields {
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly level: Level,
    private readonly bindings: LogFields = {},
  ) {}

  child(bindings: LogFields): Logger {
    return new Logger(this.level, { ...this.bindings, ...bindings });
  }

  /** 运行时改变 level（返回新实例，保持不可变）。 */
  withLevel(level: Level): Logger {
    return new Logger(level, this.bindings);
  }

  private write(lvl: Level, msg: string, fields?: LogFields): void {
    if (LEVEL_PRIORITY[lvl] < LEVEL_PRIORITY[this.level]) return;
    if (this.level === "silent") return;
    const merged = { ...this.bindings, ...(fields ?? {}) };
    const record = {
      level: lvl,
      time: new Date().toISOString(),
      msg,
      ...(redact(merged) as LogFields),
    };
    const line = JSON.stringify(record);
    const stream =
      LEVEL_PRIORITY[lvl] >= LEVEL_PRIORITY.error ? process.stderr : process.stdout;
    stream.write(line + "\n");
  }

  trace(msg: string, fields?: LogFields): void { this.write("trace", msg, fields); }
  debug(msg: string, fields?: LogFields): void { this.write("debug", msg, fields); }
  info(msg: string, fields?: LogFields): void  { this.write("info", msg, fields); }
  warn(msg: string, fields?: LogFields): void  { this.write("warn", msg, fields); }
  error(msg: string, fields?: LogFields): void { this.write("error", msg, fields); }
  fatal(msg: string, fields?: LogFields): void { this.write("fatal", msg, fields); }
}

function resolveDefaultLevel(): Level {
  const fromEnv = process.env.LOG_LEVEL as Level | undefined;
  if (fromEnv && fromEnv in LEVEL_PRIORITY) return fromEnv;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

export function createLogger(bindings: LogFields = {}, level?: Level): Logger {
  return new Logger(level ?? resolveDefaultLevel(), bindings);
}

/** 应用级默认 logger。业务代码可 `logger.child({ module: "cases" })` 派生子 logger。 */
export const logger: Logger = createLogger({ app: "website-project" });

/** 仅用于测试：暴露脱敏函数。 */
export const __redact = redact;
