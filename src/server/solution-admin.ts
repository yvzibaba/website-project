import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma, type ChangeAction } from "@prisma/client";
import {
  CuidSchema,
  SlugSchema,
  CurrencySchema,
  SolutionStatusSchema,
} from "@/lib/validation";

/**
 * 方案的**数据层 CRUD**（Phase 8 M1，server-only）。
 *
 * 为什么：`prisma/seed.ts` 刻意不灌 DEMO 方案（Phase 5 里程碑 2 裁决——方案涉及定价/购买，
 * 必须走真实多角色流水线，宪法第 20 条），因此方案表当前 0 行、"案例→方案→购买"闭环卡在
 * 数据入口。M1 先建**受校验、可审计的写入口**（对应 Phase 7 M5 的 case-admin 模式），
 * 让 Phase 8 M2+ 的多角色 AI 流水线与 Phase 13 的后台 UI 有真实落地路径。
 *
 * 边界（诚实，宪法第 2/4/20/21 条）：
 *   - **本模块不做鉴权**，信任调用方。对外 HTTP 写路由 + 角色门禁统一延后 Phase 13
 *     （M2 已交付 requireRole 原语，届时薄薄一层包起来即可）。
 *   - `actor`（`human:<userId>` / `ai:<model>`）仅作审计标注写入 ChangeLog.changedBy，
 *     **不代表已鉴权**。
 *   - **不自动评分**：`opportunityScore` / `evidenceConfidence` 留 null 或人工填。
 *     方案的三件套公式与案例的可能不同（例：加入 "复用度" 或 "供应链复杂度" 权重），
 *     属"公式形态未定"——先建数据入口，Phase 8 M4+ 再走 SCORING §5 升版流程。
 *     唯一例外是 `unknownVariableCount`：它就是 UnknownVariable 表的实时条数（可计算事实）。
 *   - **状态机最小约束**：create 只允许 DRAFT；update 可改到 DRAFT/UNDER_HUMAN_REVIEW/PUBLISHED，
 *     但改到 PUBLISHED 需通过 `publishGuard`——非空 price + 若列了 riskDomains 则
 *     needsProfessionalReview 必须为 true（宪法第 21 条：高风险域必须显式人工确认）。
 *   - **删除守卫**：任一 Order（PENDING/PAID/REFUNDED/CANCELED 都算）关联 → `blocked` 拒绝；
 *     撤单/退款流程不在 V1 建（属支付侧 ROADMAP #5）。
 *
 * 错误策略：一律判别联合返回（invalid/not_found/blocked/error），不向调用方抛裸异常。
 */

const log = logger.child({ module: "server/solution-admin" });

/* ─────────────────────────── 入参 schema（复用 validation 单一真源） ─────────────────────────── */

/**
 * Decimal 字符串：Prisma `@db.Decimal(12,2)` / `@db.Decimal(14,2)` / `@db.Decimal(8,4)` 都
 * 接受 string 输入（无损），走字符串避开 JS 浮点污染（宪法第 7 条：程序计算 > 口算）。
 * 允许最多 15 位整数 + 最多 6 位小数（远超 schema 精度，具体校验交 Prisma/DB 兜底）。
 */
const DecimalStringSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, "金额/比率必须是十进制数字（不含负号）");

/** 新建方案入参。status 强制 DRAFT（走 publish 转态，防绕过守卫）。 */
export const SolutionCreateSchema = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(300, "标题过长"),
  slug: SlugSchema,
  caseId: CuidSchema,
  titleEn: z.string().trim().max(300).optional(),
  summary: z.string().trim().max(5000).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  price: DecimalStringSchema.optional(),
  currency: CurrencySchema.optional(),
  riskDomains: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  needsProfessionalReview: z.boolean().optional(),
});
export type SolutionCreateInput = z.infer<typeof SolutionCreateSchema>;

/** 更新方案入参：全部可选但至少一项；version 服务端自增；status 变更走 publishGuard。 */
export const SolutionUpdateSchema = z
  .object({
    title: z.string().trim().min(1, "标题不能为空").max(300).optional(),
    slug: SlugSchema.optional(),
    titleEn: z.string().trim().max(300).optional(),
    summary: z.string().trim().max(5000).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
    price: DecimalStringSchema.optional(),
    currency: CurrencySchema.optional(),
    riskDomains: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
    needsProfessionalReview: z.boolean().optional(),
    status: SolutionStatusSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "没有需要更新的字段" });
