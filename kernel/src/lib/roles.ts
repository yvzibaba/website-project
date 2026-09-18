import type { UserRole } from "@app/kernel/lib/validation";

/**
 * 身份视图契约 + 角色原语（**纯模块**：零 I/O、零框架、零副作用、零环境依赖）。
 *
 * 为什么单独成文件（R9.1 内核解耦）：
 *   内核的 `sandbox-projects` / `sandbox-solution-source` 需要做**资源级授权判定**——「这个项目
 *   归谁、谁能看」。但判定只需要两样东西：**调用者是谁**（`SessionUser`）与**哪些角色算员工**
 *   （`STAFF_ROLES`）。原先这两个符号住在壳层的 `server/authz.ts`，而该文件第一行就从认证
 *   框架的入口模块取 `auth`，会把整个 `next-auth` 拖进内核的传递闭包，
 *   于是「换底座不动内核」这条命脉被一行 import 破坏。
 *   （本文件刻意不写出那行 import 的字面量，以免污染下游按行扫描的依赖守卫。）
 *
 * 这个文件是**依赖倒置**的落地：
 *   内核**自己声明**它需要一个「身份视图」长什么样（`SessionUser`），
 *   宿主底座负责把自己的会话（Auth.js / Clerk / 自研 / 测试桩）**适配**成这个形状；
 *   而不是内核去 import 宿主的鉴权实现。
 *   → 换鉴权方案时，改的是宿主的一个适配器，内核**零改动**。
 *
 * 铁律：
 *   - 本文件**只允许**出现类型定义与纯函数。任何 `auth()` / DB / 网络 / 时钟读取都是违规。
 *   - `role` **只从服务端会话**取（宿主负责），内核**绝不相信客户端传入的 role**。
 */

/** 角色原语模块版本（改判定口径 / 契约形状须升版记因，宪法第 13 条）。 */
export const ROLES_MODULE_VERSION = "1.0.0";

/** 会话内的最小可信身份视图（由宿主从服务端会话适配而来，**绝不含 passwordHash / 令牌**）。 */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}

/**
 * 员工角色（可进入后台）：审核员 + 管理员。普通用户 USER 被排除。
 * REVIEWER 供方案人工审核队列使用；ADMIN 拥有全部后台能力。
 */
export const STAFF_ROLES: readonly UserRole[] = ["REVIEWER", "ADMIN"];

/**
 * 纯函数：给定角色是否落在允许集合内。无副作用、不碰会话——是权限单元测试的主战场。
 * 把它与 `auth()` I/O 严格分离，便于固定用例、禁止用模型口算判定。
 */
export function hasRole(role: UserRole | undefined, allowed: readonly UserRole[]): boolean {
  return role !== undefined && allowed.includes(role);
}
