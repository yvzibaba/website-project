/**
 * AppError 层级 + 统一错误响应转换。
 *
 * 设计目标（宪法第 5/7/20 条）：
 *   - 业务错误必须携带机器可读 code + 人类可读 message + 可选 details；
 *   - HTTP 状态码从 code 派生，避免每处手写出错；
 *   - 支持 cause（原生 Error cause 语义），保留原始错误上下文；
 *   - toErrorResponse() 是唯一把错误转成 API 响应的入口，禁止业务代码直接 return { error: e.message }。
 *
 * Phase 5+ 的 API Route 应统一：
 *   try { ... } catch (e) { const { status, body } = toErrorResponse(e); return NextResponse.json(body, { status }); }
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "DB_ERROR"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

const CODE_TO_HTTP: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  DB_ERROR: 500,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export interface AppErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
  /** 覆盖 code 派生的默认 HTTP 状态码。 */
  httpStatus?: number;
}

export interface SerializedError {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;
  /** 结构化标志位，便于跨 realm（例如 Edge / Node）识别。 */
  readonly isAppError = true as const;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = opts.httpStatus ?? CODE_TO_HTTP[code] ?? 500;
    if (opts.details !== undefined) this.details = opts.details;
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): SerializedError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("VALIDATION_ERROR", message, opts);
    this.name = "ValidationError";
  }
}
export class UnauthorizedError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("UNAUTHORIZED", message, opts);
    this.name = "UnauthorizedError";
  }
}
export class ForbiddenError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("FORBIDDEN", message, opts);
    this.name = "ForbiddenError";
  }
}
export class NotFoundError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("NOT_FOUND", message, opts);
    this.name = "NotFoundError";
  }
}
export class ConflictError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("CONFLICT", message, opts);
    this.name = "ConflictError";
  }
}
export class RateLimitedError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("RATE_LIMITED", message, opts);
    this.name = "RateLimitedError";
  }
}
export class DBError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("DB_ERROR", message, opts);
    this.name = "DBError";
  }
}
export class UpstreamError extends AppError {
  constructor(message: string, opts?: AppErrorOptions) {
    super("UPSTREAM_ERROR", message, opts);
    this.name = "UpstreamError";
  }
}

/** 跨 realm 安全的 AppError 判定。 */
export function isAppError(e: unknown): e is AppError {
  if (e instanceof AppError) return true;
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { isAppError?: unknown }).isAppError === true &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

export interface ErrorResponseBody {
  status: number;
  body: SerializedError;
}

/**
 * 把任意 thrown value 转成 API 响应可用的 { status, body }。
 * 对非 AppError（含 Prisma 已知错误代码）会做基础映射，其余归为 INTERNAL_ERROR。
 * 生产环境不返回原始错误 message，避免泄露内部细节（宪法第 21 条安全）。
 */
export function toErrorResponse(e: unknown): ErrorResponseBody {
  if (isAppError(e)) {
    return { status: e.httpStatus, body: e.toJSON() };
  }

  // Prisma 已知错误码映射（P2002 唯一约束、P2025 记录不存在等）
  const prismaCode = (e as { code?: string } | null)?.code;
  if (typeof prismaCode === "string" && /^P\d{4}$/.test(prismaCode)) {
    if (prismaCode === "P2002") {
      return {
        status: 409,
        body: { error: { code: "CONFLICT", message: "唯一约束冲突" } },
      };
    }
    if (prismaCode === "P2025") {
      return {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "记录不存在" } },
      };
    }
    return {
      status: 500,
      body: { error: { code: "DB_ERROR", message: `数据库错误 (${prismaCode})` } },
    };
  }

  const isProd = process.env.NODE_ENV === "production";
  const rawMessage = e instanceof Error ? e.message : String(e);
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: isProd ? "服务器内部错误" : rawMessage,
      },
    },
  };
}
