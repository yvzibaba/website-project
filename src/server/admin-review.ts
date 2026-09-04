import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Industry } from "@prisma/client";
import { getIndustryByEnum } from "@/server/industries";
import { isDemoEntity } from "@/server/demo";
import { solutionPublishBlockers } from "@/server/solution-admin";

/**
 * 后台「审核发布队列」只读聚合（Phase 13 M6，server-only）。
 *
 * 为什么（宪法「AI 做大量劳动、人做关键决策」+ 商业闭环「…→ 购买」）：
 *   Phase 8/9 之后，方案与案例会由多角色 AI 流水线**批量产出草稿**并推入待人工裁决态——
 *   方案进入 `UNDER_HUMAN_REVIEW`、案例停在内部阶段（`CANDIDATE`/`KEY_RESEARCH`）。但运营要逐个
 *   翻 `/admin/cases`、`/admin/solutions` 两张长列表才能找出「哪些在等我拍板」，人工决策这一步在
 *   后台是散点、无聚合入口。M6 立一个**跨实体的待办队列**：把「等人审核的方案」和「等人晋升到公开
 *   橱窗的案例」汇到一处，并对每个待审方案**就地显示发布缺口**（复用真实发布守卫 `publishGuard`，
 *   经 `solutionPublishBlockers` 只读预览），让审核人一眼看清「能不能发、还差什么」。
 *
 * 刻意**最小、纯读**：
 *   - **零 schema、零新写逻辑、零新端点**——队列上的「通过并发布 / 退回草稿 / 发布到橱窗」动作
 *     全复用 Phase 13 M1 的 `PATCH /api/admin/solutions/[id]`、`PATCH /api/admin/cases/[id]`
 *     （服务端仍跑 `publishGuard`/角色/CSRF 校验，UI 只是薄壳，绝不放松守卫）。
 *   - 本模块**不做鉴权**，信任已过 `requireRole(STAFF)` 的后台页调用（沿用 admin.ts / admin-cases.ts 口径）。
 *   - 只读聚合失败如实上抛，由页面 error 边界处理（与 `getAdminDashboardData` 同一策略，不静默降级编造空队列）。
 *
 * 诚实（宪法第 20 条）：所有条目来自数据库实时查询；发布就绪判定与真实发布走同一函数，不各说各话。
 */

const log = logger.child({ module: "server/admin-review" });

/** 未发布（内部）阶段：CANDIDATE / KEY_RESEARCH——晋升到 DEEP_CASE 及以后即进公开橱窗。 */
export const PENDING_CASE_STAGES = ["CANDIDATE", "KEY_RESEARCH"] as const;

/** 待审核方案：UNDER_HUMAN_REVIEW（AI/人工提交后等 staff 拍板发布或退回）。 */
export const PENDING_SOLUTION_STATUS = "UNDER_HUMAN_REVIEW" as const;

/** 队列每类硬上限（防无界拉取，超出记 truncated，与后台列表同一取向）。 */
export const REVIEW_QUEUE_LIMIT = 200;

export interface ReviewSolutionItem {
  id: string;
  title: string;
  slug: string;
  status: string;
  caseId: string;
  caseTitle: string;
  industryName: string;
  isDemo: boolean;
  /** 价格两位小数字符串，未定价为 null。 */
  price: string | null;
  priceDisplay: string | null;
  currency: string;
  riskDomains: string[];
  needsProfessionalReview: boolean;
  /** 复用真实发布守卫的只读预览；空数组 = 就绪可发。 */
  publishBlockers: string[];
  unknownVariableCount: number;
  orderCount: number;
  version: number;
  updatedAt: Date;
}

export interface ReviewCaseItem {
  id: string;
  title: string;
  stage: string;
  industryName: string;
  isDemo: boolean;
  evidenceCount: number;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
  version: number;
  updatedAt: Date;
}

export interface ReviewQueueData {
  solutions: ReviewSolutionItem[];
  cases: ReviewCaseItem[];
  /** 各自是否被 REVIEW_QUEUE_LIMIT 截断（total 反映全量待办数）。 */
  solutionsTruncated: boolean;
  casesTruncated: boolean;
  solutionTotal: number;
  caseTotal: number;
  generatedAt: Date;
}

