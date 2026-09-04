import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import { RegisterInputSchema } from "@/lib/validation";

/**
 * 用户数据层（server-only，Phase 6 M1）。
 *
 * 职责：注册（建号）与按 email/id 取用户，供注册 Server Action 与 Auth.js authorize() 使用。
 * 认证方式：Auth.js v5 Credentials（邮箱 + 密码）+ JWT 会话，User 表由此模块直接管理，
 * 不引入 Prisma Adapter 的 Account/Session 表（依赖更少，宪法第 2/4 条）。
 *
 * 安全（SECURITY §1 / 宪法第 11 条）：
 *   - 口令只存 scrypt 哈希串，绝不存明文、绝不记日志；
 *   - 邮箱统一小写存储（EmailSchema 已归一化），避免同邮箱多账号；
 *   - 注册对"邮箱已存在"返回 email_taken，登录失败一律同一提示（防用户枚举，见 auth.ts）。
 *
 * 错误策略：判别联合，让调用方分别处理，不抛裸异常给页面。
 */

const log = logger.child({ module: "server/users" });

export type RegisterResult =
  | { status: "created"; userId: string; email: string }
  | { status: "invalid"; fieldErrors: Record<string, string[]> }
  | { status: "email_taken" }
  | { status: "weak_password" }
  | { status: "error"; error: string };

/**
 * 注册新用户：校验入参 → 查重邮箱 → scrypt 哈希口令 → 建号（role 默认 USER）。
 *
 * 并发下同一邮箱可能同时通过查重再触发唯一约束冲突（P2002），此处捕获并归一为 email_taken。
 */
export async function registerUser(input: unknown): Promise<RegisterResult> {
  const parsed = RegisterInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { status: "invalid", fieldErrors };
  }

  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) return { status: "email_taken" };

  const hashed = await hashPassword(password);
  if (!hashed.ok) {
    // RegisterInputSchema 已限长 128，理论上到不了这里；兜底防 DoS 上限（password.ts 1024 字节）。
    return { status: "weak_password" };
  }

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash: hashed.hash, name: name ?? null, role: "USER" },
      select: { id: true, email: true },
    });
    log.info("user registered", { userId: user.id });
    return { status: "created", userId: user.id, email: user.email };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { status: "email_taken" };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("register failed", { error: message });
    return { status: "error", error: message };
  }
}

/** 认证用最小用户视图（含 passwordHash，仅 server 内部使用，切勿外泄到客户端）。 */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: "USER" | "REVIEWER" | "ADMIN";
  passwordHash: string;
}

/** 按邮箱取认证用户（authorize() 用）。DB 异常时抛出，由 Auth.js 统一处理为登录失败。 */
export async function getAuthUserByEmail(email: string): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, passwordHash: true },
  });
}

/** 账号页展示用（不含 passwordHash）。 */
export interface ProfileUser {
  id: string;
  email: string;
  name: string | null;
  role: "USER" | "REVIEWER" | "ADMIN";
  emailVerified: Date | null;
  createdAt: Date;
}

export async function getProfileUserById(id: string): Promise<ProfileUser | null> {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      emailVerified: true,
      createdAt: true,
    },
  });
}
