import {
  AppError,
  type ErrorCode,
  isAppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitedError,
  DBError,
  UpstreamError,
} from "./errors";
import { REQUEST_ID_HEADER, generateRequestId, isValidRequestId } from "./request-id";

/**
 * API 客户端层 — 统一 fetch 封装。
 *
 * 设计目标（宪法第 5/7/20 条 + 总控第 31 节成本控制）：
 *   1. 所有出站/入站 HTTP 走同一入口，禁止业务代码裸 fetch；
 *   2. 自动注入 x-request-id（客户端可复用，便于重试追踪）；
 *   3. 非 2xx 响应统一转成 AppError 子类，调用方只需 catch (e) { if (isAppError(e)) ... }；
 *   4. 超时控制（AbortSignal.timeout），避免上游卡死拖垮 Serverless 函数；
 *   5. 可选 retry（仅幂等方法 GET/HEAD/OPTIONS + 5xx/429），指数退避，默认关闭。
 *
 * 不做的事（宪法第 22 条 V1 不做）：
 *   - 不做请求缓存（Next.js fetch 自带 cache 选项，调用方按需传）；
 *   - 不做拦截器链/中间件洋葱（过度设计）；
 *   - 不做 multipart 流式上传（Phase 12 订单附件时再加）。
 */

export interface ApiClientOptions {
  /** 基础 URL（服务端调用外部 API 时必填；浏览器内调用本站 API 可省略，走相对路径）。 */
  baseUrl?: string;
  /** 默认超时毫秒数。默认 10_000。 */
  timeoutMs?: number;
  /** 默认请求头（会与每次调用的 headers 合并，后者优先）。 */
  defaultHeaders?: Record<string, string>;
  /** 重试配置（仅幂等方法生效）。 */
  retry?: RetryOptions;
}

export interface RetryOptions {
  /** 最大重试次数（不含首次）。默认 0（不重试）。 */
  maxAttempts?: number;
  /** 首次退避毫秒。默认 200。 */
  baseDelayMs?: number;
  /** 退避倍数。默认 2（指数）。 */
  factor?: number;
  /** 最大单次退避毫秒。默认 5_000。 */
  maxDelayMs?: number;
  /** 触发重试的状态码。默认 [429, 500, 502, 503, 504]。 */
  retryOnStatus?: number[];
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** JSON body（会自动序列化 + 设 content-type）。与 body 互斥。 */
  json?: unknown;
  /** 原始 body（与 json 互斥；json 优先）。 */
  body?: BodyInit | null;
  /** 查询参数（会自动 URLSearchParams 编码，跳过 undefined/null）。 */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** 单次请求超时覆盖。 */
  timeoutMs?: number;
  /** 单次请求重试覆盖。 */
  retry?: RetryOptions;
  /** 透传/覆盖 request-id（默认自动生成）。 */
  requestId?: string;
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_RETRY_STATUS = [429, 500, 502, 503, 504];

export class ApiClient {
  private readonly opts: Required<Pick<ApiClientOptions, "timeoutMs">> & ApiClientOptions;

  constructor(opts: ApiClientOptions = {}) {
    this.opts = { timeoutMs: 10_000, ...opts };
  }

  async request<TResponse = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    const url = this.buildUrl(path, options.query);
    const method = (options.method ?? "GET").toUpperCase();
    const requestId = this.resolveRequestId(options.requestId);

