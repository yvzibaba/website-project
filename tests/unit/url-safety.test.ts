import { describe, it, expect } from "vitest";
import { isUsableHttpUrl, externalHost } from "@/lib/url-safety";

/**
 * 「外部来源链接安全闸门」的直连单测（V2 决策面板 / V1 沙盘两档共用同一个规则，故规则本身钉在这）。
 * 与 benchmark-source-model.test.ts 的关系：那边通过 toSourceRows 观察效果，这里直接钉每一条边界。
 * 覆盖：合法 http/https、首尾空白、内部空白、控制字符、脏协议、协议相对、相对路径、非字符串。
 */

describe("isUsableHttpUrl · 只放行 http/https 的可点外链", () => {
  it("合法 http/https 通过；首尾空白会被吃掉后仍通过", () => {
    expect(isUsableHttpUrl("https://gov.cn/doc")).toBe(true);
    expect(isUsableHttpUrl("http://a.com/x")).toBe(true);
    expect(isUsableHttpUrl("HTTPS://UPPER.CASE/works")).toBe(true);
    expect(isUsableHttpUrl("  https://trim.me/p  ")).toBe(true);
    expect(isUsableHttpUrl("https://example.com/path?q=1#frag")).toBe(true);
  });

  it("非 http(s) 协议一律拒：javascript / data / vbscript / ftp / 协议相对 / 相对路径", () => {
    expect(isUsableHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isUsableHttpUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isUsableHttpUrl("data:text/html,<b>x</b>")).toBe(false);
    expect(isUsableHttpUrl("vbscript:msgbox")).toBe(false);
    expect(isUsableHttpUrl("ftp://files/x")).toBe(false);
    expect(isUsableHttpUrl("//protocol-relative.example/x")).toBe(false);
    expect(isUsableHttpUrl("/relative/path")).toBe(false);
    expect(isUsableHttpUrl("mailto:a@b.c")).toBe(false);
  });

  it("含内部空白或控制字符 → 拒（疑似截断/注入）", () => {
    expect(isUsableHttpUrl("https://a.com/有 空格")).toBe(false);
    expect(isUsableHttpUrl("https://a.com/x\ty")).toBe(false);
    expect(isUsableHttpUrl("https://a.com/x\u0000y")).toBe(false);
    expect(isUsableHttpUrl("https://a.com/x\u001fy")).toBe(false);
  });

  it("空串 / 纯空白 / null / undefined / 非字符串 → 拒", () => {
    expect(isUsableHttpUrl("")).toBe(false);
    expect(isUsableHttpUrl("   ")).toBe(false);
    expect(isUsableHttpUrl("\n")).toBe(false);
    expect(isUsableHttpUrl(null)).toBe(false);
    expect(isUsableHttpUrl(undefined)).toBe(false);
    expect(isUsableHttpUrl(123 as unknown as string)).toBe(false);
    expect(isUsableHttpUrl({} as unknown as string)).toBe(false);
  });
});

describe("externalHost · 取 host 供 anchor 显示提示（非合法 URL → null）", () => {
  it("合法 http(s) → 返回 host", () => {
    expect(externalHost("https://gov.cn/doc")).toBe("gov.cn");
    expect(externalHost("http://a.com:8080/x")).toBe("a.com:8080");
    expect(externalHost("  https://trim.example/p  ")).toBe("trim.example");
  });
  it("脏链接 → null（不给 host 提示，也不给可点链接）", () => {
    expect(externalHost("javascript:alert(1)")).toBeNull();
    expect(externalHost("//relative.example/x")).toBeNull();
    expect(externalHost("https://a.com/有 空格")).toBeNull();
    expect(externalHost(null)).toBeNull();
    expect(externalHost(undefined)).toBeNull();
  });
});
