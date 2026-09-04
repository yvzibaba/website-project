import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Industry } from "@prisma/client";
import { getIndustryByEnum } from "@/server/industries";
import { isDemoEntity } from "@/server/demo";

/**
 * 方案「后台」只读视图（Phase 13 M3，server-only）。
 *
 * 为什么：公开的 `listPublishedSolutions`（Phase 5/8）刻意只暴露 status=PUBLISHED、且默认排除 DEMO——
 * 那是给「用户查看→购买」的商店橱窗。但后台运营要管的是**全量真相**：草稿态、人工审核中、
 * 挂在 DEMO 案例上的方案都得可见可数，否则运营刚建的 DRAFT 方案会"凭空消失"、误判没写进去。
 * 尤其 Phase 12 打通购买闭环后，「方案从录入到可售」这条链路的后台入口缺失——本层 + 新建/发布 UI
 * 补齐它，让方案能在后台被真正建出来、定价、发布，进而被购买。与写端点（Phase 13 M1 的
 * `/api/admin/solutions`）配套。
 *
 * 边界（诚实，宪法第 2/20 条）：
 *   - **本模块不做鉴权**——它是数据读层，信任调用方是已过 `requireRole(STAFF_ROLES)` 门禁的后台页面；
 *     页面本身仍按 layout+page 双层防御自守（越权时根本不调用这里）。
 *   - V1 不分页、设硬上限 `ADMIN_SOLUTION_LIST_LIMIT`（默认 500）兜底，超出如实回报 `truncated=true`，
 *     避免后台首屏无界拉全表（与 admin-cases 同构，简单优先）。
 */

const log = logger.child({ module: "server/admin-solutions" });

export interface AdminSolutionListItem {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  /** 落库态：DRAFT / UNDER_HUMAN_REVIEW / PUBLISHED。 */
  status: string;
  version: number;
  /** 价格两位小数字符串（含币种符号）；null=未定价（发布守卫会拦）。 */
  priceDisplay: string | null;
  /** 原始价格字符串（两位小数），供表单回填/判断是否已定价；null=未定价。 */
  price: string | null;
  currency: string;
  needsProfessionalReview: boolean;
  riskDomains: string[];
  unknownVariableCount: number;
  financialCount: number;
  orderCount: number;
  caseId: string;
  caseTitle: string;
  industry: Industry | null;
  industryName: string;
  industrySlug: string;
  /** 方案 DEMO 与否取决于其关联案例（方案本身无 sourceType）。 */
  isDemo: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
}

export interface AdminSolutionListResult {
  ok: boolean;
  items: AdminSolutionListItem[];
  /** 命中总数（total 可能 > items.length，若被上限截断）。 */
  total: number;
  /** items 是否因上限被截断（total > items.length）。 */
  truncated: boolean;
  error?: string;
}

/** 后台详情页里的一条财务测算（Decimal 一律归一为两位小数字符串，null 保留；宪法第 7 条数字精确）。 */
export interface AdminSolutionFinancialDetail {
  id: string;
  capex: string | null;
  opexAnnual: string | null;
  revenueAnnual: string | null;
  roiPct: string | null;
  irrPct: string | null;
  paybackYears: string | null;
  currency: string;
  note: string | null;
  calcRef: string | null;
  sourceUrl: string | null;
}

/** 后台详情页里的一条关键未知变量（规则 6/9：不确定性显式列出）。 */
export interface AdminSolutionUnknownDetail {
  id: string;
  name: string;
  impact: string | null;
  howToResolve: string | null;
  severity: number | null;
}

/**
 * 方案「后台」详情读视图（Phase 13 M4）：在列表项字段之上补齐**编辑台所需的全量真相**——
 * 原始 body（供 34 分节编辑器取初值 + 合并保留 extras）、结构化的 financials / unknowns 明细。
 * 刻意复用列表项形状（extends）保证两处字段口径一致、不漂移（宪法第 16 条单一真源）。
 */
