import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * env.ts 单元测试。
 *
 * 使用 vi.stubEnv / vi.unstubAllEnvs 修改 process.env（@types/node v22 把 NODE_ENV
 * 声明为只读，直接赋值会 TS 报错；stubEnv 内部走 Object.defineProperty，安全）。
 * 每个 case 之前还要重置 env.ts 的内部缓存，避免上一次解析结果被复用。
 */

beforeEach(async () => {
  vi.unstubAllEnvs();
  const { __resetEnvCache } = await import("@/lib/env");
  __resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function freshGetEnv() {
  const mod = await import("@/lib/env");
  mod.__resetEnvCache();
  return mod.getEnv;
}

describe("getEnv — happy paths", () => {
  it("accepts postgresql:// URL", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://u:p@ep-xxx.us-east-2.aws.neon.tech/db?sslmode=require",
    );
    vi.stubEnv("NODE_ENV", "test");
    const getEnv = await freshGetEnv();
    const env = getEnv();
    expect(env.DATABASE_URL).toContain("postgresql://");
    expect(env.NODE_ENV).toBe("test");
    expect(env.LOG_LEVEL).toBe("info"); // default
  });

  it("accepts postgres:// alias", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@h/db");
    vi.stubEnv("NODE_ENV", "test");
    const getEnv = await freshGetEnv();
    expect(getEnv().DATABASE_URL).toBe("postgres://u:p@h/db");
  });

  it("honors explicit NODE_ENV and LOG_LEVEL", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@h/db");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_LEVEL", "warn");
    const getEnv = await freshGetEnv();
    const env = getEnv();
    expect(env.NODE_ENV).toBe("production");
    expect(env.LOG_LEVEL).toBe("warn");
  });

  it("accepts optional NEXT_PUBLIC_SITE_URL when set to a valid URL", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@h/db");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.com");
    const getEnv = await freshGetEnv();
    expect(getEnv().NEXT_PUBLIC_SITE_URL).toBe("https://example.com");
  });

  it("caches parsed result across calls (same object identity)", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@h/db");
    vi.stubEnv("NODE_ENV", "test");
    const getEnv = await freshGetEnv();
    const a = getEnv();
    const b = getEnv();
    expect(a).toBe(b);
  });
});

describe("getEnv — error paths", () => {
  it("throws when DATABASE_URL is missing", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("NODE_ENV", "test");
    const getEnv = await freshGetEnv();
    expect(() => getEnv()).toThrowError(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL is not postgres scheme", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://u:p@h/db");
    vi.stubEnv("NODE_ENV", "test");
    const getEnv = await freshGetEnv();
    expect(() => getEnv()).toThrowError(/postgresql:\/\/|postgres:\/\//);
  });

  it("throws when NODE_ENV is invalid", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@h/db");
    vi.stubEnv("NODE_ENV", "staging"); // not in enum
    const getEnv = await freshGetEnv();
    expect(() => getEnv()).toThrowError(/NODE_ENV/);
  });

  it("throws when LOG_LEVEL is invalid", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@h/db");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_LEVEL", "verbose"); // not in enum
    const getEnv = await freshGetEnv();
    expect(() => getEnv()).toThrowError(/LOG_LEVEL/);
  });

  it("error message lists all offending fields at once and includes hint", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("NODE_ENV", "staging");
    const getEnv = await freshGetEnv();
    try {
      getEnv();
      throw new Error("should not reach");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/DATABASE_URL/);
      expect(msg).toMatch(/NODE_ENV/);
      expect(msg).toMatch(/Hint: copy \.env\.example/);
    }
  });
});
