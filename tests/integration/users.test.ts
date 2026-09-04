import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  registerUser,
  getAuthUserByEmail,
  getProfileUserById,
} from "@/server/users";
import { verifyPassword } from "@/lib/password";

/**
 * 集成测试：用户数据层（真连 Neon，不 mock）。
 *
 * 用一次性 runId 邮箱验证：注册建号（口令存哈希非明文、role 默认 USER）、
 * 唯一邮箱冲突归一为 email_taken、非法入参返回 fieldErrors、
 * getAuthUserByEmail 返回 passwordHash 且 verifyPassword 可校验、
 * getProfileUserById 排除 passwordHash。afterAll 全量清理，不污染真库。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn("[users] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `user-${runId}@example.com`;
const password = "integration-pw-123";

/** 预热：Neon 冷启动首连可能超时。 */
async function warmup() {
  for (let i = 0; i < 4; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

describeDb("users data layer (Neon)", () => {
  beforeAll(async () => {
    await warmup();
  }, 60_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: runId } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("registerUser 建号：口令存 scrypt 哈希非明文，role 默认 USER，邮箱归一小写", async () => {
    const res = await registerUser({ email: `User-${runId}@Example.COM`, password, name: "集成测试用户" });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    expect(res.email).toBe(email); // 已小写归一

    const row = await prisma.user.findUnique({ where: { id: res.userId } });
    expect(row).not.toBeNull();
    expect(row!.role).toBe("USER");
    expect(row!.passwordHash).not.toBe(password); // 绝不存明文
    expect(row!.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(password, row!.passwordHash)).toBe(true);
  }, 60_000);

  it("registerUser 对已存在邮箱返回 email_taken", async () => {
    const res = await registerUser({ email, password });
    expect(res.status).toBe("email_taken");
  }, 60_000);

  it("registerUser 对非法入参返回 invalid + fieldErrors（不建号）", async () => {
    const res = await registerUser({ email: "not-an-email", password: "short" });
    expect(res.status).toBe("invalid");
    if (res.status !== "invalid") return;
    expect(res.fieldErrors.email).toBeDefined();
    expect(res.fieldErrors.password).toBeDefined();
  }, 60_000);

  it("getAuthUserByEmail 返回 passwordHash，verifyPassword 可校验；不存在邮箱返回 null", async () => {
    const user = await getAuthUserByEmail(email);
    expect(user).not.toBeNull();
    expect(user!.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(password, user!.passwordHash)).toBe(true);
    expect(await verifyPassword("wrong-password", user!.passwordHash)).toBe(false);

    expect(await getAuthUserByEmail(`nope-${runId}@example.com`)).toBeNull();
  }, 60_000);

  it("getProfileUserById 排除 passwordHash，返回展示字段", async () => {
    const authUser = await getAuthUserByEmail(email);
    if (!authUser) throw new Error("expected user to exist");
    const profile = await getProfileUserById(authUser.id);
    expect(profile).not.toBeNull();
    expect(profile!.email).toBe(email);
    expect(profile!.role).toBe("USER");
    expect(profile!.createdAt).toBeInstanceOf(Date);
    expect("passwordHash" in profile!).toBe(false); // 关键：不泄露哈希

    expect(await getProfileUserById("nonexistent_cuid_0000000000")).toBeNull();
  }, 60_000);
});
