import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/lib/api-client";
import { isAppError, type AppError } from "@/lib/errors";
import { REQUEST_ID_HEADER } from "@/lib/request-id";

/**
 * api-client 单元测试。
 *
 * 用 vi.stubGlobal 替换 fetch，构造各种响应/网络错误，验证：
 *   - URL 构造（baseUrl + path + query）
 *   - request-id 注入与透传
 *   - JSON body 序列化 + content-type
 *   - 非 2xx → 对应 AppError 子类
 *   - 幂等方法重试（GET 5xx/429）与非幂等不重试（POST）
 *   - 超时 / 网络错误转 UpstreamError
 */

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 等待一个"应当 reject"的 promise，把抛出的值以 AppError 类型返回（修复 TS18046 unknown）。 */
async function captureError<T>(promise: Promise<T>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected promise to reject, but it resolved");
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiClient — URL 构造", () => {
  it("joins baseUrl and path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new ApiClient({ baseUrl: "https://api.example.com/" });
    await client.get("/cases");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/cases");
  });

  it("appends query params, skipping null/undefined", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    await client.get("/cases", { query: { page: 2, q: "沼气", empty: null, undef: undefined } });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("q")).toBe("沼气");
    expect(url.searchParams.has("empty")).toBe(false);
    expect(url.searchParams.has("undef")).toBe(false);
  });

  it("supports absolute path without baseUrl", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient();
    await client.get("https://other.api/health");
    expect(fetchMock.mock.calls[0][0]).toBe("https://other.api/health");
  });
});

describe("ApiClient — request-id", () => {
  it("injects a generated x-request-id header", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    await client.get("/x");
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get(REQUEST_ID_HEADER)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it("reuses an explicit valid requestId", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    await client.get("/x", { requestId: "fixed-id-12345678" });
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get(REQUEST_ID_HEADER)).toBe("fixed-id-12345678");
  });

  it("ignores an invalid explicit requestId and generates one", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    await client.get("/x", { requestId: "bad\r\nid" });
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    const got = headers.get(REQUEST_ID_HEADER) as string;
    expect(got).not.toBe("bad\r\nid");
    expect(got).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });
});

describe("ApiClient — 请求体", () => {
  it("serializes json body and sets content-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    await client.post("/orders", { json: { id: 1, name: "方案 A" } });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ id: 1, name: "方案 A" }));
    expect((init.headers as Headers).get("content-type")).toBe("application/json");
  });

  it("merges defaultHeaders with per-request headers (per-request wins)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      defaultHeaders: { "x-api-key": "default", "x-trace": "base" },
    });
    await client.get("/x", { headers: { "x-trace": "override" } });
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("x-api-key")).toBe("default");
    expect(headers.get("x-trace")).toBe("override");
  });
});

describe("ApiClient — 响应解析", () => {
  it("parses JSON response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [1, 2, 3] }));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    const res = await client.get<{ data: number[] }>("/x");
    expect(res.data).toEqual([1, 2, 3]);
  });

  it("parses text response", async () => {
    fetchMock.mockResolvedValue(new Response("plain text", { status: 200, headers: { "content-type": "text/plain" } }));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    const res = await client.get<string>("/x");
    expect(res).toBe("plain text");
  });

  it("returns undefined for 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    const res = await client.delete("/x");
    expect(res).toBeUndefined();
  });
});

describe("ApiClient — 错误映射", () => {
  const cases: Array<[number, string]> = [
    [400, "ValidationError"],
    [401, "UnauthorizedError"],
    [403, "ForbiddenError"],
    [404, "NotFoundError"],
    [409, "ConflictError"],
    [429, "RateLimitedError"],
  ];

  it.each(cases)("maps HTTP %i to %s", async (status, name) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: { code: "X", message: "boom" } }));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    await expect(client.post("/x")).rejects.toMatchObject({ name });
  });

  it("maps 5xx to UpstreamError", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { message: "unavailable" } }));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    const err = await captureError(client.post("/x"));
    expect(isAppError(err)).toBe(true);
    expect(err.code).toBe("UPSTREAM_ERROR");
  });

  it("preserves upstream error code when body carries a known code", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, { error: { code: "VALIDATION_ERROR", message: "字段错误", details: { field: "email" } } }),
    );
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    const err = await captureError(client.post("/x"));
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.details).toMatchObject({ upstreamDetails: { field: "email" } });
  });

  it("handles non-JSON error body gracefully", async () => {
    fetchMock.mockResolvedValue(new Response("<html>500</html>", { status: 500, headers: { "content-type": "text/html" } }));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    const err = await captureError(client.post("/x"));
    expect(isAppError(err)).toBe(true);
    expect(err.message).toContain("500");
  });

  it("wraps network failure into UpstreamError", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const client = new ApiClient({ baseUrl: "https://api.example.com" });
    const err = await captureError(client.post("/x"));
    expect(isAppError(err)).toBe(true);
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.details).toMatchObject({ method: "POST" });
  });
});

describe("ApiClient — 重试", () => {
  it("retries idempotent GET on 503 up to maxAttempts", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: "down" } }))
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: "down" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const res = await client.get<{ ok: boolean }>("/x");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry non-idempotent POST", async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { message: "down" } }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    await expect(client.post("/x")).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws last error when retries are exhausted", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: "always down" } }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const err = await client.get("/x").catch((e) => e);
    expect(isAppError(err)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("retries on 429 when included in retryOnStatus", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "slow down" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      retry: { maxAttempts: 2, baseDelayMs: 1, retryOnStatus: [429] },
    });
    const res = await client.get<{ ok: boolean }>("/x");
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404 (not in retryOnStatus)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { message: "gone" } }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    await expect(client.get("/x")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ApiClient — 超时", () => {
  it("passes an AbortSignal to fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const client = new ApiClient({ baseUrl: "https://api.example.com", timeoutMs: 5_000 });
    await client.get("/x");
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