    const headers = new Headers(this.opts.defaultHeaders);
    if (options.headers) new Headers(options.headers as HeadersInit).forEach((v, k) => headers.set(k, v));
    headers.set(REQUEST_ID_HEADER, requestId);

    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (options.body !== undefined) {
      body = options.body as BodyInit;
    }

    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? 10_000;
    const retryOpts = options.retry ?? this.opts.retry ?? {};
    const canRetry = IDEMPOTENT_METHODS.has(method);
    const maxAttempts = canRetry ? Math.max(0, retryOpts.maxAttempts ?? 0) : 0;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = computeBackoff(attempt, retryOpts);
        await sleep(delay);
      }
      try {
        const response = await fetch(url, {
          ...options,
          method,
          headers,
          body,
          signal: options.signal ?? AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const appError = await toAppErrorFromResponse(response, requestId);
          const statusList = retryOpts.retryOnStatus ?? DEFAULT_RETRY_STATUS;
          if (attempt < maxAttempts && statusList.includes(response.status)) {
            lastError = appError;
            continue;
          }
          throw appError;
        }

        return await parseResponse<TResponse>(response);
      } catch (e) {
        // 网络层错误（超时/DNS/连接重置）也走重试判定
        const isRetryableNetwork =
          e instanceof Error &&
          (e.name === "TimeoutError" || e.name === "AbortError" || /fetch failed|network/i.test(e.message));
        if (attempt < maxAttempts && isRetryableNetwork) {
          lastError = e;
          continue;
        }
        if (isAppError(e)) throw e;
        throw new UpstreamError(
          `请求 ${method} ${url} 失败：${e instanceof Error ? e.message : String(e)}`,
          { cause: e, details: { requestId, url, method } },
        );
      }
    }
    // 重试耗尽
    throw lastError instanceof AppError
      ? lastError
      : new UpstreamError("重试耗尽", { cause: lastError, details: { requestId, url } });
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }
  post<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST" });
  }
  put<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "PUT" });
  }
  patch<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH" });
  }
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = this.opts.baseUrl ?? "";
    const isAbsolute = /^https?:\/\//i.test(path);
    const url = isAbsolute ? path : `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    if (!query) return url;
    const u = new URL(url, base || undefined);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
    // 当 base 为空且 path 是相对路径时，URL 需要 base 才能解析；上面已处理。
    return base ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
  }

  private resolveRequestId(explicit?: string): string {
    if (explicit && isValidRequestId(explicit)) return explicit;
    return generateRequestId();
  }
}

function computeBackoff(attempt: number, opts: RetryOptions): number {
  const base = opts.baseDelayMs ?? 200;
  const factor = opts.factor ?? 2;
  const max = opts.maxDelayMs ?? 5_000;
  const delay = base * Math.pow(factor, attempt - 1);
  // 加 ±20% 抖动，避免重试风暴同步化
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.min(max, Math.max(0, Math.round(delay + jitter)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function parseResponse<T>(response: Response): Promise<T> {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await response.json()) as T;
  }
  if (ct.startsWith("text/")) {
    return (await response.text()) as unknown as T;
  }
  // 204 / 二进制：返回 undefined，调用方按需处理
  if (response.status === 204) return undefined as unknown as T;
  return (await response.arrayBuffer()) as unknown as T;
}

const STATUS_TO_ERROR: Array<[number, new (msg: string, opts?: { cause?: unknown; details?: Record<string, unknown> }) => AppError]> = [
  [400, ValidationError],
  [401, UnauthorizedError],
  [403, ForbiddenError],
  [404, NotFoundError],
  [409, ConflictError],
  [429, RateLimitedError],
];

async function toAppErrorFromResponse(response: Response, requestId: string): Promise<AppError> {
  let parsed: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null = null;
  try {
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) parsed = await response.json();
  } catch {
    parsed = null;
  }

  const upstreamCode = parsed?.error?.code as ErrorCode | undefined;
  const upstreamMessage = parsed?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;
  const details = {
    requestId,
    status: response.status,
    ...(parsed?.error?.details ? { upstreamDetails: parsed.error.details } : {}),
  };

  // 优先用上游返回的 code 还原对应子类
  if (upstreamCode) {
    const Ctor = STATUS_TO_ERROR.find(([, c]) => new c("x").code === upstreamCode)?.[1];
    if (Ctor) return new Ctor(upstreamMessage, { details });
    if (upstreamCode === "DB_ERROR") return new DBError(upstreamMessage, { details });
    if (upstreamCode === "UPSTREAM_ERROR") return new UpstreamError(upstreamMessage, { details });
    if (upstreamCode === "RATE_LIMITED") return new RateLimitedError(upstreamMessage, { details });
    if (upstreamCode === "INTERNAL_ERROR") return new AppError("INTERNAL_ERROR", upstreamMessage, { details });
  }

  // 按 HTTP 状态码兜底
  const byStatus = STATUS_TO_ERROR.find(([s]) => s === response.status)?.[1];
  if (byStatus) return new byStatus(upstreamMessage, { details });
  if (response.status >= 500) return new UpstreamError(upstreamMessage, { details });
  return new AppError("INTERNAL_ERROR", upstreamMessage, { details, httpStatus: response.status });
}

/**
 * 默认单例：浏览器内调用本站 API（相对路径）。
 * 服务端调用外部 API 时应 new ApiClient({ baseUrl }) 自建实例，避免混用。
 */
export const apiClient = new ApiClient();
