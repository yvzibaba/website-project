import type { Metadata } from "next";

/**
 * 站点级 SEO 配置（单一真源，Phase 14 M1）。
 *
 * 为什么集中在此（宪法第 16 条防漂移）：
 *   `metadataBase`（根 layout）、canonical / OpenGraph 绝对 URL（各公开页）、
 *   robots.txt 与 sitemap.xml（MetadataRoute）都要用同一套「站点 URL / 名称 / 是否可被索引」。
 *   若每页各拼各的 `process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"`，
 *   域名/端口默认值一旦调整就会到处漏改。这里收口，页面只引用本模块。
 *
 * 关于「是否可被索引」（isIndexable）——V1 开发/预发环境绝不该被搜索引擎收录：
 *   - 部署（Phase 16）尚未完成，站点可能跑在 localhost 或临时预览域名上；
 *   - 宪法强调诚实、且避免把未完成/占位内容（隐私/条款草稿、DEMO 可见性开关）灌进索引。
 *   因此**默认不索引**，仅当同时满足「生产构建 + 显式配置了非本地域名」才放开。
 *   放开后根 layout 的 robots 由本函数裁决，个别页面（搜索、账号、后台）仍各自 noindex。
 *
 * 纯配置 + 纯函数，无 DB、无 Next 运行时依赖，可在 client/server 两侧安全导入（仅类型引用 next Metadata）。
 */

/** 站点对外根 URL（不带尾斜杠）。缺省回落到本地开发地址。 */
// 注意：`??` 只兜 undefined/null；`.env` 里写 `NEXT_PUBLIC_SITE_URL=`（空串）会得到 ""，
// 若直接用它会导致 canonical/og:url 变成相对残缺串。故把「空 / 纯空白」也归一为未配置 → 回落本地。
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000"
).replace(/\/+$/, "");

/** 站点名（OpenGraph siteName / 结构化数据 publisher 用）。 */
export const SITE_NAME = "产业案例与解决方案引擎";

/** 站点默认描述（首页/OG 兜底）。 */
export const SITE_DESCRIPTION =
  "AI 驱动的产业案例研究与解决方案生成引擎：发现全球产业案例、拆解商业模式与技术、匹配开源能力、中国本土化重构，形成可购买、可实施的产业解决方案。";

/**
 * 是否为「可被公开索引」的生产站点。
 * 规则：生产构建 + NEXT_PUBLIC_SITE_URL 已配置 + host 不是 localhost / 127.0.0.1 / 0.0.0.0 / [::1]。
 * URL 解析失败一律视为不可索引（保守，宁可不放）。
 */
export function isIndexable(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  let host: string;
  try {
    host = new URL(SITE_URL).hostname.toLowerCase();
  } catch {
    return false;
  }
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
  return host.length > 0 && !LOCAL_HOSTS.has(host);
}

/** 把站内相对路径拼成绝对 URL（供 canonical / og:url / sitemap）。已是绝对 URL 则原样返回。 */
export function absoluteUrl(path = "/"): string {
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${p === "/" ? "" : p}` || SITE_URL;
}

/**
 * 生成公开页的 SEO 元数据片段：canonical + OpenGraph + Twitter card。
 * 只产出「可展开进 Metadata 的偏量」，各页把它 spread 进自己的 metadata / generateMetadata 返回值。
 *
 * - canonical 用相对 path（Next 会基于根 layout 的 metadataBase 解析为绝对 URL）；
 * - og:url 用绝对 URL（社交抓取器不一定读 metadataBase）；
 * - 图片暂不提供（V1 无 OG 图，避免虚构资源；后续可加自托管默认卡）。
 */
export function seoMetadata(opts: {
  title?: string;
  description?: string;
  path: string;
  type?: "website" | "article";
}): Pick<Metadata, "alternates" | "openGraph" | "twitter"> {
  const { title, description, path, type = "website" } = opts;
  const url = absoluteUrl(path);
  return {
    alternates: { canonical: path },
    openGraph: {
      type,
      url,
      siteName: SITE_NAME,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      locale: "zh_CN",
    },
    twitter: {
      card: "summary",
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    },
  };
}
