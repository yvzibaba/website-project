import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";
import { getIndustryByEnum } from "@/server/industries";
import { solutionDemoVisibility, DEMO_SOURCE_TYPE } from "@/server/demo";
import type { Industry } from "@/lib/validation";

/**
 * 方案数据层（server-only，V1-A /solutions 列表与详情）。
 *
 * 只暴露 status=PUBLISHED 的方案（DRAFT / UNDER_HUMAN_REVIEW 属内部态，宪法第 10 条：
 * 高风险方案默认禁止 AI 自动公开发布，须人工审核后才 PUBLISHED）。
 *
 * DEMO 可见性：方案本身无 sourceType，其 DEMO 与否取决于关联案例；默认排除（见 demo.ts）。
 * 注：里程碑 2 按创始人裁决**不种子任何方案**，故当前列表恒为空态；本层为 Phase 8/12
 * 的真实方案与购买闭环预先铺好查询与分页。
 */

const log = logger.child({ module: "server/solutions" });

export const SOLUTION_SORT_FIELDS = ["publishedAt", "opportunityScore", "price"] as const;
export type SolutionSortField = (typeof SOLUTION_SORT_FIELDS)[number];

export interface SolutionListParams {
  offset: number;
  limit: number;
  page: number;
  pageSize: number;
  industry?: Industry;
  sortBy: SolutionSortField;
  sortOrder: "asc" | "desc";
  includeDemo: boolean;
}

export interface SolutionListItem {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  priceDisplay: string | null;
  currency: string;
  industrySlug: string;
  industryName: string;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
  unknownVariableCount: number | null;
  needsProfessionalReview: boolean;
  riskDomains: string[];
  publishedAt: Date | null;
  isDemo: boolean;
}

export interface SolutionListResult {
  ok: boolean;
  items: SolutionListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  error?: string;
}

/** Decimal → 金额字符串（统一两位小数；金额不用浮点，宪法第 7 条：数字精确可追溯）。 */
function formatPrice(value: unknown, currency: string): string | null {
  if (value === null || value === undefined) return null;
  const symbol = currency === "USD" ? "$" : "¥";
  // Prisma 的 Decimal 提供 toFixed；toString() 会丢尾零（1999.00 → "1999"），故显式保留两位。
  if (typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
    return `${symbol}${(value as { toFixed(n: number): string }).toFixed(2)}`;
  }
  const s = typeof value === "string" ? value : String(value);
  return `${symbol}${s}`;
}

function buildSolutionWhere(params: { industry?: Industry; includeDemo: boolean }): Prisma.SolutionWhereInput {
  const base: Prisma.SolutionWhereInput = { status: "PUBLISHED" };
  if (params.industry) base.case = { industry: params.industry };
  const demo = solutionDemoVisibility(params.includeDemo);
  // demo 片段针对 case；与 base.case（行业）需合并到同一 case 条件
  if (demo.case) {
    base.case = { ...(base.case as object), ...(demo.case as object) } as Prisma.SolutionWhereInput["case"];
  }
  return base;
}