export type SolutionUpdateInput = z.infer<typeof SolutionUpdateSchema>;

/** 财务条目入参（Decimal 用 string 传，避免 JS 浮点污染；schema 层只校验格式，程序计算在 M4+）。 */
export const SolutionFinancialInputSchema = z.object({
  capex: DecimalStringSchema.optional(),
  opexAnnual: DecimalStringSchema.optional(),
  revenueAnnual: DecimalStringSchema.optional(),
  roiPct: DecimalStringSchema.optional(),
  irrPct: DecimalStringSchema.optional(),
  paybackYears: DecimalStringSchema.optional(),
  currency: CurrencySchema.optional(),
  assumptions: z.record(z.string(), z.unknown()).optional(),
  calcRef: z.string().trim().max(500).optional(),
  sourceUrl: z.string().trim().max(2000).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type SolutionFinancialInput = z.infer<typeof SolutionFinancialInputSchema>;

/** 关键未知变量入参（规则的 6/9 条：不确定性必须显式列出，不能靠综合分掩盖）。 */
export const SolutionUnknownInputSchema = z.object({
  name: z.string().trim().min(1, "变量名不能为空").max(200, "变量名过长"),
  impact: z.string().trim().max(2000).optional(),
  howToResolve: z.string().trim().max(2000).optional(),
  severity: z.number().int().min(0).max(100).optional(),
});
export type SolutionUnknownInput = z.infer<typeof SolutionUnknownInputSchema>;

/* ─────────────────────────── 结果类型 ─────────────────────────── */

export interface SolutionMutationResult {
  status: "ok" | "invalid" | "not_found" | "blocked" | "error";
  solutionId?: string;
  financialId?: string;
  unknownId?: string;
  fieldErrors?: Record<string, string[]>;
  error?: string;
}

/* ─────────────────────────── 内部工具 ─────────────────────────── */

function toFieldErrors(err: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === null || v === undefined ? (Prisma.DbNull as typeof Prisma.DbNull) : (v as Prisma.InputJsonValue);
}

function changeLogArgs(
  entityId: string,
  action: ChangeAction,
  actor: string | undefined,
  reason: string,
  before: unknown,
  after: unknown,
): Prisma.ChangeLogUncheckedCreateInput {
  return {
    entityType: "Solution",
    entityId,
    action,
    changedBy: actor ?? null,
    reason,
    before: jsonOrNull(before),
    after: jsonOrNull(after),
  };
}

/** Prisma 已知写错误归一。P2002=unique 冲突（多为 slug 撞），P2003=FK，P2025=记录不存在。 */
function mapPrismaWriteError(err: unknown): SolutionMutationResult | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return { status: "invalid", fieldErrors: { slug: ["slug 已被占用（唯一约束）"] } };
    }
    if (err.code === "P2003") {
      return { status: "invalid", fieldErrors: { relation: ["引用的案例不存在"] } };
    }
    if (err.code === "P2025") {
      return { status: "not_found" };
    }
  }
  return null;
}

/**
 * 发布守卫：状态改为 PUBLISHED 时校验（宪法第 21 条）。
 * 返回非 null 即拒绝；返回 null 即通过。
 */
function publishGuard(s: {
  price: { toString(): string } | null;
  riskDomains: string[];
  needsProfessionalReview: boolean;
}): Record<string, string[]> | null {
  const errs: Record<string, string[]> = {};
  if (s.price === null) errs.price = ["发布前必须填写价格（购买闭环）"];
  if (s.riskDomains.length > 0 && !s.needsProfessionalReview) {
    errs.needsProfessionalReview = [
      `涉及 ${s.riskDomains.length} 个高风险领域（${s.riskDomains.join("、")}）时必须勾选"需要专业人工确认"（宪法第21条）`,
    ];
  }
  return Object.keys(errs).length > 0 ? errs : null;
}

/**
 * **只读**发布就绪预览（Phase 13 M6 审核队列用）：复用上面同一个 `publishGuard`，把按字段归类的
 * 原因摊平成一句句人类可读的「还差什么才能发布」。返回空数组即就绪。刻意与真实发布走**同一函数**，
 * 杜绝"队列说能发、点了却被拦"的口径漂移（宪法第 16 条单一真源）；不写库、不改状态。
 */