export interface AdminSolutionDetail extends AdminSolutionListItem {
  titleEn: string | null;
  /** 原始入库 body（可能是任意 JSON 结构，编辑器按 canonical key 合并、保留未知键）。 */
  body: unknown;
  financials: AdminSolutionFinancialDetail[];
  unknowns: AdminSolutionUnknownDetail[];
}

export interface AdminSolutionDetailResult {
  ok: boolean;
  data: AdminSolutionDetail | null;
  /** id 合法但库无此方案 → true（页面据此 notFound()，与「读失败」区分）。 */
  notFound?: boolean;
  error?: string;
}

/** 后台首屏最多渲染多少条（V1 简单优先，超出如实标 truncated 而非静默丢弃）。 */
export const ADMIN_SOLUTION_LIST_LIMIT = 500;

/** Decimal / number / string → 两位小数字符串（不含币种符号），供表单回填与定价判定。 */
function priceToFixed2(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
    return (value as { toFixed(n: number): string }).toFixed(2);
  }
  return String(value);
}

/** 两位小数字符串 + 币种 → 展示金额（与公开层 formatPrice 同口径：¥/$ 前缀）。 */
function priceDisplay(value: string | null, currency: string): string | null {
  if (value === null) return null;
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${value}`;
}

/**
 * 列出全部方案（含 DRAFT / UNDER_HUMAN_REVIEW / DEMO 关联方案），按 updatedAt 倒序（最近在改的排前）。
 * DB 不可达 → 降级 ok:false + 空列表，由页面显示提示条而非崩溃（与公开列表、admin-cases 一致）。
 */
export async function listAdminSolutions(): Promise<AdminSolutionListResult> {
  try {
    const [rows, rawCount] = await prisma.$transaction([
      prisma.solution.findMany({
        orderBy: { updatedAt: "desc" },
        take: ADMIN_SOLUTION_LIST_LIMIT,
        select: {
          id: true,
          title: true,
          slug: true,
          summary: true,
          status: true,
          version: true,
          price: true,
          currency: true,
          needsProfessionalReview: true,
          riskDomains: true,
          unknownVariableCount: true,
          publishedAt: true,
          updatedAt: true,
          case: {
            select: { id: true, title: true, industry: true, sourceType: true },
          },
          _count: { select: { financials: true, unknowns: true, orders: true } },
        },
      }),
      prisma.solution.count(),
    ]);

    const items: AdminSolutionListItem[] = rows.map((s) => {
      const price = priceToFixed2(s.price);
      const meta = s.case?.industry ? getIndustryByEnum(s.case.industry as Industry) : null;
      return {
        id: s.id,
        title: s.title,
        slug: s.slug,
        summary: s.summary,
        status: s.status,
        version: s.version,
        price,
        priceDisplay: priceDisplay(price, s.currency),
        currency: s.currency,
        needsProfessionalReview: s.needsProfessionalReview,
        riskDomains: s.riskDomains,
        unknownVariableCount: s._count.unknowns,
        financialCount: s._count.financials,
        orderCount: s._count.orders,
        caseId: s.case?.id ?? "",
        caseTitle: s.case?.title ?? "（关联案例缺失）",
        industry: (s.case?.industry as Industry) ?? null,
        industryName: meta?.name ?? "其他",
        industrySlug: meta?.slug ?? "other",
        isDemo: s.case ? isDemoEntity(s.case) : false,
        publishedAt: s.publishedAt,
        updatedAt: s.updatedAt,
      };
    });

    // READ COMMITTED 下 count() 与 findMany() 各取各的快照：并发插入/删除恰好在两条语句之间落地时，
    // count 可能瞬时 < 已返回的 items.length → total<items 自相矛盾。诚实原则：绝不报告比实际返回更少的总数，
    // 故取二者较大者兜底（真实单用户场景 count≥items，此钳位无副作用）。
    const total = Math.max(rawCount, items.length);
    return { ok: true, items, total, truncated: total > items.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("listAdminSolutions failed", { err });
    return { ok: false, items: [], total: 0, truncated: false, error: message };
  }
}

/**
 * 读单条方案的**后台全量详情**（Phase 13 M4，供 `/admin/solutions/[id]` 编辑台）。
 *
 * 与公开 `getPublishedSolutionById` 的分工：后者面向消费者（只 PUBLISHED、门控正文、脱敏），
 * 本函数面向内部运营（任何状态、透出原始 body 与全部财务/未知明细，供录入编辑）。
 * **不做鉴权**——信任调用方是已 `requireRole(STAFF)` 自守的后台页面（越权时页面根本不调这里）。
 * id 非 cuid 形状 → 视作 notFound（不泄露「格式错」差异）；DB 异常 → 降级 ok:false。
 */
export async function getAdminSolutionDetail(id: string): Promise<AdminSolutionDetailResult> {
  if (!id || !/^[a-z0-9]{10,}$/i.test(id)) return { ok: false, data: null, notFound: true };
  try {
    const s = await prisma.solution.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        slug: true,
        summary: true,
        titleEn: true,
        body: true,
        status: true,
        version: true,
        price: true,
        currency: true,
        needsProfessionalReview: true,
        riskDomains: true,
        unknownVariableCount: true,
        publishedAt: true,
        updatedAt: true,
        case: { select: { id: true, title: true, industry: true, sourceType: true } },
        financials: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            capex: true,
            opexAnnual: true,
            revenueAnnual: true,
            roiPct: true,
            irrPct: true,
            paybackYears: true,
            currency: true,
            note: true,
            calcRef: true,
            sourceUrl: true,
          },
        },
        unknowns: {
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, impact: true, howToResolve: true, severity: true },
        },
        _count: { select: { orders: true } },
      },
    });
    if (!s) return { ok: false, data: null, notFound: true };

    const price = priceToFixed2(s.price);
    const meta = s.case?.industry ? getIndustryByEnum(s.case.industry as Industry) : null;
    const data: AdminSolutionDetail = {
      id: s.id,
      title: s.title,
      slug: s.slug,
      summary: s.summary,
      status: s.status,
      version: s.version,
      price,
      priceDisplay: priceDisplay(price, s.currency),
      currency: s.currency,
      needsProfessionalReview: s.needsProfessionalReview,
      riskDomains: s.riskDomains,
      unknownVariableCount: s.unknowns.length,
      financialCount: s.financials.length,
      orderCount: s._count.orders,
      caseId: s.case?.id ?? "",
      caseTitle: s.case?.title ?? "（关联案例缺失）",
      industry: (s.case?.industry as Industry) ?? null,
      industryName: meta?.name ?? "其他",
      industrySlug: meta?.slug ?? "other",
      isDemo: s.case ? isDemoEntity(s.case) : false,
      publishedAt: s.publishedAt,
      updatedAt: s.updatedAt,
      titleEn: s.titleEn,
      body: s.body ?? null,
      financials: s.financials.map((f) => ({
        id: f.id,
        capex: priceToFixed2(f.capex),
        opexAnnual: priceToFixed2(f.opexAnnual),
        revenueAnnual: priceToFixed2(f.revenueAnnual),
        roiPct: priceToFixed2(f.roiPct),
        irrPct: priceToFixed2(f.irrPct),
        paybackYears: priceToFixed2(f.paybackYears),
        currency: f.currency,
        note: f.note,
        calcRef: f.calcRef,
        sourceUrl: f.sourceUrl,
      })),
      unknowns: s.unknowns.map((u) => ({
        id: u.id,
        name: u.name,
        impact: u.impact,
        howToResolve: u.howToResolve,
        severity: u.severity,
      })),
    };
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("getAdminSolutionDetail failed", { err, id });
    return { ok: false, data: null, error: message };
  }
}
