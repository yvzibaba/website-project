import { logger } from "@/lib/logger";
import {
  listPublicCases,
  type CaseListResult,
  type CaseSortField,
} from "@/server/cases";
import {
  listPublishedSolutions,
  type SolutionListResult,
  type SolutionSortField,
} from "@/server/solutions";
import type { Industry } from "@prisma/client";

/**
 * 搜索编排层（server-only，V1-A /search）。
 *
 * 宪法第 4/22 条：V1 搜索用最简单可验证的方案——复用已建好的案例/方案列表查询，
 * 叠加关键词 ILIKE（title/summary，不区分大小写）+ 行业筛选 + DEMO 门控，
 * **不引入全文索引 / pgvector 语义搜索**（PRODUCT_SPEC §7：先跑通再优化）。
 *
 * 返回"预览"结果：案例与方案各取前 N 条（默认 8）+ 各自 total，页面据此展示分组结果，
 * 并提供"查看全部"链接跳到 /cases?q=… 与 /solutions?q=…（完整分页在列表页做，避免
 * 在搜索页维护两套分页 UI —— 更简单、更少可错面）。
 *
 * 两类查询并行；任一 DB 失败降级为该项 ok:false（列表层已处理），不整体崩溃。
 */

const log = logger.child({ module: "server/search" });

/** 搜索页每类结果的预览条数上限。 */
export const SEARCH_PREVIEW_LIMIT = 8;

export interface SearchParams {
  /** 已由 SearchQuerySchema 校验/净化的非空关键词。 */
  q: string;
  industry?: Industry;
  includeDemo: boolean;
  /** 每类结果预览条数（默认 SEARCH_PREVIEW_LIMIT）。 */
  limit?: number;
}

export interface SearchResult {
  q: string;
  cases: CaseListResult;
  solutions: SolutionListResult;
  /** 两类查询是否都成功（供页面决定是否显示降级提示）。 */
  ok: boolean;
  /** 两类预览结果条数之和（用于"无结果"判定）。 */
  hits: number;
}

export async function searchPublic(params: SearchParams): Promise<SearchResult> {
  const limit = params.limit ?? SEARCH_PREVIEW_LIMIT;
  const caseSort: CaseSortField = "discoveredAt";
  const solSort: SolutionSortField = "publishedAt";

  try {
    const [cases, solutions] = await Promise.all([
      listPublicCases({
        offset: 0,
        limit,
        page: 1,
        pageSize: limit,
        industry: params.industry,
        q: params.q,
        sortBy: caseSort,
        sortOrder: "desc",
        includeDemo: params.includeDemo,
      }),
      listPublishedSolutions({
        offset: 0,
        limit,
        page: 1,
        pageSize: limit,
        industry: params.industry,
        q: params.q,
        sortBy: solSort,
        sortOrder: "desc",
        includeDemo: params.includeDemo,
      }),
    ]);

    return {
      q: params.q,
      cases,
      solutions,
      ok: cases.ok && solutions.ok,
      hits: cases.items.length + solutions.items.length,
    };
  } catch (err) {
    // listPublicCases / listPublishedSolutions 内部已 try/catch 降级；此处兜底防御。
    const message = err instanceof Error ? err.message : String(err);
    log.error("searchPublic failed", { err, q: params.q });
    const failed = { ok: false, items: [], total: 0, page: 1, pageSize: limit, hasPrev: false, hasNext: false, error: message };
    return {
      q: params.q,
      cases: failed as CaseListResult,
      solutions: failed as SolutionListResult,
      ok: false,
      hits: 0,
    };
  }
}
