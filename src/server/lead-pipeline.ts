/**
 * R7-D · 企业项目工作流「按留资聚合」服务端层（server-only · 只读 · 零新表零迁移）。
 *
 * ## 职责
 * 给定一条 Lead，解析其**客户身份**（优先 lead.userId；否则按邮箱匹配已注册 User），
 * 再用**既有**外键 / 归属关系把散落在各表的记录聚成一屏：该客户的**项目** → 项目下**算通出报告
 * 的情景** → 其**导出的方案** → 其**订单**，交给纯函数 `deriveLeadPipeline` 派生成推进位置。
 *
 * ## 为什么"派生而非新建"（宪法：能派生就不新增表、更少依赖）
 * Lead/Project/ProjectScenario/Solution/Order 五张表**早已存在**且各有归属指针：
 *   · Project.ownerId → User · ProjectScenario.project → Project
 *   · Solution.creatorId → User（R7-A 导出时服务端注入）
 *   · Order.userId → User / Order.buyerEmail（游客单靠邮箱）
 * 因此把一条留资投影成"这单做到哪一步"是**读侧组合查询**，不需要任何新列 / 新表 / 状态机。
 *
 * ## 诚实边界
 *   · 游客留资且其邮箱未注册 → 只能按邮箱匹配到 Order.buyerEmail；无 User 则项目/方案无从关联，
 *     派生会如实停在能确证的最浅段（绝不臆造关联）。
 *   · 本层**只读**：不改任何状态、不推进流程。真实报价 / 收款 / 交付仍人工（创始人域）。
 *   · 鉴权**不在本层**：调用方须为已过 `requireRole(STAFF_ROLES)` 的后台页 / 路由（隐私数据）。
 */
import { prisma } from "@app/kernel/lib/prisma";
import { logger } from "@app/kernel/lib/logger";
import {
  deriveLeadPipeline,
  type LeadPipeline,
  type PipelineEvidence,
  type PipelineSolutionStatus,
  type PipelineOrderStatus,
} from "@/server/lead-pipeline-model";

const log = logger.child({ module: "server/lead-pipeline" });

/** 版本（改聚合口径须升版记原因，规则 13）。 */
export const LEAD_PIPELINE_VERSION = "1.0.0"; // 1.0.0（R7-D）：首版，按留资投影 Lead→…→Delivery 只读漏斗。

/** 展示用的精简行（只带运营要看的字段，绝不外泄多余隐私）。 */
export interface PipelineProjectRow {
  id: string;
  name: string;
  status: string;
  scenarioCount: number;
  computedCount: number;
  updatedAt: Date;
}
export interface PipelineSolutionRow {
  id: string;
  title: string;
  status: PipelineSolutionStatus;
  price: string | null;
  currency: string;
  publishedAt: Date | null;
  updatedAt: Date;
}
export interface PipelineOrderRow {
  id: string;
  solutionId: string;
  status: PipelineOrderStatus;
  amount: string;
  currency: string;
  paidAt: Date | null;
  createdAt: Date;
}

export interface LeadPipelineView {
  lead: {
    id: string;
    company: string;
    contactName: string;
    role: string | null;
    email: string;
    phone: string | null;
    needType: string | null;
    budgetRange: string | null;
    projectRegion: string | null;
    fleetSize: string | null;
    status: string;
    source: string;
    createdAt: Date;
  };
  /** 身份是否被确证为已注册用户（false = 游客/邮箱未注册，关联可能不全，UI 须如实提示）。 */
  identityResolved: boolean;
  matchedUserId: string | null;
  evidence: PipelineEvidence;
  pipeline: LeadPipeline;
  projects: PipelineProjectRow[];
  solutions: PipelineSolutionRow[];
  orders: PipelineOrderRow[];
}

export type LeadPipelineResult =
  | { ok: true; notFound?: false; data: LeadPipelineView }
  | { ok: false; notFound: true }
  | { ok: false; error: string };

const SOLUTION_STATUSES = new Set<string>(["DRAFT", "UNDER_HUMAN_REVIEW", "PUBLISHED"]);
const ORDER_STATUSES = new Set<string>(["PENDING", "PAID", "REFUNDED", "CANCELED"]);

/** Decimal → 两位定点串（与项目既有金额展示口径一致；null 透传 null）。 */
function money(v: { toFixed(dp: number): string } | null | undefined): string | null {
  if (v == null) return null;
  try {
    return v.toFixed(2);
  } catch {
    return null;
  }
}

/**
 * 读取并按留资聚合出推进视图。id 非合法形状 → notFound（不泄露"格式错"差异）；DB 异常 → error。
 */
