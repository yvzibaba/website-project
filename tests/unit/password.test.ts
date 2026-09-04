import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  SCRYPT_PARAMS,
  KEYLEN,
  MAX_PASSWORD_BYTES,
} from "@/lib/password";

/**
 * 单元测试：口令哈希（scrypt / node:crypto，零额外依赖）。
 *
 * 覆盖：正确口令往返校验、错误口令拒绝、每次盐唯一（同口令不同哈希）、
 * 自描述格式（scrypt$N$r$p$salt$hash）、畸形/非法存储串一律 false（不抛异常，
 * 防用户枚举/崩溃）、超长口令 DoS 兜底。
 */

describe("password — hashPassword", () => {
  it("返回自描述格式 scrypt$N$r$p$salt$hash", async () => {
    const res = await hashPassword("correct horse battery");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parts = res.hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBe(SCRYPT_PARAMS.N);
    expect(Number(parts[2])).toBe(SCRYPT_PARAMS.r);
    expect(Number(parts[3])).toBe(SCRYPT_PARAMS.p);
    // 64 字节 base64 编码为 88 字符（含末尾 '='）
    expect(Buffer.from(parts[5], "base64")).toHaveLength(KEYLEN);
  });

  it("同一口令两次哈希因随机盐而不同", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.hash).not.toBe(b.hash);
    // 盐段不同
    expect(a.hash.split("$")[4]).not.toBe(b.hash.split("$")[4]);
  });

  it("超过 DoS 上限的口令返回 {ok:false,reason:'too_long'}（不抛异常）", async () => {
    const tooLong = "a".repeat(MAX_PASSWORD_BYTES + 1);
    const res = await hashPassword(tooLong);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("too_long");
  });
});

describe("password — verifyPassword", () => {
  it("正确口令校验通过", async () => {
    const res = await hashPassword("hunter2-hunter2");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await verifyPassword("hunter2-hunter2", res.hash)).toBe(true);
  });

  it("错误口令校验失败", async () => {
    const res = await hashPassword("hunter2-hunter2");
    if (!res.ok) throw new Error("hash failed");
    expect(await verifyPassword("hunter2-HUNTER2", res.hash)).toBe(false);
    expect(await verifyPassword("", res.hash)).toBe(false);
  });

  it("同口令对不同盐的哈希都能校验通过", async () => {
    const a = await hashPassword("repeatable-pw");
    const b = await hashPassword("repeatable-pw");
    if (!a.ok || !b.ok) throw new Error("hash failed");
    expect(await verifyPassword("repeatable-pw", a.hash)).toBe(true);
    expect(await verifyPassword("repeatable-pw", b.hash)).toBe(true);
  });

  it("畸形/非法存储串一律返回 false（不抛异常）", async () => {
    expect(await verifyPassword("whatever", "")).toBe(false);
    expect(await verifyPassword("whatever", "not-a-hash")).toBe(false);
    expect(await verifyPassword("whatever", "bcrypt$10$aa$bb")).toBe(false); // 算法不符
    expect(await verifyPassword("whatever", "scrypt$x$y$z$a$b")).toBe(false); // 参数非整数
    expect(await verifyPassword("whatever", "scrypt$0$8$1$c2FsdA==$aGFzaA==")).toBe(
      false,
    ); // N<=0
    expect(await verifyPassword("whatever", "scrypt$16384$8$1")).toBe(false); // 段数不足
  });

  it("超长口令校验返回 false（DoS 兜底）", async () => {
    const res = await hashPassword("normal-password");
    if (!res.ok) throw new Error("hash failed");
    expect(await verifyPassword("a".repeat(MAX_PASSWORD_BYTES + 1), res.hash)).toBe(
      false,
    );
  });
});
