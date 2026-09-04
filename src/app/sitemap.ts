import type { MetadataRoute } from "next";
import { absoluteUrl, isIndexable } from "@/lib/site";
import { INDUSTRIES } from "@/server/industries";
import { getSitemapEntries } from "@/server/seo";

/**
 * /sitemap.xml（MetadataRoute，Phase 14 M1）。
 *
 * force-dynamic：sitemap 反映库里当前的公开案例/方案，必须每次实时生成，不能构建期快照。
 *
 * 环境门控（与 robots.ts 同源，见 site.ts isIndexable）：
 *   - 不可索引（开发/预览）→ 返回空数组，Next 生成一张仅含 <urlset> 空壳的 sitemap，
 *     等于对外不暴露任何 URL；避免把 localhost/临时域名或 DEMO 数据放进索引；
 *   - 可索引（生产+正式域名）→ 静态营销/结构页 + 行业页（枚举，无需查库）+ 动态案例/方案（getSitemapEntries）。
 *
 * DEMO 排除逻辑集中在 seo.ts 的查询里（宪法第 20 条）；这里只负责拼装与去重。
 */

export const dynamic = "force-dynamic";

/** 无需查库的固定可索引页面（首页/结构页/法务页）。行业页随后由枚举补齐。 */
const STATIC_PATHS = ["/", "/industries", "/cases", "/solutions", "/about", "/privacy", "/terms"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!isIndexable()) return [];

  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((path) => ({
    url: absoluteUrl(path),
    lastModified: now,
  }));

  const industryEntries: MetadataRoute.Sitemap = INDUSTRIES.map((industry) => ({
    url: absoluteUrl(`/industries/${industry.slug}`),
    lastModified: now,
  }));

  const dynamicEntries: MetadataRoute.Sitemap = (await getSitemapEntries()).map((entry) => ({
    url: absoluteUrl(entry.path),
    ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
  }));

  // 去重（按 url，防御性：万一静态与动态路径重叠）。Map 保序，后者覆盖前者的元数据。
  const byUrl = new Map<string, MetadataRoute.Sitemap[number]>();
  for (const item of [...staticEntries, ...industryEntries, ...dynamicEntries]) {
    byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}
