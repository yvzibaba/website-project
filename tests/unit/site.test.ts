import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 单元测试：站点级 SEO 配置（src/lib/site.ts，Phase 14 M1）。
 *
 * site.ts 里的 SITE_URL 是**模块加载时**读取 NEXT_PUBLIC_SITE_URL 求值的常量，
 * isIndexable() 里的 NODE_ENV 是**调用时**读取。要覆盖不同域名/环境组合，
 * 必须在 stub 环境后 `vi.resetModules()` 再动态 import 一份全新模块，否则 SITE_URL 会被固化。
 * 因此本测试统一走「stubEnv → resetModules → 动态 import」的加载器 loadSite(env)。
 */

interface SiteModule {
  SITE_URL: string;
  SITE_NAME: string;
  isIndexable: () => boolean;
  absoluteUrl: (path?: string) => string;
  seoMetadata: (opts: {
    title?: string;
    description?: string;
    path: string;
    type?: "website" | "article";
  }) => {
    alternates: { canonical: string };
    openGraph: Record<string, unknown>;
    twitter: Record<string, unknown>;
  };
}

async function loadSite(env: { NODE_ENV?: string; NEXT_PUBLIC_SITE_URL?: string }): Promise<SiteModule> {
  vi.resetModules();
  if (env.NODE_ENV !== undefined) vi.stubEnv("NODE_ENV", env.NODE_ENV);
  else vi.stubEnv("NODE_ENV", "test");
  if (env.NEXT_PUBLIC_SITE_URL !== undefined) vi.stubEnv("NEXT_PUBLIC_SITE_URL", env.NEXT_PUBLIC_SITE_URL);
  else vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  return (await import("@/lib/site")) as unknown as SiteModule;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SITE_URL 归一化", () => {
  it("去掉尾部斜杠", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com///" });
    expect(site.SITE_URL).toBe("https://yvzibaba.com");
  });

  it("缺省回落到本地开发地址", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "" });
    expect(site.SITE_URL).toBe("http://localhost:3000");
  });
});

describe("isIndexable 环境门控", () => {
  it("非生产构建 → 不可索引（无论域名）", async () => {
    const site = await loadSite({ NODE_ENV: "development", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    expect(site.isIndexable()).toBe(false);
  });

  it("生产 + 正式域名 → 可索引", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    expect(site.isIndexable()).toBe(true);
  });

  it("生产 + 带 www / 子域名 → 可索引", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://app.yvzibaba.com" });
    expect(site.isIndexable()).toBe(true);
  });

  it("生产但缺省本地域名 → 不可索引", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "" });
    expect(site.isIndexable()).toBe(false);
  });

  it.each([
    ["http://localhost:3000", "localhost"],
    ["http://127.0.0.1:3000", "127.0.0.1"],
    ["http://0.0.0.0:3000", "0.0.0.0"],
  ])("生产 + 本地主机 %s → 不可索引", async (url) => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: url });
    expect(site.isIndexable()).toBe(false);
  });

  it("生产 + 非法 URL → 保守判为不可索引", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "not-a-url" });
    expect(site.isIndexable()).toBe(false);
  });
});

describe("absoluteUrl", () => {
  it("根路径不产生双斜杠", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    expect(site.absoluteUrl("/")).toBe("https://yvzibaba.com");
  });

  it("子路径正确拼接", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    expect(site.absoluteUrl("/cases/abc")).toBe("https://yvzibaba.com/cases/abc");
  });

  it("无前导斜杠也能补全", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    expect(site.absoluteUrl("solutions/x")).toBe("https://yvzibaba.com/solutions/x");
  });

  it("已是绝对 URL 原样返回", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    expect(site.absoluteUrl("https://cdn.example.com/img.png")).toBe("https://cdn.example.com/img.png");
  });
});

describe("seoMetadata", () => {
  it("返回 canonical + openGraph + twitter，含绝对 og:url", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    const m = site.seoMetadata({ title: "T", description: "D", path: "/about", type: "article" });
    expect(m.alternates.canonical).toBe("/about");
    expect(m.openGraph.url).toBe("https://yvzibaba.com/about");
    expect(m.openGraph.type).toBe("article");
    expect(m.openGraph.siteName).toBe(site.SITE_NAME);
    expect(m.openGraph.title).toBe("T");
    expect(m.openGraph.description).toBe("D");
    expect(m.openGraph.locale).toBe("zh_CN");
    expect(m.twitter.card).toBe("summary");
    expect(m.twitter.title).toBe("T");
  });

  it("type 缺省为 website", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    const m = site.seoMetadata({ path: "/cases" });
    expect(m.openGraph.type).toBe("website");
  });

  it("缺 title/description 时不写入空字段（避免以站点默认覆盖页面自身标题）", async () => {
    const site = await loadSite({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://yvzibaba.com" });
    const m = site.seoMetadata({ path: "/cases" });
    expect("title" in m.openGraph).toBe(false);
    expect("description" in m.openGraph).toBe(false);
    expect("title" in m.twitter).toBe(false);
  });
});
