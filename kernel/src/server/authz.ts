import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import type { UserRole } from "@/lib/validation";

/**
 * 鉴权原语（server-only，Phase 6 M2，总控 §13「后台必须有权限控制」/ SECURITY §4 最小角色）。
 *
 * 为什么：Phase 6 M1 只解决了「是谁」（认证：Credentials + JWT 会话，session 携带 id/role）。
 *   M2 解决「能干什么」（授权）——把「有没有会话」「角色是否被允许」收敛成一处判别联合，
 *   供 Server Action、Route Handler、RSC layout 复用，避免每个受保护入口各写一套 auth() 判断而漂移。
 *   这也是 Phase 7 M5 案例 CRUD「数据层」当时刻意不暴露 HTTP 写端点的前置：没有可信门禁，
 *   就绝不先上线无鉴权的公共写路由（宪法优先级：数据质量/安全 > 功能数量/开发效率）。
 *
 * 铁律（宪法第 20 条 诚实）：
 *   - 绝不信任客户端传入的 role——角色**只从服务端会话**（auth()）读取；
 *   - 授权失败返回判别联合（unauthenticated / forbidden），由调用方分别处理，绝不抛裸异常给页面；
 *   - 日志只记 id/角色等**非敏感**字段用于审计，绝不打印会话令牌或口令（SECURITY §1）。
 *
 * 用法（Server Action / RSC）：
 *   const res = await requireRole(STAFF_ROLES);
 *   if (!res.ok) return { error: res.reason };   // 或 redirect("/login") / 渲染 403 面板
 *   const admin = res.user;
 */

const log = logger.child({ module: "server/authz" });

/** 会话内的最小可信身份视图（来自 JWT 会话，绝不含 passwordHash）。 */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}

/**
 * 员工角色（可进入后台）：审核员 + 管理员。普通用户 USER 被排除。
 * REVIEWER 供 Phase 8/13 方案人工审核队列使用；ADMIN 拥有全部后台能力。
 */
export const STAFF_ROLES: readonly UserRole[] = ["REVIEWER", "ADMIN"];

/**
 * 纯函数：给定角色是否落在允许集合内。无副作用、不碰会话——是权限单元测试的主战场
 * （总控 §28 把「权限测试」列为重点）。把它与 auth() I/O 分离，便于固定用例、禁止用模型口算判定。
 */
export function hasRole(role: UserRole | undefined, allowed: readonly UserRole[]): boolean {
  return role !== undefined && allowed.includes(role);
}

/** 读取当前会话用户；无有效会话返回 null（不抛）。 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth();
  const u = session?.user;
  // 会话存在但缺 id（理论上不该发生：jwt/session 回调已透传）视为未登录，保守拒绝。
  if (!u?.id) return null;
  return { id: u.id, email: u.email, name: u.name ?? null, role: u.role };
}

export type RequireUserResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "unauthenticated" };

/** 要求「已登录」（任意角色）。用于下单等只需身份的操作（Phase 12）。 */
export async function requireUser(): Promise<RequireUserResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "unauthenticated" };
  return { ok: true, user };
}

export type RequireRoleResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "forbidden"; required: readonly UserRole[] };

/**
 * 要求「已登录且角色在允许集合内」。用于后台/审核等受限入口。
 * 已登录但角色不符 → forbidden（记审计 warn，便于发现越权尝试）；未登录 → unauthenticated。
 */
export async function requireRole(allowed: readonly UserRole[]): Promise<RequireRoleResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "unauthenticated" };
  if (!hasRole(user.role, allowed)) {
    log.warn("authorization denied", {
      userId: user.id,
      role: user.role,
      required: [...allowed],
    });
    return { ok: false, reason: "forbidden", required: allowed };
  }
  return { ok: true, user };
}