export async function getLeadPipeline(leadId: string): Promise<LeadPipelineResult> {
  if (!leadId || !/^[a-z0-9]{10,}$/i.test(leadId)) return { ok: false, notFound: true };

  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        company: true,
        contactName: true,
        role: true,
        email: true,
        phone: true,
        needType: true,
        budgetRange: true,
        projectRegion: true,
        fleetSize: true,
        status: true,
        source: true,
        createdAt: true,
        userId: true,
      },
    });
    if (!lead) return { ok: false, notFound: true };

    // ① 解析客户身份：优先归因 userId；否则按邮箱不敏感匹配已注册 User。
    let user: { id: string } | null = null;
    if (lead.userId) {
      user = await prisma.user.findUnique({ where: { id: lead.userId }, select: { id: true } });
    }
    if (!user) {
      user = await prisma.user.findFirst({
        where: { email: { equals: lead.email, mode: "insensitive" } },
        select: { id: true },
      });
    }
    const userId = user?.id ?? null;
    const emailLower = lead.email.toLowerCase();

    // ② 关联项目 + 每项目"算通出报告"的情景计数（无 User 则无从关联，如实空）。
    let projects: PipelineProjectRow[] = [];
    let computedScenarioCount = 0;
    if (userId) {
      const projRows = await prisma.project.findMany({
        where: { ownerId: userId },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, name: true, status: true, updatedAt: true },
      });
      const projIds = projRows.map((p) => p.id);
      const scen = projIds.length
        ? await prisma.projectScenario.groupBy({
            by: ["projectId"],
            where: { projectId: { in: projIds } },
            _count: { _all: true },
          })
        : [];
      const computed = projIds.length
        ? await prisma.projectScenario.findMany({
            where: { projectId: { in: projIds }, calcStatus: "ok" },
            select: { projectId: true, report: true },
          })
        : [];
      // 逐项目：总情景数 + 算通有报告数
      const totalByProject = new Map(scen.map((g) => [g.projectId, g._count._all]));
      const computedByProject = new Map<string, number>();
      for (const s of computed) {
        if (s.report != null && Object.keys(s.report as object).length > 0) {
          computedByProject.set(s.projectId, (computedByProject.get(s.projectId) ?? 0) + 1);
          computedScenarioCount += 1;
        }
      }
      projects = projRows.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        scenarioCount: totalByProject.get(p.id) ?? 0,
        computedCount: computedByProject.get(p.id) ?? 0,
        updatedAt: p.updatedAt,
      }));
    }

    // ③ 关联方案（creatorId=用户）+ 状态多重集。
    let solutions: PipelineSolutionRow[] = [];
    if (userId) {
      const sRows = await prisma.solution.findMany({
        where: { creatorId: userId },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          title: true,
          status: true,
          price: true,
          currency: true,
          publishedAt: true,
          updatedAt: true,
        },
      });
      solutions = sRows.map((s) => ({
        id: s.id,
        title: s.title,
        status: (SOLUTION_STATUSES.has(s.status) ? s.status : "DRAFT") as PipelineSolutionStatus,
        price: money(s.price),
        currency: s.currency,
        publishedAt: s.publishedAt,
        updatedAt: s.updatedAt,
      }));
    }

    // ④ 关联订单（userId=用户 或 游客 buyerEmail 命中），按用户优先、再并入邮箱命中。
    const oRows = await prisma.order.findMany({
      where: {
        OR: [
          ...(userId ? [{ userId }] : []),
          { buyerEmail: emailLower },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        solutionId: true,
        status: true,
        amount: true,
        currency: true,
        paidAt: true,
        createdAt: true,
      },
    });
    const orders: PipelineOrderRow[] = oRows.map((o) => ({
      id: o.id,
      solutionId: o.solutionId,
      status: (ORDER_STATUSES.has(o.status) ? o.status : "PENDING") as PipelineOrderStatus,
      amount: money(o.amount) ?? "0.00",
      currency: o.currency,
      paidAt: o.paidAt,
      createdAt: o.createdAt,
    }));

    const evidence: PipelineEvidence = {
      hasLead: true,
      projectCount: projects.length,
      computedScenarioCount,
      solutionCount: solutions.length,
      solutionStatuses: solutions.map((s) => s.status),
      orderStatuses: orders.map((o) => o.status),
    };
    const pipeline = deriveLeadPipeline(evidence);

    return {
      ok: true,
      data: {
        lead: {
          id: lead.id,
          company: lead.company,
          contactName: lead.contactName,
          role: lead.role,
          email: lead.email,
          phone: lead.phone,
          needType: lead.needType,
          budgetRange: lead.budgetRange,
          projectRegion: lead.projectRegion,
          fleetSize: lead.fleetSize,
          status: lead.status,
          source: lead.source,
          createdAt: lead.createdAt,
        },
        identityResolved: userId !== null,
        matchedUserId: userId,
        evidence,
        pipeline,
        projects,
        solutions,
        orders,
      },
    };
  } catch (err) {
    log.error("getLeadPipeline failed", { err, leadId });
    return { ok: false, error: "工作流视图加载失败，请稍后重试" };
  }
}
