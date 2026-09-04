import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Industry, Prisma } from "@prisma/client";
import { PUBLIC_CASE_STAGES, getIndustryByEnum } from "@/server/industries";
import { caseDemoVisibility, isDemoEntity } from "@/server/demo";
/**
 * 案例数据层（server-only，V1-A /cases 列表与详情）。
 *
 * 职责：把"公开可见案例"的查询/分页/筛选集中在此，页面只负责渲染。
 * 公开可见 = stage ∈ PUBLIC_CASE_STAGES（DEEP_CASE 及以后），CANDIDATE/KEY_RESEARCH
 * 是内部流水线中间态，不对外（见 industries.ts 业务规则说明，标注为推断待创始人确认）。
 *
 * DEMO 可见性（宪法第 20 条）：默认排除 DEMO_FIXTURE 行；仅 includeDemo=true（?demo=1）
 * 时纳入，页面须打「DEMO 数据」角标。详见 demo.ts。
 *
 * 错误策略：
 *   - 列表：DB 不可达时降级 ok:false + 空列表，页面展示提示条而非崩溃（与 industries 一致）；
 *   - 详情：返回判别联合 found/not_found/error，让页面分别 notFound() 或抛错交给 error 边界。
 */

const log = logger.child({ module: "server/cases" });

/** 可排序字段白名单（配合 makeSortSchema，防注入/拖库）。 */
export const CASE_SORT_FIELDS = ["discoveredAt", "opportunityScore", "title"] as const;
export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];

export interface CaseListParams {
  offset: number;
  limit: number;
  page: number;
  pageSize: number;
  industry?: Industry;
  /** 关键词模糊匹配（title/summary，ILIKE 不区分大小写）；为空/未传则不过滤。 */
  q?: string;
  sortBy: CaseSortField;
  sortOrder: "asc" | "desc";
  includeDemo: boolean;
}

export interface CaseListItem {
  id: string;
  title: string;
  summary: string | null;
  industry: Industry;
  industrySlug: string;
  industryName: string;
  regionName: string | null;
  discoveredAt: Date;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
  isDemo: boolean;
}

export interface CaseListResult {
  ok: boolean;
  items: CaseListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  error?: string;
}

