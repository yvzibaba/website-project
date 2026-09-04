import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma, type ChangeAction } from "@prisma/client";
import {
  CuidSchema,
  IndustrySchema,
  CaseStageSchema,
  EvidenceTypeSchema,
  EvidenceGradeSchema,
} from "@/lib/validation";
import { recomputeCaseScores, type RecomputeOneResult } from "@/server/case-scores";

/**
 * 案例与证据的**数据层 CRUD**（Phase 7 M5，server-only）。
 *
 * 为什么（ROADMAP Phase 7「案例系统」后续待做 = 案例 CRUD）：
 *   此前案例只能靠 `prisma/seed.ts` 批量灌 DEMO，运营/AI 流水线无法逐条撰写真实案例。
 *   本模块提供受校验的写入口（create/update/delete 案例 + add/remove 证据），
 *   并把每次改动写进 `ChangeLog`（宪法第 13 条版本化：可追溯谁在何时改了什么），
 *   凡影响评分的写入（scoreInput / 证据增删）自动调用 `recomputeCaseScores`（宪法第 7 条：程序复算）。
 *
 * 边界（诚实，宪法第 2/4/20 条）：
 *   - **本模块不做鉴权**——它信任调用方（未来的后台路由 / AI Agent）。对外的 HTTP 写路由
 *     与角色门禁（谁有权写案例）有意延后到 Phase 13（`/admin` + `UserRole` 鉴权中间件），
 *     此刻暴露无鉴权的公开写端点将违反 MVP 优先与安全底线。
 *   - `actor`（形如 `human:<userId>` / `ai:<model>`）仅作审计标注写入 ChangeLog.changedBy，
 *     **不代表已鉴权**；Phase 13 落地后由会话注入，调用方不得自行伪造。
 *   - 不删真实已发布商品：`deleteCase` 对**仍挂着 PUBLISHED 方案**的案例直接拒绝（blocked），
 *     避免把可购买的商品变成孤儿。
 *
 * 错误策略：一律判别联合返回（invalid/not_found/blocked/...），不向调用方抛裸异常。
 */

const log = logger.child({ module: "server/case-admin" });

/* ─────────────────────────── 入参 schema（复用 validation 枚举，单一真源） ─────────────────────────── */

/** 证据写入条目（创建案例时可内联，也可后续单独添加）。 */
export const CaseEvidenceInputSchema = z.object({
  type: EvidenceTypeSchema,
  statement: z.string().trim().min(1, "证据陈述不能为空").max(2000, "证据陈述过长"),
  grade: EvidenceGradeSchema.optional(),
  sourceUrl: z.string().trim().max(2000).optional(),
  sourceType: z.string().trim().max(100).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});
export type CaseEvidenceInput = z.infer<typeof CaseEvidenceInputSchema>;

/**
 * 新建案例入参。scoreInput 只做**结构**校验（整数对象），
 * 10 维度是否齐全/越界由评分内核在 recompute 时裁决（单一真源，避免两处口径漂移）。
 */
export const CaseCreateSchema = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(300, "标题过长"),
  industry: IndustrySchema,
  titleEn: z.string().trim().max(300).optional(),
  summary: z.string().trim().max(5000).optional(),
  summaryEn: z.string().trim().max(5000).optional(),
  sourceUrl: z.string().trim().max(2000).optional(),
  sourceType: z.string().trim().max(100).optional(),
  regionId: CuidSchema.optional(),
  businessModelId: CuidSchema.optional(),
  stage: CaseStageSchema.optional(), // 缺省走 schema 默认 CANDIDATE
  scoreInput: z.record(z.string(), z.number().int()).optional(),
  evidences: z.array(CaseEvidenceInputSchema).optional(),
});
export type CaseCreateInput = z.infer<typeof CaseCreateSchema>;

