/**
 * 反馈数据层（Phase 4 Module C，server-only）。
 *
 * 职责：公开反馈表单的创建（可匿名）+ 后台的反馈列表与「标记已处理」。
 * 设计要点（对齐 schema.prisma Feedback 注释）：
 *   - 可匿名提交：登录则归因 userId（服务端会话注入，绝不接受客户端传入），未登录只留可选 email；
 *   - kind/status 存 String，server 层 zod 白名单约束（对齐 ModelCall/ProjectScenario 先例，不建 Prisma 枚举）；
 *   - 不做邮件通知/工单系统——后台人工阅读 + 标记 RESOLVED 即闭环（宪法：更简单、更少依赖）；
 *   - 结果判别联合不裸抛；email/message 全部有长度上限，防滥用刷库（无验证码是已知 P2，见完成报告）。
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { SessionUser } from "@/server/authz";

const log = logger.child({ module: "server/feedback" });

/** 反馈类型白名单。 */
export const FEEDBACK_KINDS = ["BUG", "SUGGESTION", "QUESTION", "OTHER"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** 反馈状态白名单（当前 OPEN | RESOLVED）。 */
export const FEEDBACK_STATUSES = ["OPEN", "RESOLVED"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** 反馈层版本（改输入契约/口径须升版记原因，规则 13）。 */
export const FEEDBACK_VERSION = "1.0.0";

/* ────────────────────────── 输入契约（Zod） ────────────────────────── */

export const createFeedbackSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  message: z.string().trim().min(5, "反馈内容至少 5 个字").max(2000, "反馈内容过长（≤2000 字）"),
  email: z
    .string()
    .trim()
    .max(200, "邮箱过长")
    .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "邮箱格式不正确")
    .optional()
    .transform((v) => (v ? v : undefined)),
  page: z.string().trim().max(500, "页面路径过长").optional(),
});
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;

export const listFeedbackSchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const resolveFeedbackSchema = z.object({
  status: z.literal("RESOLVED").optional().default("RESOLVED"),
});

/* ────────────────────────── 判别联合结果 ────────────────────────── */

export type FeedbackMutationResult =
  | { status: "ok"; id: string }
  | { status: "invalid"; error: string }
  | { status: "not_found"; error: string }
  | { status: "error"; error: string };

/* ────────────────────────── 创建（公开，可匿名） ────────────────────────── */

/**
 * 创建反馈。userId 来自服务端会话（可 null=匿名），绝不取自请求体。
 * page 记录提交来源路径（客户端表单附带，仅文本展示用，绝不做任何跳转/渲染 URL 语义）。
 */
export async function createFeedback(
  input: unknown,
  user: SessionUser | null,
): Promise<FeedbackMutationResult> {
  const parsed = createFeedbackSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid", error: parsed.error.issues[0]?.message ?? "入参校验未通过" };
  }
  const { kind, message, email, page } = parsed.data;
  try {
    const row = await prisma.feedback.create({
      data: {
        userId: user?.id ?? null,
        email: email ?? null,
        kind,
        message,
        page: page ?? null,
        status: "OPEN",
      },
      select: { id: true },
    });
    log.info("feedback created", {
      feedbackId: row.id,
      kind,
      authenticated: user !== null,
      page: page ?? null,
    });
    return { status: "ok", id: row.id };
  } catch (err) {
    log.error("createFeedback failed", { err });
    return { status: "error", error: "提交失败，请稍后重试" };
  }
}

/* ────────────────────────── 后台：列表 + 标记处理 ────────────────────────── */

export interface FeedbackAdminItem {
  id: string;
  kind: FeedbackKind;
  message: string;
  email: string | null;
  page: string | null;
  status: FeedbackStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  /** 提交者展示名（登录归因时取用户 email；匿名 → null）。 */
  userEmail: string | null;
}

/**
 * 后台反馈列表（createdAt 倒序，可按 status 过滤）。DB 失败 → { ok:false } 页面降级提示。
 */
export async function listFeedback(
  params: { status?: FeedbackStatus; limit?: number } = {},
): Promise<{ ok: true; items: FeedbackAdminItem[] } | { ok: false; items: [] }> {
  const status = params.status;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  try {
    const rows = await prisma.feedback.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { email: true } } },
    });
    const items: FeedbackAdminItem[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind as FeedbackKind,
      message: r.message,
      email: r.email,
      page: r.page,
      status: r.status as FeedbackStatus,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      userEmail: r.user?.email ?? null,
    }));
    return { ok: true, items };
  } catch (err) {
    log.error("listFeedback failed", { err });
    return { ok: false, items: [] };
  }
}

/** 标记反馈为已处理（幂等：已 RESOLVED 再标一次刷新 resolvedAt，无副作用语义变化）。 */
export async function resolveFeedback(id: string): Promise<FeedbackMutationResult> {
  if (!id || id.length > 100) {
    return { status: "invalid", error: "反馈 id 不合法" };
  }
  try {
    const existing = await prisma.feedback.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return { status: "not_found", error: "反馈不存在" };
    await prisma.feedback.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
      select: { id: true },
    });
    return { status: "ok", id };
  } catch (err) {
    log.error("resolveFeedback failed", { err, feedbackId: id });
    return { status: "error", error: "操作失败，请稍后重试" };
  }
}
