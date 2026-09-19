import { auth } from "@/auth";
import { logger } from "@app/kernel/lib/logger";
import type { UserRole } from "@app/kernel/lib/validation";
import { hasRole, type SessionUser } from "@app/kernel/lib/roles";

/**
 * 鉴权**壳层**（server-only）：把「有没有会话」「角色是否被允许」收敛成一处判别联合，
 * 供 Server Action、Route Handler、RSC layout 复用，避免每个受保护入口各写一套 auth() 判断而漂移。
 * 这也是案例 CRUD 数据层刻意不暴露无鉴权公共写端点的前置（宪法优先级：安全 > 功能数量）。
 *
 * ## R9.1 内核解耦后的职责切分（重要）
 *
 * 本文件原先把「纯原语」与「I/O」混住，代价是：内核的 `project-service` /
 * `solution-source` 为了拿到 `SessionUser` 与 `STAFF_ROLES` 被迫 import 本文件，
 * 而本文件第一行就从认证框架入口取 `auth` —— 于是 `next-auth` 被拖进内核传递闭包，
 * 「换底座不动内核」被一行 import 破坏（实测：闭包白名单外依赖 2 个）。
 *
 * 现在按**纯 / 不纯**劈成两半：
 *
 * | 符号 | 归属 | 位置 |
 * |---|---|---|
 * | `SessionUser`（身份视图契约） | 纯 | **内核** `@app/kernel/lib/roles` |
 * | `STAFF_ROLES` | 纯 | **内核** `@app/kernel/lib/roles` |
 * | `hasRole`（纯判定） | 纯 | **内核** `@app/kernel/lib/roles` |
 * | `getCurrentUser` / `requireUser` / `requireRole` | I/O（碰会话） | 本文件（壳层） |
 *
 * 上表三行以 **re-export** 形式向上保持向后兼容：既有 22 处 `STAFF_ROLES`、3 处 `SessionUser`、
 * 1 处 `hasRole` 的调用方**一行都不用改**；同时内核侧拿到的是一块零框架依赖的纯模块。
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

/* ── 纯原语：单一真源在内核，此处转出以保持既有调用方零改动 ── */
export { STAFF_ROLES, hasRole } from "@app/kernel/lib/roles";
export type { SessionUser } from "@app/kernel/lib/roles";

/* ── 以下为壳层 I/O：依赖会话，不进内核 ── */

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

/** 要求「已登录」（任意角色）。用于下单等只需身份的操作。 */
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