function priceOf(v: { toFixed(d: number): string } | null): string | null {
  return v ? v.toFixed(2) : null;
}
function priceDisplayOf(v: { toFixed(d: number): string } | null, currency: string): string | null {
  if (!v) return null;
  return `${currency === "USD" ? "$" : "¥"}${v.toFixed(2)}`;
}

/** 跨实体待办队列：等待人工审核的方案 + 等待晋升到橱窗的案例。 */
export async function getReviewQueue(): Promise<ReviewQueueData> {
  const [solRows, solTotal, caseRows, caseTotal] = await prisma.$transaction([
    prisma.solution.findMany({
      where: { status: PENDING_SOLUTION_STATUS },
      orderBy: { updatedAt: "desc" },
      take: REVIEW_QUEUE_LIMIT + 1, // 多取一条判 truncated
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        price: true,
        riskDomains: true,
        needsProfessionalReview: true,
        version: true,
        currency: true,
        updatedAt: true,
        _count: { select: { orders: true, unknowns: true } },
        case: {
          select: {
            id: true,
            title: true,
            industry: true,
            sourceType: true,
          },
        },
      },
    }),
    prisma.solution.count({ where: { status: PENDING_SOLUTION_STATUS } }),
    prisma.case.findMany({
      where: { stage: { in: [...PENDING_CASE_STAGES] } },
      orderBy: { updatedAt: "desc" },
      take: REVIEW_QUEUE_LIMIT + 1,
      select: {
        id: true,
        title: true,
        stage: true,
        industry: true,
        sourceType: true,
        version: true,
        opportunityScore: true,
        evidenceConfidence: true,
        updatedAt: true,
        _count: { select: { evidences: true } },
      },
    }),
    prisma.case.count({ where: { stage: { in: [...PENDING_CASE_STAGES] } } }),
  ]);

  const solutionsOver = solRows.length > REVIEW_QUEUE_LIMIT;
  const casesOver = caseRows.length > REVIEW_QUEUE_LIMIT;

  const solutions: ReviewSolutionItem[] = (solutionsOver ? solRows.slice(0, REVIEW_QUEUE_LIMIT) : solRows).map((s) => {
    const p = s.price as unknown as { toFixed(d: number): string } | null;
    return {
      id: s.id,
      title: s.title,
      slug: s.slug,
      status: s.status,
      caseId: s.case?.id ?? "",
      caseTitle: s.case?.title ?? "（案例已删除）",
      industryName: s.case ? (getIndustryByEnum(s.case.industry as Industry)?.name ?? "其他") : "其他",
      // 方案的 DEMO 属性由其挂靠案例的 sourceType 判定（与 listAdminSolutions 同一口径）。
      isDemo: s.case ? isDemoEntity({ sourceType: s.case.sourceType }) : false,
      price: priceOf(p),
      priceDisplay: priceDisplayOf(p, s.currency),
      currency: s.currency,
      riskDomains: s.riskDomains,
      needsProfessionalReview: s.needsProfessionalReview,
      // 只读预览：把这条真实字段喂回发布守卫，得到「还差什么才能发布」。
      publishBlockers: solutionPublishBlockers({
        price: s.price,
        riskDomains: s.riskDomains,
        needsProfessionalReview: s.needsProfessionalReview,
      }),
      unknownVariableCount: s._count.unknowns,
      orderCount: s._count.orders,
      version: s.version,
      updatedAt: s.updatedAt,
    };
  });

  const cases: ReviewCaseItem[] = (casesOver ? caseRows.slice(0, REVIEW_QUEUE_LIMIT) : caseRows).map((c) => ({
    id: c.id,
    title: c.title,
    stage: c.stage,
    industryName: getIndustryByEnum(c.industry as Industry)?.name ?? "其他",
    isDemo: isDemoEntity({ sourceType: c.sourceType }),
    evidenceCount: c._count.evidences,
    opportunityScore: c.opportunityScore,
    evidenceConfidence: c.evidenceConfidence,
    version: c.version,
    updatedAt: c.updatedAt,
  }));

  log.info("review queue aggregated", {
    solutions: solutions.length,
    cases: cases.length,
    solTotal,
    caseTotal,
  });

  return {
    solutions,
    cases,
    solutionsTruncated: solutionsOver,
    casesTruncated: casesOver,
    solutionTotal: solTotal,
    caseTotal,
    generatedAt: new Date(),
  };
}
