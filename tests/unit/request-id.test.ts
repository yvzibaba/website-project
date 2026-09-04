import { describe, it, expect } from "vitest";
import {
  REQUEST_ID_HEADER,
  generateRequestId,
  isValidRequestId,
  extractOrGenerateRequestId,
  sanitizeForLog,
} from "@/lib/request-id";

describe("request-id — 生成", () => {
  it("exposes the canonical header name", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it("generates a UUID-shaped id", () => {
    const id = generateRequestId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("generates unique ids across many calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(generateRequestId());
    expect(ids.size).toBe(10_000);
  });
});

describe("request-id — 校验", () => {
  it("accepts alphanumeric + hyphen within 8..64 chars", () => {
    expect(isValidRequestId("abcdefgh")).toBe(true);
    expect(isValidRequestId("req_1234567890_abc")).toBe(false); // 下划线不在白名单
    expect(isValidRequestId("a".repeat(64))).toBe(true);
    expect(isValidRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects too-short or too-long values", () => {
    expect(isValidRequestId("abc")).toBe(false); // < 8
    expect(isValidRequestId("a".repeat(65))).toBe(false); // > 64
  });

  it("rejects null/undefined/non-string", () => {
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId(undefined)).toBe(false);
  });

  it("rejects CRLF / control characters (log injection guard)", () => {
    expect(isValidRequestId("abcdef\r\ngh")).toBe(false);
    expect(isValidRequestId("abcdef\u0000gh")).toBe(false);
    expect(isValidRequestId("abcdef gh")).toBe(false); // 空格非法
  });
});

describe("request-id — 提取或生成", () => {
  it("adopts a valid client-provided id", () => {
    const client = "550e8400-e29b-41d4-a716-446655440000";
    const r = extractOrGenerateRequestId(client);
    expect(r).toEqual({ requestId: client, fromClient: true });
  });

  it("generates a fresh id when client value is invalid", () => {
    const r = extractOrGenerateRequestId("bad\r\nid");
    expect(r.fromClient).toBe(false);
    expect(isValidRequestId(r.requestId)).toBe(true);
  });

  it("generates a fresh id when header is absent", () => {
    const r = extractOrGenerateRequestId(null);
    expect(r.fromClient).toBe(false);
    expect(isValidRequestId(r.requestId)).toBe(true);
  });
});

describe("request-id — 日志净化", () => {
  it("strips control characters including CRLF", () => {
    expect(sanitizeForLog("a\r\nb")).toBe("ab");
    expect(sanitizeForLog("a\u0000b\u001fc\u007fd")).toBe("abcd");
  });

  it("leaves normal text untouched", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(sanitizeForLog(id)).toBe(id);
  });
});