/** 更新案例入参：全部可选，但至少一个可改字段；version 由服务端自增。 */
export const CaseUpdateSchema = z
  .object({
    title: z.string().trim().min(1, "标题不能为空").max(300).optional(),
    titleEn: z.string().trim().max(300).optional(),
    summary: z.string().trim().max(5000).optional(),
    summaryEn: z.string().trim().max(5000).optional(),
    sourceUrl: z.string().trim().max(2000).optional(),
    sourceType: z.string().trim().max(100).optional(),
    industry: IndustrySchema.optional(),
    stage: CaseStageSchema.optional(),
    regionId: CuidSchema.nullable().optional(),
    businessModelId: CuidSchema.nullable().optional(),
    scoreInput: z.record(z.string(), z.number().int()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "没有需要更新的字段" });
export type CaseUpdateInput = z.infer<typeof CaseUpdateSchema>;

/* ─────────────────────────── 结果类型 ─────────────────────────── */

/** 复算状态（评分写入是"尽力而为"：非法输入不回滚案例写入，但如实回报）。 */
export type ScoreRecomputeStatus = "computed" | "skipped" | "invalid" | "none" | "error";

export interface CaseMutationResult {
  status: "ok" | "invalid" | "not_found" | "blocked" | "error";
  caseId?: string;
  /** 结构校验失败的字段消息、复算 issues，或删除守卫原因。 */
  fieldErrors?: Record<string, string[]>;
  /** 评分是否被联动复算及其结果。 */
  recompute?: ScoreRecomputeStatus;
  error?: string;
  evidenceId?: string;
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

function mapRecompute(r: RecomputeOneResult): ScoreRecomputeStatus {
  if (r.status === "computed" || r.status === "skipped" || r.status === "invalid" || r.status === "error") {
    return r.status;
  }
  return "none"; // not_found：案例无 scoreInput 前已被 recompute 判 skipped，这里保守回报 none
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
    entityType: "Case",
    entityId,
    action,
    changedBy: actor ?? null,
    reason,
    before: jsonOrNull(before),
    after: jsonOrNull(after),
  };
}

/** 把 Prisma 已知写错误归一为业务结果；非已知错误返回 null 交上层兜底。 */
function mapPrismaWriteError(err: unknown): CaseMutationResult | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2003") {
      return { status: "invalid", fieldErrors: { relation: ["引用的地区或商业模式不存在"] } };
    }
    if (err.code === "P2025") {
      return { status: "not_found" };
    }
  }
  return null;
}

/* ─────────────────────────── create ─────────────────────────── */

/**
 * 新建案例（可内联证据）。写库 + ChangeLog(CREATE) 在一个事务内；
 * 若提供 scoreInput，则提交后联动 recompute（读回证据→复算→写 breakdown/标量）。
 */
export async function createCase(input: unknown, actor?: string): Promise<CaseMutationResult> {
  const parsed = CaseCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid", fieldErrors: toFieldErrors(parsed.error) };
  }
  const d = parsed.data;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.case.create({
        data: {
          title: d.title,
          industry: d.industry,
          titleEn: d.titleEn ?? null,
          summary: d.summary ?? null,
          summaryEn: d.summaryEn ?? null,
          sourceUrl: d.sourceUrl ?? null,
          sourceType: d.sourceType ?? null,
          regionId: d.regionId ?? null,
          businessModelId: d.businessModelId ?? null,
          stage: d.stage ?? "CANDIDATE",
          scoreInput: d.scoreInput ? (d.scoreInput as unknown as object) : Prisma.DbNull,
          evidences: d.evidences?.length
            ? {
                create: d.evidences.map((ev) => ({
                  type: ev.type,
                  grade: ev.grade ?? null,
                  statement: ev.statement,
                  sourceUrl: ev.sourceUrl ?? null,
                  sourceType: ev.sourceType ?? null,
                  confidence: ev.confidence ?? null,
                })),
              }
            : undefined,
        },
        select: { id: true, stage: true, evidences: { select: { id: true } } },
      });
      await tx.changeLog.create({
        data: changeLogArgs(c.id, "CREATE", actor, "创建案例", null, {
          title: d.title,
          industry: d.industry,
          stage: c.stage,
          evidenceCount: c.evidences.length,
        }),
      });
      return c;
    });

    let recompute: ScoreRecomputeStatus = "none";
    if (d.scoreInput) {
      const r = await recomputeCaseScores(created.id);
      recompute = mapRecompute(r);
      if (r.status === "invalid") {
        log.warn("createCase: 案例已建但评分输入非法，未生成 breakdown", {
          caseId: created.id,
          issues: r.issues,
        });
      }
    }

    log.info("case created", { caseId: created.id, evidences: created.evidences.length, recompute });
    return { status: "ok", caseId: created.id, recompute };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return mapped;
    const message = err instanceof Error ? err.message : String(err);
    log.error("createCase failed", { error: message });
    return { status: "error", error: message };
  }
}

/* ─────────────────────────── update ─────────────────────────── */

/** 更新案例字段（version 自增）。改到 scoreInput 时联动 recompute。 */
export async function updateCase(
  caseId: string,
  patch: unknown,
  actor?: string,
): Promise<CaseMutationResult> {
  const idParsed = CuidSchema.safeParse(caseId);
  if (!idParsed.success) return { status: "not_found", caseId };
  const parsed = CaseUpdateSchema.safeParse(patch);
  if (!parsed.success) {
    return { status: "invalid", caseId, fieldErrors: toFieldErrors(parsed.error) };
  }
  const d = parsed.data;

  const existing = await prisma.case.findUnique({
    where: { id: caseId },
    select: { id: true, title: true, industry: true, stage: true },
  });
  if (!existing) return { status: "not_found", caseId };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.case.update({
        where: { id: caseId },
        data: {
          ...d,
          scoreInput: d.scoreInput ? (d.scoreInput as unknown as object) : undefined,
          version: { increment: 1 },
        },
      });
      await tx.changeLog.create({
        data: changeLogArgs(
          caseId,
          "UPDATE",
          actor,
          "更新案例字段",
          { title: existing.title, industry: existing.industry, stage: existing.stage },
          d,
        ),
      });
    });

    let recompute: ScoreRecomputeStatus = "none";
    if (d.scoreInput) {
      recompute = mapRecompute(await recomputeCaseScores(caseId));
    }
    log.info("case updated", { caseId, recompute });
    return { status: "ok", caseId, recompute };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, caseId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("updateCase failed", { error: message, caseId });
    return { status: "error", caseId, error: message };
  }
}

