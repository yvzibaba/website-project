import { describe, it, expect } from "vitest";
import { sanitizeCallbackUrl, LOGIN_FALLBACK } from "@/lib/redirect-safety";

/**
 * 单元测试：登录回跳白名单（决策1.5 P1，防开放重定向）。
 * 关键面：只放行 `/solutions/*`、`/orders/*`、`/account*` 三类站内路径；
 * 其他一律回落 LOGIN_FALLBACK。开放重定向的经典绕过必须逐条被拒。
 */

describe("sanitizeCallbackUrl", () => {
  it("白名单内路径原样返回（购买闭环三类）", () => {
    expect(sanitizeCallbackUrl("/solutions")).toBe("/solutions");
    expect(sanitizeCallbackUrl("/solutions/csm_abc123")).toBe("/solutions/csm_abc123");
    expect(sanitizeCallbackUrl("/solutions/csm_abc?demo=1")).toBe("/solutions/csm_abc?demo=1");
    expect(sanitizeCallbackUrl("/orders/cso_xxx")).toBe("/orders/cso_xxx");
    expect(sanitizeCallbackUrl("/account")).toBe("/account");
    expect(sanitizeCallbackUrl("/account/orders")).toBe("/account/orders");
  });

  it("绝对 URL / 协议相对 URL / 反斜杠 host 一律回落（防跨站跳板）", () => {
    expect(sanitizeCallbackUrl("https://evil.example.com/p")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("http://evil.example.com")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("//evil.example.com/x")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/\\evil.example.com")).toBe(LOGIN_FALLBACK);
  });

  it("含 scheme / userinfo 冒号 @ 一律回落", () => {
    expect(sanitizeCallbackUrl("javascript:alert(1)")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/solutions@evil.com")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/orders:http://evil")).toBe(LOGIN_FALLBACK);
  });

  it("非白名单站内路径也回落（/admin、/login、/api 等不走回跳通道）", () => {
    expect(sanitizeCallbackUrl("/admin/orders")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/login")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/api/health")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/sandbox")).toBe(LOGIN_FALLBACK);
  });

  it("空串 / 纯空白 / 非字符串 / null / undefined 一律回落", () => {
    expect(sanitizeCallbackUrl("")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("   ")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl(null)).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl(undefined)).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl(123)).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl({ url: "/solutions/x" })).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl(["/solutions/x"])).toBe(LOGIN_FALLBACK);
  });

  it("含控制字符 / 空格 一律回落（query 应已 URL 编码，出现即视为可疑）", () => {
    expect(sanitizeCallbackUrl("/solutions/abc\u0000def")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/solutions/a b")).toBe(LOGIN_FALLBACK);
    expect(sanitizeCallbackUrl("/solutions/a\nb")).toBe(LOGIN_FALLBACK);
  });

  it("前后空白允许被 trim 后命中白名单（宽松接受，安全仍严）", () => {
    expect(sanitizeCallbackUrl("  /solutions/csm_abc  ")).toBe("/solutions/csm_abc");
  });

  it("自定义 fallback 生效（保留 API 弹性，不硬编码单一回落点）", () => {
    expect(sanitizeCallbackUrl("/admin/x", "/login")).toBe("/login");
    expect(sanitizeCallbackUrl("https://evil", "/solutions")).toBe("/solutions");
  });

  it("LOGIN_FALLBACK 常量稳定（页面与 action 同址口径，防漂移）", () => {
    expect(LOGIN_FALLBACK).toBe("/account");
  });
});