export async function listPublishedSolutions(params: SolutionListParams): Promise<SolutionListResult> {
  const where = buildSolutionWhere(params);
  const empty: SolutionListResult = {
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
      prisma.solution.findMany({
        where,
        orderBy: { [params.sortBy]: params.sortOrder },
        skip: params.offset,
        take: params.limit,
        include: { case: { select: { industry: true, sourceType: true } } },
      }),
      prisma.solution.count({ where }),
    ]);

    const items: SolutionListItem[] = rows.map((s) => {
      const meta = getIndustryByEnum(s.case?.industry as Industry);
      return {
        id: s.id,
        title: s.title,
        slug: s.slug,
        summary: s.summary,
        priceDisplay: formatPrice(s.price, s.currency),
        currency: s.currency,
        industrySlug: meta?.slug ?? "other",
        industryName: meta?.name ?? "其他",
        opportunityScore: s.opportunityScore,
        evidenceConfidence: s.evidenceConfidence,
        unknownVariableCount: s.unknownVariableCount,
        needsProfessionalReview: s.needsProfessionalReview,
        riskDomains: s.riskDomains,
        publishedAt: s.publishedAt,
        isDemo: s.case?.sourceType === DEMO_SOURCE_TYPE,
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
    log.error("listPublishedSolutions failed", { err });
    return { ...empty, error: message };
  }
}

/* ─────────────────────────── 详情 ─────────────────────────── */

export interface SolutionFinancialItem {
  id: string;
  capex: string | null;
  opexAnnual: string | null;
  revenueAnnual: string | null;
  roiPct: string | null;
  irrPct: string | null;
  paybackYears: string | null;
  currency: string;
  assumptions: unknown;
  calcRef: string | null;
  sourceUrl: string | null;
  note: string | null;
}

export interface SolutionUnknownItem {
  id: string;
  name: string;
  impact: string | null;
  howToResolve: string | null;
  severity: number | null;
}

export interface SolutionDetail {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  status: string;
  priceDisplay: string | null;
  currency: string;
  publishedAt: Date | null;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
  riskDomains: string[];
  needsProfessionalReview: boolean;
  caseTitle: string;
  caseId: string;
  industrySlug: string;
  industryName: string;
  financials: SolutionFinancialItem[];
  unknowns: SolutionUnknownItem[];
  hasBody: boolean;
  isDemo: boolean;
}

export type SolutionDetailResult =
  | { status: "found"; data: SolutionDetail }
  | { status: "not_found" }
  | { status: "error"; error: string };

export async function getPublishedSolutionById(id: string, includeDemo: boolean): Promise<SolutionDetailResult> {
  try {
    const s = await prisma.solution.findUnique({
      where: { id },
      include: {
        case: { select: { id: true, title: true, industry: true, sourceType: true } },
        financials: true,
        unknowns: true,
      },
    });

    if (!s) return { status: "not_found" };
    if (s.status !== "PUBLISHED") return { status: "not_found" };
    const isDemo = s.case?.sourceType === DEMO_SOURCE_TYPE;
    if (isDemo && !includeDemo) return { status: "not_found" };

    const meta = getIndustryByEnum(s.case?.industry as Industry);
    const dec = (v: unknown): string | null => (v === null || v === undefined ? null : (v as { toString(): string }).toString());

    return {
      status: "found",
      data: {
        id: s.id,
        title: s.title,
        slug: s.slug,
        summary: s.summary,
        status: s.status,
        priceDisplay: formatPrice(s.price, s.currency),
        currency: s.currency,
        publishedAt: s.publishedAt,
        opportunityScore: s.opportunityScore,
        evidenceConfidence: s.evidenceConfidence,
        riskDomains: s.riskDomains,
        needsProfessionalReview: s.needsProfessionalReview,
        caseTitle: s.case?.title ?? "—",
        caseId: s.case?.id ?? "",
        industrySlug: meta?.slug ?? "other",
        industryName: meta?.name ?? "其他",
        financials: s.financials.map((f) => ({
          id: f.id,
          capex: dec(f.capex),
          opexAnnual: dec(f.opexAnnual),
          revenueAnnual: dec(f.revenueAnnual),
          roiPct: dec(f.roiPct),
          irrPct: dec(f.irrPct),
          paybackYears: dec(f.paybackYears),
          currency: f.currency,
          assumptions: f.assumptions,
          calcRef: f.calcRef,
          sourceUrl: f.sourceUrl,
          note: f.note,
        })),
        unknowns: s.unknowns.map((u) => ({
          id: u.id,
          name: u.name,
          impact: u.impact,
          howToResolve: u.howToResolve,
          severity: u.severity,
        })),
        hasBody: s.body !== null && s.body !== undefined,
        isDemo,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("getPublishedSolutionById failed", { err, id });
    return { status: "error", error: message };
  }
}