export function solutionPublishBlockers(s: {
  price: { toString(): string } | null;
  riskDomains: string[];
  needsProfessionalReview: boolean;
}): string[] {
  const guard = publishGuard(s);
  return guard ? Object.values(guard).flat().filter(Boolean) : [];
}

/* ─────────────────────────── create ─────────────────────────── */

/**
 * 新建方案（强制 status=DRAFT；发布走 update+publishGuard）。
 * 事务：写 Solution + ChangeLog(CREATE)。
 */
export async function createSolution(input: unknown, actor?: string): Promise<SolutionMutationResult> {
  const parsed = SolutionCreateSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", fieldErrors: toFieldErrors(parsed.error) };
  const d = parsed.data;

  // FK 预检：case 必须存在（P2003 也能兜底，但预检给出更清楚的 fieldErrors.caseId）
  const caseExists = await prisma.case.findUnique({ where: { id: d.caseId }, select: { id: true } });
  if (!caseExists) return { status: "invalid", fieldErrors: { caseId: ["引用的案例不存在"] } };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const s = await tx.solution.create({
        data: {
          title: d.title,
          slug: d.slug,
          caseId: d.caseId,
          titleEn: d.titleEn ?? null,
          summary: d.summary ?? null,
          body: d.body ? (d.body as object) : Prisma.DbNull,
          price: d.price !== undefined ? d.price : null,
          currency: d.currency ?? "CNY",
          riskDomains: d.riskDomains ?? [],
          needsProfessionalReview: d.needsProfessionalReview ?? false,
          status: "DRAFT", // 强制，不允许直建 PUBLISHED
        },
        select: { id: true, status: true, slug: true },
      });
      await tx.changeLog.create({
        data: changeLogArgs(s.id, "CREATE", actor, "创建方案（DRAFT）", null, {
          title: d.title,
          slug: s.slug,
          caseId: d.caseId,
          status: s.status,
        }),
      });
      return s;
    });
    log.info("solution created", { solutionId: created.id, slug: created.slug });
    return { status: "ok", solutionId: created.id };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return mapped;
    const message = err instanceof Error ? err.message : String(err);
    log.error("createSolution failed", { error: message });
    return { status: "error", error: message };
  }
}

/* ─────────────────────────── update ─────────────────────────── */

/**
 * 更新方案（version 自增；改到 status=PUBLISHED 时走 publishGuard 拒非法发布）。
 * publishedAt 只在从非 PUBLISHED 变到 PUBLISHED 时打时间戳（重复发布不刷新）。
 */
export async function updateSolution(
  solutionId: string,
  patch: unknown,
  actor?: string,
): Promise<SolutionMutationResult> {
  const idParsed = CuidSchema.safeParse(solutionId);
  if (!idParsed.success) return { status: "not_found", solutionId };
  const parsed = SolutionUpdateSchema.safeParse(patch);
  if (!parsed.success) {
    return { status: "invalid", solutionId, fieldErrors: toFieldErrors(parsed.error) };
  }
  const d = parsed.data;

  const existing = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: {
      id: true,
      status: true,
      price: true,
      riskDomains: true,
      needsProfessionalReview: true,
      slug: true,
      title: true,
    },
  });
  if (!existing) return { status: "not_found", solutionId };

  // 若要发布：合并 patch 与 existing 后走守卫（patch 可能同时改价格/riskDomains/review 标记）
  if (d.status === "PUBLISHED" && existing.status !== "PUBLISHED") {
    const merged = {
      price: d.price !== undefined ? d.price : existing.price,
      riskDomains: d.riskDomains ?? existing.riskDomains,
      needsProfessionalReview: d.needsProfessionalReview ?? existing.needsProfessionalReview,
    };
    const guard = publishGuard(merged);
    if (guard) {
      log.warn("publish blocked", { solutionId, guard });
      return { status: "blocked", solutionId, fieldErrors: guard };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.solution.update({
        where: { id: solutionId },
        data: {
          ...(d.title !== undefined && { title: d.title }),
          ...(d.slug !== undefined && { slug: d.slug }),
          ...(d.titleEn !== undefined && { titleEn: d.titleEn }),
          ...(d.summary !== undefined && { summary: d.summary }),
          ...(d.body !== undefined && { body: d.body as object }),
          ...(d.price !== undefined && { price: d.price }),
          ...(d.currency !== undefined && { currency: d.currency }),
          ...(d.riskDomains !== undefined && { riskDomains: d.riskDomains }),
          ...(d.needsProfessionalReview !== undefined && { needsProfessionalReview: d.needsProfessionalReview }),
          ...(d.status !== undefined && { status: d.status }),
          ...(d.status === "PUBLISHED" && existing.status !== "PUBLISHED" && { publishedAt: new Date() }),
          version: { increment: 1 },
        },
      });
      await tx.changeLog.create({
        data: changeLogArgs(
          solutionId,
          "UPDATE",
          actor,
          "更新方案字段",
          { status: existing.status, slug: existing.slug, title: existing.title },
          d,
        ),
      });
    });
    log.info("solution updated", { solutionId, toStatus: d.status ?? existing.status });
    return { status: "ok", solutionId };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, solutionId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("updateSolution failed", { error: message, solutionId });
    return { status: "error", solutionId, error: message };
  }
}

