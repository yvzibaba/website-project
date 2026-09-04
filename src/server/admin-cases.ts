import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Industry } from "@prisma/client";
import { getIndustryByEnum } from "@/server/industries";
import { isDemoEntity } from "@/server/demo";
import { CaseScoresSchema, type CaseScores } from "@/server/scoring";

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
    const [rows, rawCount] = await prisma.$transaction([
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

    // READ COMMITTED 下 count() 与 findMany() 各取各快照：并发写可能在两语句之间落地，令 count < items.length。
    // 诚实兜底：绝不报告比实际返回更少的总数（真实单用户场景 count≥items，此钳位无副作用）。
    const total = Math.max(rawCount, items.length);
    return { ok: true, items, total, truncated: total > items.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("listAdminCases failed", { err });
    return { ok: false, items: [], total: 0, truncated: false, error: message };
  }
}

/* ───────────────────── 后台「案例内容编辑台」读层（Phase 13 M5） ───────────────────── */

/** 单条证据（编辑台读视图）：字段照 Evidence 模型，Decimal 无、confidence 为 Int?。 */
export interface AdminCaseEvidenceDetail {
  id: string;
  type: string;
  grade: string | null;
  statement: string;
  sourceUrl: string | null;
  sourceType: string | null;
  confidence: number | null;
}

/** 案例详情（编辑台读视图）：全量可编辑面 + 关联计数 + 评分标量 + 原始评分输入 + 复算明细（M5b）。 */
export interface AdminCaseDetail {
  id: string;
  title: string;
  titleEn: string | null;
  summary: string | null;
  summaryEn: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  industry: Industry;
  industryName: string;
  industrySlug: string;
  stage: string;
  version: number;
  isDemo: boolean;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
  hasScoreBreakdown: boolean;
  /** 原始 10 维评分输入（编辑台表单初值）；未录入 → null。 */
  scoreInput: Record<string, number> | null;
  /** 数据层复算落库的评分明细（只读审计）；无/结构漂移 → null。 */
  scoreBreakdown: CaseScores | null;
  evidenceCount: number;
  solutionCount: number;
  publishedSolutionCount: number;
  evidences: AdminCaseEvidenceDetail[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminCaseDetailResult {
  ok: boolean;
  data: AdminCaseDetail | null;
  /** id 形状不合法或库无此案例——页面据此 notFound()，与 getAdminSolutionDetail 同构。 */
  notFound?: boolean;
  error?: string;
}

/**
 * 读单个案例的**后台全量**视图（含内部阶段 CANDIDATE/KEY_RESEARCH 与 DEMO 夹具——刻意区别于公开橱窗
 * `getPublicCaseById` 的门控）。供 `/admin/cases/[id]` 编辑台取初值：meta + 证据逐条（createdAt 正序，
 * 与公开详情一致）+ 关联计数 + 评分标量快照。**不做鉴权**——信任调用方是已过 `requireRole` 的后台页，
 * 页面越权 `return null` 时根本不会调用到这里（否则 leaf RSC flight 会泄露未公开案例内容）。
 */
export async function getAdminCaseDetail(id: string): Promise<AdminCaseDetailResult> {
  // 先挡明显非法 id（避免把怪异串丢进 findUnique）：cuid 大致 [a-z0-9]{10,}，不合规直接 when-not-found。
  if (!id || !/^[a-z0-9]{10,}$/i.test(id)) return { ok: false, data: null, notFound: true };

  try {
    const c = await prisma.case.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        titleEn: true,
        summary: true,
        summaryEn: true,
        sourceUrl: true,
        sourceType: true,
        industry: true,
        stage: true,
        version: true,
        opportunityScore: true,
        evidenceConfidence: true,
        scoreInput: true,
        scoreBreakdown: true,
        createdAt: true,
        updatedAt: true,
        evidences: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            type: true,
            grade: true,
            statement: true,
            sourceUrl: true,
            sourceType: true,
            confidence: true,
          },
        },
        _count: { select: { solutions: true } },
        solutions: { where: { status: "PUBLISHED" }, select: { id: true } },
      },
    });
    if (!c) return { ok: false, data: null, notFound: true };

    const meta = getIndustryByEnum(c.industry as Industry);
    const evidences: AdminCaseEvidenceDetail[] = c.evidences.map((e) => ({
      id: e.id,
      type: e.type,
      grade: e.grade,
      statement: e.statement,
      sourceUrl: e.sourceUrl,
      sourceType: e.sourceType,
      confidence: e.confidence,
    }));

    // 原始评分输入：仅接受"字符串→有限整数"的普通对象，脏形状一律降为 null（表单据此回落空初值，不伪造）。
    let scoreInput: Record<string, number> | null = null;
    if (c.scoreInput && typeof c.scoreInput === "object" && !Array.isArray(c.scoreInput)) {
      const entries = Object.entries(c.scoreInput as Record<string, unknown>).filter(
        ([, v]) => typeof v === "number" && Number.isFinite(v),
      );
      scoreInput = Object.fromEntries(entries) as Record<string, number>;
    }

    // 复算明细：入库前已由 CaseScoresSchema 校验；此处再防御性复核，结构漂移则诚实降级为 null。
    let scoreBreakdown: CaseScores | null = null;
    if (c.scoreBreakdown != null) {
      const parsed = CaseScoresSchema.safeParse(c.scoreBreakdown);
      if (parsed.success) scoreBreakdown = parsed.data as CaseScores;
      else log.warn("getAdminCaseDetail: scoreBreakdown failed schema check, degraded to null", { id, issues: parsed.error.issues.map((i) => i.message) });
    }

    return {
      ok: true,
      data: {
        id: c.id,
        title: c.title,
        titleEn: c.titleEn,
        summary: c.summary,
        summaryEn: c.summaryEn,
        sourceUrl: c.sourceUrl,
        sourceType: c.sourceType,
        industry: c.industry as Industry,
        industryName: meta?.name ?? "其他",
        industrySlug: meta?.slug ?? "other",
        stage: c.stage,
        version: c.version,
        isDemo: isDemoEntity(c),
        opportunityScore: c.opportunityScore,
        evidenceConfidence: c.evidenceConfidence,
        hasScoreBreakdown: c.scoreBreakdown != null,
        scoreInput,
        scoreBreakdown,
        evidenceCount: evidences.length,
        solutionCount: c._count.solutions,
        publishedSolutionCount: c.solutions.length,
        evidences,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("getAdminCaseDetail failed", { err, id });
    return { ok: false, data: null, error: message };
  }
}
