/**
 * 留资（RFQ）数据层（V1.1 P4 · 商业闭环最小可用形态，server-only）。
 *
 * 职责：把「企业报价意向 / 咨询」的公开表单落成一条 `Lead` 行，供后台人工跟进。
 * 设计要点（对齐 schema.prisma Lead 注释 + 反馈先例）：
 *   - 可游客提交：登录则归因 userId（服务端会话注入，绝不接受客户端传入），游客靠自填 email 认领；
 *   - source/projectStage/budgetRange/status 全部走**白名单**（同 Feedback/ModelCall 先例，不建 Prisma 枚举）；
 *   - 字段长度全部硬上限（防滥用刷库）；
 *   - **不做 CRM/邮件/工单/通知**（宪法：更少依赖），1 个工作日内联系是**流程承诺**、非系统能力，
 *     UI 与后台需如实表述；
 *   - **频控不在本层**：留给路由（可读客户端 IP/UA；进程内存级、单实例、非分布式，见路由注释）。
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { SessionUser } from "@/server/authz";

const log = logger.child({ module: "server/leads" });

/** 落位来源白名单：企业页 / 报告尾 / 定价位（与 P4 方案 §3.4 三处表单一一对应）。 */
export const LEAD_SOURCES = ["enterprise", "report", "pricing"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** 项目阶段白名单（对应国内新能源项目的常见推进阶段）。 */
export const LEAD_PROJECT_STAGES = ["规划", "在建", "运营", "其他"] as const;
export type LeadProjectStage = (typeof LEAD_PROJECT_STAGES)[number];

/** 预算档位白名单（**区间档位**、非自由金额，避免留资侧误读为承诺报价）。 */
export const LEAD_BUDGET_RANGES = [
  "50万以内",
  "50-200万",
  "200-1000万",
  "1000-5000万",
  "5000万以上",
  "暂不清楚",
] as const;
export type LeadBudgetRange = (typeof LEAD_BUDGET_RANGES)[number];

/** 后台跟进状态白名单。 */
export const LEAD_STATUSES = ["NEW", "CONTACTED", "CLOSED"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** 留资层版本（改输入契约/口径须升版记原因，规则 13）。 */
export const LEADS_VERSION = "1.0.0";

/* ────────────────────────── 输入契约（Zod） ────────────────────────── */

const emailSchema = z
  .string()
  .trim()
  .min(3, "请填写联系邮箱")
  .max(200, "邮箱过长")
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "邮箱格式不正确");

export const createLeadSchema = z.object({
  company: z.string().trim().min(2, "请填写公司名称").max(200, "公司名称过长"),
  contactName: z.string().trim().min(1, "请填写联系人姓名").max(100, "联系人姓名过长"),
  role: z.string().trim().max(100, "职务过长").optional().or(z.literal("")),
  email: emailSchema,
  phone: z.string().trim().max(50, "电话过长").optional().or(z.literal("")),
  projectStage: z.enum(LEAD_PROJECT_STAGES).optional(),
  budgetRange: z.enum(LEAD_BUDGET_RANGES).optional(),
  message: z.string().trim().max(2000, "补充说明过长（≤2000 字）").optional().or(z.literal("")),
  source: z.enum(LEAD_SOURCES),
  page: z.string().trim().max(500, "页面路径过长").optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/* ────────────────────────── 判别联合结果 ────────────────────────── */

export type LeadMutationResult =
  | { status: "ok"; id: string }
  | { status: "invalid"; error: string; fieldErrors?: Record<string, string[]> }
  | { status: "not_found"; error: string }
  | { status: "error"; error: string };

/* ────────────────────────── 创建（公开，可匿名） ────────────────────────── */

function flattenFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * 创建留资。userId 来自服务端会话（登录则记，游客则空），绝不取自请求体。
 * page 记录提交时所在路径（客户端表单附带，仅作文本展示，不做跳转/渲染 URL 语义）。
 */
export async function createLead(
  input: unknown,
  user: SessionUser | null,
): Promise<LeadMutationResult> {
  const parsed = createLeadSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      error: parsed.error.issues[0]?.message ?? "入参校验未通过",
      fieldErrors: flattenFieldErrors(parsed.error),
    };
  }
  const d = parsed.data;
  try {
    const row = await prisma.lead.create({
      data: {
        userId: user?.id ?? null,
        company: d.company,
        contactName: d.contactName,
        role: d.role?.trim() ? d.role.trim() : null,
        email: d.email,
        phone: d.phone?.trim() ? d.phone.trim() : null,
        projectStage: d.projectStage ?? null,
        budgetRange: d.budgetRange ?? null,
        message: d.message?.trim() ? d.message.trim() : null,
        source: d.source,
        page: d.page ?? null,
        status: "NEW",
      },
      select: { id: true },
    });
    log.info("lead created", {
      leadId: row.id,
      source: d.source,
      authenticated: user !== null,
      page: d.page ?? null,
    });
    return { status: "ok", id: row.id };
  } catch (err) {
    log.error("createLead failed", { err });
    return { status: "error", error: "提交失败，请稍后重试" };
  }
}

/* ────────────────────────── 后台：列表 + 标记跟进状态 ────────────────────────── */

export interface LeadAdminItem {
  id: string;
  company: string;
  contactName: string;
  role: string | null;
  email: string;
  phone: string | null;
  projectStage: string | null;
  budgetRange: string | null;
  message: string | null;
  source: string;
  page: string | null;
  status: string;
  createdAt: Date;
  /** 若登录提交，附用户邮箱；游客留资 → null。 */
  submitterUserEmail: string | null;
}

/** 后台留资列表（createdAt 倒序，可按 status 过滤）。DB 失败 → { ok:false } 页面降级提示。 */
export async function listLeads(
  params: { status?: LeadStatus; limit?: number } = {},
): Promise<{ ok: true; items: LeadAdminItem[] } | { ok: false; items: [] }> {
  const status = params.status;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  try {
    const rows = await prisma.lead.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { email: true } } },
    });
    const items: LeadAdminItem[] = rows.map((r) => ({
      id: r.id,
      company: r.company,
      contactName: r.contactName,
      role: r.role,
      email: r.email,
      phone: r.phone,
      projectStage: r.projectStage,
      budgetRange: r.budgetRange,
      message: r.message,
      source: r.source,
      page: r.page,
      status: r.status,
      createdAt: r.createdAt,
      submitterUserEmail: r.user?.email ?? null,
    }));
    return { ok: true, items };
  } catch (err) {
    log.error("listLeads failed", { err });
    return { ok: false, items: [] };
  }
}

/** 后台标记留资状态（幂等：同状态重复标记仅刷 updatedAt，不引入歧义）。 */
export async function updateLeadStatus(id: string, status: LeadStatus): Promise<LeadMutationResult> {
  if (!id || id.length > 100) return { status: "invalid", error: "留资 id 不合法" };
  if (!LEAD_STATUSES.includes(status)) return { status: "invalid", error: "未知的留资状态" };
  try {
    const existing = await prisma.lead.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return { status: "not_found", error: "留资不存在" };
    await prisma.lead.update({ where: { id }, data: { status }, select: { id: true } });
    return { status: "ok", id };
  } catch (err) {
    log.error("updateLeadStatus failed", { err, leadId: id });
    return { status: "error", error: "操作失败，请稍后重试" };
  }
}