/* ─────────────────────────── delete（受守卫） ─────────────────────────── */

/**
 * 删除方案。安全守卫：任一 Order 关联 → blocked（V1 无退款/撤单流程，删除会孤儿订单）。
 * 事务：ChangeLog(DELETE) 快照 → 硬删方案（级联删 financials/unknowns 由 schema onDelete:Cascade 保证）。
 */
export async function deleteSolution(solutionId: string, actor?: string): Promise<SolutionMutationResult> {
  const idParsed = CuidSchema.safeParse(solutionId);
  if (!idParsed.success) return { status: "not_found", solutionId };

  const existing = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      _count: { select: { financials: true, unknowns: true, orders: true } },
    },
  });
  if (!existing) return { status: "not_found", solutionId };
  if (existing._count.orders > 0) {
    log.warn("deleteSolution blocked: has orders", { solutionId, orders: existing._count.orders });
    return {
      status: "blocked",
      solutionId,
      fieldErrors: { orders: [`仍有 ${existing._count.orders} 条订单，禁止删除（先走撤单/退款流程，属 ROADMAP #5 支付域）`] },
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.changeLog.create({
        data: changeLogArgs(
          solutionId,
          "DELETE",
          actor,
          "删除方案",
          {
            title: existing.title,
            slug: existing.slug,
            status: existing.status,
            financialCount: existing._count.financials,
            unknownCount: existing._count.unknowns,
          },
          null,
        ),
      });
      await tx.solution.delete({ where: { id: solutionId } });
    });
    log.info("solution deleted", { solutionId });
    return { status: "ok", solutionId };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, solutionId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("deleteSolution failed", { error: message, solutionId });
    return { status: "error", solutionId, error: message };
  }
}

/* ─────────────────────────── financial add / remove ─────────────────────────── */

/** 给方案追加一条财务测算（CAPEX/OPEX/ROI/IRR/回收期 等；假设与 calcRef 溯源）。 */
export async function addSolutionFinancial(
  solutionId: string,
  financial: unknown,
  actor?: string,
): Promise<SolutionMutationResult> {
  const idParsed = CuidSchema.safeParse(solutionId);
  if (!idParsed.success) return { status: "not_found", solutionId };
  const parsed = SolutionFinancialInputSchema.safeParse(financial);
  if (!parsed.success) {
    return { status: "invalid", solutionId, fieldErrors: toFieldErrors(parsed.error) };
  }
  const d = parsed.data;

  const exists = await prisma.solution.findUnique({ where: { id: solutionId }, select: { id: true } });
  if (!exists) return { status: "not_found", solutionId };

  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.solutionFinancial.create({
        data: {
          solutionId,
          capex: d.capex ?? null,
          opexAnnual: d.opexAnnual ?? null,
          revenueAnnual: d.revenueAnnual ?? null,
          roiPct: d.roiPct ?? null,
          irrPct: d.irrPct ?? null,
          paybackYears: d.paybackYears ?? null,
          currency: d.currency ?? "CNY",
          assumptions: d.assumptions ? (d.assumptions as object) : Prisma.DbNull,
          calcRef: d.calcRef ?? null,
          sourceUrl: d.sourceUrl ?? null,
          note: d.note ?? null,
        },
        select: { id: true },
      });
      await tx.changeLog.create({
        data: changeLogArgs(solutionId, "UPDATE", actor, "新增财务测算", null, { financial: d }),
      });
      return created;
    });
    log.info("solution financial added", { solutionId, financialId: row.id });
    return { status: "ok", solutionId, financialId: row.id };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, solutionId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("addSolutionFinancial failed", { error: message, solutionId });
    return { status: "error", solutionId, error: message };
  }
}

