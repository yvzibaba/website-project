import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { PUBLIC_CASE_STAGES } from "@/server/industries";
import { caseDemoVisibility, solutionDemoVisibility } from "@/server/demo";
// server-only：本模块直连数据库，仅由 /sitemap.xml MetadataRoute 与后续 SEO 端点在服务端调用。
// 本仓约定不 `import "server-only"`（vitest/纯 node 下会抛错，见 README 坑位），仅以注释标注。

/**
 * 站点地图数据层（Phase 14 M1）。
 *
 * 职责：只读枚举「应进 sitemap 的公开内容 URL + 最后修改时间」，供 `src/app/sitemap.ts` 消费。
 *   - 公开案例：stage ∈ PUBLIC_CASE_STAGES（DEEP_CASE+）、默认排除 DEMO_FIXTURE（宪法第 20 条：
 *     DEMO 不是真实研究产出，不该被搜索引擎当成站内真实内容收录）；
 *   - 已发布方案：status=PUBLISHED、其关联案例非 DEMO；
 *   - 行业页 / 首页 / 关于等静态路由由 `sitemap.ts` 直接补齐（无需查库）。
 *
 * 设计取舍（简单优先、少依赖）：
 *   - 不复用带 region/计数 include 的重查询函数（listPublicCases 等），这里只 select {id, updatedAt}，
 *     代价最小；用 AND 数组容纳 DEMO 的 OR 片段（避免两个 OR 片段做兄弟键互相覆盖，见 MEMORY 已记录的坑）；
 *   - 设单类型上限（默认 4000）兜底——单文件 sitemap 上限 50000，V1 数据远未到，上限只为防失控；
 *   - 诚实降级：任一侧查询失败 → 记 warn 并跳过该侧，绝不抛错令整张 sitemap 生成失败（build/start 更稳）。
 */

const log = logger.child({ module: "server/seo" });

/** 单类内容进 sitemap 的最大条数（兜底，防极端数据量下 URL 爆炸）。 */
export const SITEMAP_PER_TYPE = 4000;

export interface SitemapEntry {
  /** 站内相对路径，如 `/cases/ckxxxx`。绝对化交给 sitemap.ts 用 metadataBase/absoluteUrl。 */
  path: string;
  /** 最后修改时间（供 sitemap lastModified；库缺省则不带）。 */
  lastModified?: Date;
}

/**
 * 拉取公开案例 + 已发布方案的 sitemap 条目（不含静态路由）。
 * 返回相对 path 数组；出错侧降级为空、不影响另一侧。
 */
export async function getSitemapEntries(): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = [];

  try {
    const cases = await prisma.case.findMany({
      where: {
        AND: [{ stage: { in: [...PUBLIC_CASE_STAGES] } }, caseDemoVisibility(false)],
      },
      select: { id: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: SITEMAP_PER_TYPE,
    });
    for (const c of cases) entries.push({ path: `/cases/${c.id}`, lastModified: c.updatedAt });
  } catch (err) {
    log.warn("sitemap: 案例枚举失败，跳过该侧（不使整张 sitemap 失败）", { err });
  }

  try {
    const solutions = await prisma.solution.findMany({
      where: {
        AND: [{ status: "PUBLISHED" }, solutionDemoVisibility(false)],
      },
      select: { id: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: SITEMAP_PER_TYPE,
    });
    for (const s of solutions) entries.push({ path: `/solutions/${s.id}`, lastModified: s.updatedAt });
  } catch (err) {
    log.warn("sitemap: 方案枚举失败，跳过该侧（不使整张 sitemap 失败）", { err });
  }

  return entries;
}
