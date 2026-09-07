/**
 * 登录回跳安全（决策1.5 P1）：修「游客点登录后可购买→登录后被踢回 /account 找不到原方案」的同时
 * **严禁开放重定向**（宪法·SECURITY 通用防护 / 白名单 > 黑名单）。
 *
 * 白名单口径：只允许**站内相对路径**且**命中购买闭环前缀**——`/solutions/*`、`/orders/*`、`/account*`。
 * 其他一律回落 `LOGIN_FALLBACK`。理由：
 *   - 只放行与「陌生买家能一路走到解锁」直接相关的三类路径，其他页面（管理后台、沙盘、外部）
 *     都无必要经由登录回跳抵达；
 *   - 不做通配 `/`，防未来出现 `/redirect?url=<evil>` 之类自跳板被误放行；
 *   - 显式拒协议相对 `//evil`、反斜杠 `/\evil`、含 scheme/userinfo 的绝对 URL、含空白/控制字符的
 *     可疑串——这些是开放重定向的经典绕过面（OWASP Unvalidated Redirects and Forwards）。
 *
 * 纯函数、无副作用、无外部依赖；单元测试覆盖每一条边界。
 */

/** 与购买闭环绑定的允许前缀（严格白名单）。 */
const ALLOWED_PREFIXES: readonly string[] = ["/solutions", "/orders", "/account"];

/** 未通过白名单校验时的统一回落：登录后回我的账号（与历史硬编码同址，行为不劣化）。 */
export const LOGIN_FALLBACK = "/account";

/**
 * 校验并归一 `callbackUrl`（可能来自 query 参数或 hidden form 字段，一律视为不可信）。
 *
 * 允许：`/solutions`、`/solutions/<id>`、`/solutions?...`；`/orders`、`/orders/<id>`；
 *      `/account`、`/account/orders`。
 * 拒绝（回落 LOGIN_FALLBACK）：非字符串 / 空 / 纯空白 / 非 `/` 开头 / `//host/path` /
 *      `/\host` / 含 `:` `@`（scheme、userinfo）/ 含空白与控制字符 / 非白名单前缀。
 */
export function sanitizeCallbackUrl(raw: unknown, fallback: string = LOGIN_FALLBACK): string {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim();
  if (!v) return fallback;
  if (v[0] !== "/") return fallback; // 相对路径必须 `/` 开头，杜绝 `http://evil`、`javascript:`、`data:` 等
  if (v[1] === "/" || v[1] === "\\") return fallback; // 协议相对 `//evil` 与 `/\evil`（部分浏览器把 `\` 当 `/`）
  if (/[:@]/.test(v)) return fallback; // scheme 冒号 / userinfo @ —— 常见开放重定向注入点
  if (/[\u0000-\u001f\u007f\s]/.test(v)) return fallback; // 控制字符 / 空白：不允许（query 已 URL 编码）
  for (const p of ALLOWED_PREFIXES) {
    if (v === p || v.startsWith(p + "/") || v.startsWith(p + "?")) return v;
  }
  return fallback;
}