/** 组装公开案例的 where 条件（stage + 可选行业 + 可选关键词 + DEMO 可见性）。 */
function buildCaseWhere(params: { industry?: Industry; q?: string; includeDemo: boolean }): Prisma.CaseWhereInput {
  // 用 AND 数组组合：DEMO 片段与关键词片段都用 OR，不能作为同级键共存于一个 where 对象。
  const conds: Prisma.CaseWhereInput[] = [{ stage: { in: [...PUBLIC_CASE_STAGES] } }];
  if (params.industry) conds.push({ industry: params.industry });
  const q = params.q?.trim();
  if (q) {
    conds.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { summary: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  const demo = caseDemoVisibility(params.includeDemo);
  if (demo.OR) conds.push(demo);
  return { AND: conds };
}

export async function listPublicCases(params: CaseListParams): Promise<CaseListResult> {
  const where = buildCaseWhere(params);
  const empty: CaseListResult = {
    ok: false,
    items: [],
    total: 0,
    page: params.page,
    pageSize: params.pageSize,
    hasPrev: false,
    hasNext: false,
  };
  try {
    const [rows, total] = await prisma.$transaction([
      prisma.case.findMany({
        where,
        orderBy: { [params.sortBy]: params.sortOrder },
        skip: params.offset,
        take: params.limit,
        include: { region: { select: { name: true } } },
      }),
      prisma.case.count({ where }),
    ]);

    const items: CaseListItem[] = rows.map((c) => {
      const meta = getIndustryByEnum(c.industry as Industry);
      return {
        id: c.id,
        title: c.title,
        summary: c.summary,
        industry: c.industry as Industry,
        industrySlug: meta?.slug ?? "other",
        industryName: meta?.name ?? "其他",
        regionName: c.region?.name ?? null,
        discoveredAt: c.discoveredAt,
        opportunityScore: c.opportunityScore,
        evidenceConfidence: c.evidenceConfidence,
        isDemo: isDemoEntity(c),
      };
    });

    return {
      ok: true,
      items,
      total,
      page: params.page,
      pageSize: params.pageSize,
      hasPrev: params.page > 1,
      hasNext: params.offset + rows.length < total,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("listPublicCases failed", { err });
    return { ...empty, error: message };
  }
}

/* ─────────────────────────── 详情 ─────────────────────────── */

export interface CaseEvidenceItem {
  id: string;
  type: string;
  statement: string;
  sourceUrl: string | null;
  sourceType: string | null;
  confidence: number | null;
}

export interface CaseCapabilityItem {
  capabilityId: string;
  name: string;
  nameEn: string | null;
  category: string | null;
  maturity: string;
  relevance: number | null;
  note: string | null;
}

export interface CaseDetail {
  id: string;
  title: string;
  summary: string | null;
  industry: Industry;
  industrySlug: string;
  industryName: string;
  stage: string;
  regionName: string | null;
  regionCountry: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  discoveredAt: Date;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
  businessModel: { name: string; description: string | null; revenueStreams: string[]; costStructure: string[] } | null;
  evidences: CaseEvidenceItem[];
  capabilities: CaseCapabilityItem[];
  publishedSolutionCount: number;
  isDemo: boolean;
}

export type CaseDetailResult =
  | { status: "found"; data: CaseDetail }
  | { status: "not_found" }
  | { status: "error"; error: string };

export async function getPublicCaseById(id: string, includeDemo: boolean): Promise<CaseDetailResult> {
  try {
    const c = await prisma.case.findUnique({
      where: { id },
      include: {
        region: { select: { name: true, country: true } },
        businessModel: true,
        evidences: { orderBy: { createdAt: "asc" } },
        capabilities: { include: { capability: true } },
        _count: { select: { solutions: { where: { status: "PUBLISHED" } } } },
      },
    });

    if (!c) return { status: "not_found" };
    // 非公开阶段的案例不对外暴露（内部流水线中间态）
    const publicStages: string[] = [...PUBLIC_CASE_STAGES];
    if (!publicStages.includes(c.stage)) return { status: "not_found" };
    // DEMO 案例仅在显式 includeDemo 时可见
    const demo = isDemoEntity(c);
    if (demo && !includeDemo) return { status: "not_found" };

    const meta = getIndustryByEnum(c.industry as Industry);
    return {
      status: "found",
      data: {
        id: c.id,
        title: c.title,
        summary: c.summary,
        industry: c.industry as Industry,
        industrySlug: meta?.slug ?? "other",
        industryName: meta?.name ?? "其他",
        stage: c.stage,
        regionName: c.region?.name ?? null,
        regionCountry: c.region?.country ?? null,
        sourceUrl: c.sourceUrl,
        sourceType: c.sourceType,
        discoveredAt: c.discoveredAt,
        opportunityScore: c.opportunityScore,
        evidenceConfidence: c.evidenceConfidence,
        businessModel: c.businessModel
          ? {
              name: c.businessModel.name,
              description: c.businessModel.description,
              revenueStreams: c.businessModel.revenueStreams,
              costStructure: c.businessModel.costStructure,
            }
          : null,
        evidences: c.evidences.map((e) => ({
          id: e.id,
          type: e.type,
          statement: e.statement,
          sourceUrl: e.sourceUrl,
          sourceType: e.sourceType,
          confidence: e.confidence,
        })),
        capabilities: c.capabilities.map((cc) => ({
          capabilityId: cc.capabilityId,
          name: cc.capability.name,
          nameEn: cc.capability.nameEn,
          category: cc.capability.category,
          maturity: cc.capability.maturity,
          relevance: cc.relevance,
          note: cc.note,
        })),
        publishedSolutionCount: c._count.solutions,
        isDemo: demo,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("getPublicCaseById failed", { err, id });
    return { status: "error", error: message };
  }
}
