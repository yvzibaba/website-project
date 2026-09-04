import type { MetadataRoute } from "next";
import { SITE_URL, absoluteUrl, isIndexable } from "@/lib/site";

/**
 * /robots.txt（MetadataRoute，Phase 14 M1）。
 *
 * 两套策略，由 `isIndexable()` 裁决（环境门控，见 site.ts）：
 *   1. 不可索引（开发 / 预览 / 未配置正式域名）——对全站 `Disallow: /`，
 *      从爬虫层面兜底，配合各页 `robots:{index:false}` 的 noindex 双保险，
 *      杜绝把未完成/占位内容灌进搜索引擎（宪法第 20 条：诚实、不虚构「已有内容」）。
 *   2. 可索引（生产 + 正式域名）——放行公开内容，显式禁抓私有/动态前缀：
 *      后台、账号、订单、API、登录/注册、UI 演示、搜索结果页（查询串页收录无意义且易造重复内容）。
 *
 * 仍会输出 sitemap 指引与 host，方便正式部署后搜索引擎发现站点地图。
 *
 * force-dynamic（关键）：默认 robots.ts 会被**构建期**快照成静态文件。若构建与运行时
 *   NEXT_PUBLIC_SITE_URL 不一致，会出现「robots 仍是 Disallow:/，但 sitemap 已放开」的分裂状态。
 *   isIndexable() 是纯运行时判定，令本路由动态生成可与（同样 force-dynamic 的）sitemap.xml 保持一致。
 */

export const dynamic = "force-dynamic";

/** 即使站点可索引，也不该被收录的私有/动态路径前缀。 */
const DISALLOWED_PREFIXES = [
  "/admin",
  "/account",
  "/orders",
  "/api",
  "/login",
  "/register",
  "/search",
  "/ui",
];

export default function robots(): MetadataRoute.Robots {
  if (!isIndexable()) {
    return {
      rules: { userAgent: "*", disallow: ["/"] },
    };
  }

  return {
    rules: { userAgent: "*", allow: ["/"], disallow: DISALLOWED_PREFIXES },
    sitemap: absoluteUrl("/sitemap.xml"),
    host: SITE_URL,
  };
}