/* ─────────────────────────── delete（受守卫） ─────────────────────────── */

/**
 * 删除案例（级联删证据/能力关联/本土化）。安全守卫：仍挂 PUBLISHED 方案 → 拒绝（blocked），
 * 以免把可购买商品变成孤儿。删除前快照进 ChangeLog（DELETE）。
 */
export async function deleteCase(caseId: string, actor?: string): Promise<CaseMutationResult> {
  const idParsed = CuidSchema.safeParse(caseId);
  if (!idParsed.success) return { status: "not_found", caseId };

  const existing = await prisma.case.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      title: true,
      industry: true,
      stage: true,
      sourceType: true,
      _count: { select: { evidences: true, capabilities: true } },
      solutions: { where: { status: "PUBLISHED" }, select: { id: true } },
    },
  });
  if (!existing) return { status: "not_found", caseId };
  if (existing.solutions.length > 0) {
    log.warn("deleteCase blocked: case still has published solutions", {
      caseId,
      published: existing.solutions.length,
    });
    return {
      status: "blocked",
      caseId,
      fieldErrors: { solutions: [`仍有 ${existing.solutions.length} 个已发布方案，禁止删除（先下架/撤审）`] },
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.changeLog.create({
        data: changeLogArgs(
          caseId,
          "DELETE",
          actor,
          "删除案例",
          {
            title: existing.title,
            industry: existing.industry,
            stage: existing.stage,
            sourceType: existing.sourceType,
            evidenceCount: existing._count.evidences,
            capabilityCount: existing._count.capabilities,
          },
          null,
        ),
      });
      await tx.case.delete({ where: { id: caseId } });
    });
    log.info("case deleted", { caseId });
    return { status: "ok", caseId };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, caseId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("deleteCase failed", { error: message, caseId });
    return { status: "error", caseId, error: message };
  }
}

/* ─────────────────────────── evidence add / remove ─────────────────────────── */

/** 给已有案例追加一条证据，并联动复算（可信度可能变化）。 */
export async function addCaseEvidence(
  caseId: string,
  evidence: unknown,
  actor?: string,
): Promise<CaseMutationResult> {
  const idParsed = CuidSchema.safeParse(caseId);
  if (!idParsed.success) return { status: "not_found", caseId };
  const parsed = CaseEvidenceInputSchema.safeParse(evidence);
  if (!parsed.success) {
    return { status: "invalid", caseId, fieldErrors: toFieldErrors(parsed.error) };
  }
  const d = parsed.data;

  const caseExists = await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } });
  if (!caseExists) return { status: "not_found", caseId };

  try {
    const ev = await prisma.$transaction(async (tx) => {
      const created = await tx.evidence.create({
        data: {
          caseId,
          type: d.type,
          grade: d.grade ?? null,
          statement: d.statement,
          sourceUrl: d.sourceUrl ?? null,
          sourceType: d.sourceType ?? null,
          confidence: d.confidence ?? null,
        },
        select: { id: true },
      });
      await tx.changeLog.create({
        data: changeLogArgs(caseId, "UPDATE", actor, "新增证据", null, { evidence: d }),
      });
      return created;
    });

    const recompute = mapRecompute(await recomputeCaseScores(caseId));
    log.info("evidence added", { caseId, evidenceId: ev.id, recompute });
    return { status: "ok", caseId, recompute, evidenceId: ev.id };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, caseId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("addCaseEvidence failed", { error: message, caseId });
    return { status: "error", caseId, error: message };
  }
}

/** 删除一条证据（按证据 id），回查其所属案例并联动复算。 */
export async function removeCaseEvidence(
  evidenceId: string,
  actor?: string,
): Promise<CaseMutationResult> {
  const idParsed = CuidSchema.safeParse(evidenceId);
  if (!idParsed.success) return { status: "not_found" };

  const ev = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, caseId: true, type: true, statement: true, confidence: true, grade: true },
  });
  if (!ev) return { status: "not_found" };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.changeLog.create({
        data: changeLogArgs(ev.caseId, "UPDATE", actor, "删除证据", { evidence: ev }, null),
      });
      await tx.evidence.delete({ where: { id: evidenceId } });
    });

    const recompute = mapRecompute(await recomputeCaseScores(ev.caseId));
    log.info("evidence removed", { evidenceId, caseId: ev.caseId, recompute });
    return { status: "ok", caseId: ev.caseId, recompute };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, caseId: ev.caseId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("removeCaseEvidence failed", { error: message, evidenceId });
    return { status: "error", evidenceId, error: message };
  }
}
