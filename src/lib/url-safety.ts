/**
 * 外部链接安全闸门：一条 URL 到底**能不能被画成可点的 `<a>`**。
 *
 * 与 `src/lib/redirect-safety.ts` 是**互补**关系，别混用：
 *   - `redirect-safety` 管**站内回跳**——只允许白名单相对路径，明确拒一切绝对 URL；
 *   - 本模块管**外部来源链接**——只允许 http/https，其他协议一律不给点。
 *
 * 为什么要单独钉：内核 `parameter-engine` 与 `benchmark` 常量层已把"合法 http(s)"作为 FACT 的
 * 承认条件（`SOURCE_URL` 若脏就降级 ASSUMPTION）。但展示层不能盲信——历史脏数据、外部集成
 * 回填、以及未来可能的 DB 手改都可能塞进来 `javascript:`、`data:`、协议相对或含空白的可疑串。
 * **宁可不给链接，也不给一个可疑链接**——用户看不到"查看原文"只是少个便利，点错就是安全事故。
 *
 * 纯函数、无副作用、无外部依赖；单测覆盖每一条边界。
 */

/**
 * 是否为"看起来可以安全点开"的外部链接。
 * 判定：字符串 → trim → 不含内部空白 → 以 http/https 打头。三者缺一即拒。
 *
 * 明确拒的：`null` / `undefined` / 非字符串 / 空串 / 纯空白 / 含内部空白（疑似被截断）/
 * `javascript:` / `data:` / `vbscript:` / `ftp:` / 协议相对 `//host/path` / 相对路径 `/x` /
 * 含控制字符（`\u0000-\u001f\u007f`）。
 * 允许：http:// 与 https:// 开头，可含首尾空白（trim 后再校验）。
 */
export function isUsableHttpUrl(u: string | null | undefined): boolean {
  if (typeof u !== "string") return false;
  const t = u.trim();
  if (!t) return false;
  // 控制字符任何位置都不安全；内部空白 = 疑似被截断/拼接污染的串
  if (/[\u0000-\u001f\u007f]/.test(t)) return false;
  if (/\s/.test(t)) return false;
  return /^https?:\/\//i.test(t);
}

/**
 * 从任意外部 URL 里安全地抽 host，用于给 anchor 加"要去哪"的提示（避免点开前什么都不知道）。
 * 非合法 http(s) → null。
 */
export function externalHost(u: string | null | undefined): string | null {
  if (!isUsableHttpUrl(u)) return null;
  try {
    return new URL((u as string).trim()).host;
  } catch {
    return null;
  }
}