/** 删除一条财务测算（按 id，回查所属方案）。 */
export async function removeSolutionFinancial(
  financialId: string,
  actor?: string,
): Promise<SolutionMutationResult> {
  const idParsed = CuidSchema.safeParse(financialId);
  if (!idParsed.success) return { status: "not_found" };
  const row = await prisma.solutionFinancial.findUnique({
    where: { id: financialId },
    select: { id: true, solutionId: true, note: true, currency: true },
  });
  if (!row) return { status: "not_found" };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.changeLog.create({
        data: changeLogArgs(row.solutionId, "UPDATE", actor, "删除财务测算", { financial: row }, null),
      });
      await tx.solutionFinancial.delete({ where: { id: financialId } });
    });
    log.info("solution financial removed", { financialId, solutionId: row.solutionId });
    return { status: "ok", solutionId: row.solutionId };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return mapped;
    const message = err instanceof Error ? err.message : String(err);
    log.error("removeSolutionFinancial failed", { error: message, financialId });
    return { status: "error", error: message };
  }
}

/* ─────────────────────────── unknown add / remove ─────────────────────────── */

/**
 * 给方案追加一条关键未知变量（规则 6/9：不确定性显式列出），
 * 并**自动同步** Solution.unknownVariableCount = 表内实时条数（可计算事实）。
 */
export async function addSolutionUnknown(
  solutionId: string,
  unknown: unknown,
  actor?: string,
): Promise<SolutionMutationResult> {
  const idParsed = CuidSchema.safeParse(solutionId);
  if (!idParsed.success) return { status: "not_found", solutionId };
  const parsed = SolutionUnknownInputSchema.safeParse(unknown);
  if (!parsed.success) {
    return { status: "invalid", solutionId, fieldErrors: toFieldErrors(parsed.error) };
  }
  const d = parsed.data;

  const exists = await prisma.solution.findUnique({ where: { id: solutionId }, select: { id: true } });
  if (!exists) return { status: "not_found", solutionId };

  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.unknownVariable.create({
        data: {
          solutionId,
          name: d.name,
          impact: d.impact ?? null,
          howToResolve: d.howToResolve ?? null,
          severity: d.severity ?? null,
        },
        select: { id: true },
      });
      const count = await tx.unknownVariable.count({ where: { solutionId } });
      await tx.solution.update({ where: { id: solutionId }, data: { unknownVariableCount: count } });
      await tx.changeLog.create({
        data: changeLogArgs(solutionId, "UPDATE", actor, "新增关键未知变量", null, {
          unknown: d,
          unknownVariableCount: count,
        }),
      });
      return created;
    });
    log.info("solution unknown added", { solutionId, unknownId: row.id });
    return { status: "ok", solutionId, unknownId: row.id };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, solutionId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("addSolutionUnknown failed", { error: message, solutionId });
    return { status: "error", solutionId, error: message };
  }
}

/** 删除一条关键未知变量（按 id），自动回写 Solution.unknownVariableCount。 */
export async function removeSolutionUnknown(
  unknownId: string,
  actor?: string,
): Promise<SolutionMutationResult> {
  const idParsed = CuidSchema.safeParse(unknownId);
  if (!idParsed.success) return { status: "not_found" };
  const row = await prisma.unknownVariable.findUnique({
    where: { id: unknownId },
    select: { id: true, solutionId: true, name: true, severity: true },
  });
  if (!row) return { status: "not_found" };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.changeLog.create({
        data: changeLogArgs(row.solutionId, "UPDATE", actor, "删除关键未知变量", { unknown: row }, null),
      });
      await tx.unknownVariable.delete({ where: { id: unknownId } });
      const count = await tx.unknownVariable.count({ where: { solutionId: row.solutionId } });
      await tx.solution.update({ where: { id: row.solutionId }, data: { unknownVariableCount: count } });
    });
    log.info("solution unknown removed", { unknownId, solutionId: row.solutionId });
    return { status: "ok", solutionId: row.solutionId };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return mapped;
    const message = err instanceof Error ? err.message : String(err);
    log.error("removeSolutionUnknown failed", { error: message, unknownId });
    return { status: "error", error: message };
  }
}
