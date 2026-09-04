import type { Prisma } from "@prisma/client";

/**
 * DEMO 数据标记与可见性（server-only）。
 *
 * 背景（宪法第 20 条：禁止虚构"已有内容"）：
 *   真实案例/方案由 Phase 9–10 的每日流水线产出。开发期为了验证列表/详情/分页的
 *   渲染路径，`prisma/seed.ts` 会插入**明确标注为 DEMO 的示例案例**（仅案例，不种子方案）。
 *   为杜绝 DEMO 数据被当成真实研究成果对外展示，约定：
 *     1. DEMO 案例的 `sourceType` 一律为 `DEMO_FIXTURE`，标题以 `【DEMO】` 前缀；
 *     2. 所有公开查询**默认排除** DEMO（`includeDemo=false`）——默认站点只展示真实数据（当前为空态）；
 *     3. 仅当显式带 `?demo=1` 时才纳入 DEMO，且页面必须打「DEMO 数据」角标 + 顶部横幅；
 *     4. seed 脚本在 `NODE_ENV=production` 拒绝运行，生产库永远不会出现 DEMO 行。
 *
 * 这样既能让开发者"看得见"页面渲染效果，又保证对外/生产的诚实性。
 */

/** DEMO 案例的 sourceType 标记值。 */
export const DEMO_SOURCE_TYPE = "DEMO_FIXTURE";

/** DEMO 案例标题前缀（人眼可辨，双保险）。 */
export const DEMO_TITLE_PREFIX = "【DEMO】";

/** 判断一个带 sourceType 的实体是否为 DEMO 数据。 */
export function isDemoEntity(entity: { sourceType?: string | null }): boolean {
  return entity.sourceType === DEMO_SOURCE_TYPE;
}

/**
 * 案例查询的 DEMO 可见性过滤片段（Prisma CaseWhereInput）。
 *
 * - includeDemo=true  → 不加过滤（DEMO 与真实数据都返回）；
 * - includeDemo=false → 排除 DEMO_FIXTURE，但**保留 sourceType 为 null 的真实案例**
 *   （Prisma `{ not }` 在 SQL 里会把 NULL 一并过滤掉，故显式 OR null 兜底）。
 *
 * 作为独立 where 键与其它条件（stage/industry）AND 合并使用。
 */
export function caseDemoVisibility(includeDemo: boolean): Prisma.CaseWhereInput {
  if (includeDemo) return {};
  return {
    OR: [{ sourceType: null }, { sourceType: { not: DEMO_SOURCE_TYPE } }],
  };
}

/**
 * 方案查询的 DEMO 可见性过滤片段（Prisma SolutionWhereInput）。
 * 方案本身无 sourceType，其"是否 DEMO"取决于关联案例，故按 `case.sourceType` 过滤。
 */
export function solutionDemoVisibility(includeDemo: boolean): Prisma.SolutionWhereInput {
  if (includeDemo) return {};
  return {
    case: {
      OR: [{ sourceType: null }, { sourceType: { not: DEMO_SOURCE_TYPE } }],
    },
  };
}
