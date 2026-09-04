import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Industry } from "@prisma/client";
import { getIndustryByEnum } from "@/server/industries";
import { isDemoEntity } from "@/server/demo";

/**
 * 案例「后台」只读视图（Phase 13 M2，server-only）。
 *
 * 为什么：公开的 `listPublicCases`（Phase 5）刻意只暴露 DEEP_CASE 及以后、且默认排除 DEMO——
 * 那是给「用户查看→购买」的商店橱窗。但后台运营/AI 撰写要看到的是**全量真相**：候选态、
 * 研究中间态、DEMO 夹具都得可见可数，否则运营看不到自己刚建的 CANDIDATE 案例、误以为没写进去。
 * 所以单开一个不受公开门控约束的 admin 读层，与写端点（Phase 13 M1 的 `/api/admin/cases`）配套。
 *
 * 边界（诚实，宪法第 2/20 条）：
 *   - **本模块不做鉴权**——它是数据读层，信任调用方是已过 `requireRole(STAFF_ROLES)` 门禁的后台页面；
 *     页面本身仍按 layout+page 双层防御自守（越权时根本不调用这里）。
 *   - V1 不分页、设硬上限 `MAX_ROWS`（默认 500）兜底，超出如实回报 `truncated=true`，
 *     避免后台首屏无界拉全表；分页 UI 待数据量真上来再做（简单优先）。
 */

const log = logger.child({ module: "server/admin-cases" });

export interface AdminCaseListItem {
  id: string;
  title: string;
  industry: Industry;
  industryName: string;
  industrySlug: string;
  stage: string;
  sourceType: string | null;
  version: number;
  isDemo: boolean;
  evidenceCount: number;
  solutionCount: number;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
  updatedAt: Date;
}

export interface AdminCaseListResult {
  ok: boolean;
  items: AdminCaseListItem[];
  /** 命中总数（total 可能 > items.length，若被 MAX_ROWS 截断）。 */
  total: number;
  /** items 是否因上限被截断（total > items.length）。 */
  truncated: boolean;
  error?: string;
}

/** 后台首屏最多渲染多少条（V1 简单优先，超出如实标 truncated 而非静默丢弃）。 */
export const ADMIN_CASE_LIST_LIMIT = 500;

/**
 * 列出全部案例（含内部阶段与 DEMO 夹具），按 updatedAt 倒序（最近在改的排前）。
 * DB 不可达 → 降级 ok:false + 空列表，由页面显示提示条而非崩溃（与公开列表一致）。
 */
export async function listAdminCases(): Promise<AdminCaseListResult> {
  try {
    const [rows, total] = await prisma.$transaction([
      prisma.case.findMany({
        orderBy: { updatedAt: "desc" },
        take: ADMIN_CASE_LIST_LIMIT,
        select: {
          id: true,
          title: true,
          industry: true,
          stage: true,
          sourceType: true,
          version: true,
          opportunityScore: true,
          evidenceConfidence: true,
          updatedAt: true,
          _count: { select: { evidences: true, solutions: true } },
        },
      }),
      prisma.case.count(),
    ]);

    const items: AdminCaseListItem[] = rows.map((c) => {
      const meta = getIndustryByEnum(c.industry as Industry);
      return {
        id: c.id,
        title: c.title,
        industry: c.industry as Industry,
        industryName: meta?.name ?? "其他",
        industrySlug: meta?.slug ?? "other",
        stage: c.stage,
        sourceType: c.sourceType,
        version: c.version,
        isDemo: isDemoEntity(c),
        evidenceCount: c._count.evidences,
        solutionCount: c._count.solutions,
        opportunityScore: c.opportunityScore,
        evidenceConfidence: c.evidenceConfidence,
        updatedAt: c.updatedAt,
      };
    });

    return { ok: true, items, total, truncated: total > items.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("listAdminCases failed", { err });
    return { ok: false, items: [], total: 0, truncated: false, error: message };
  }
}
