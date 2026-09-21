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
  pipelineRowFields,
  type LeadPipeline,
  type LeadPipelineRow,
  type PipelineEvidence,
  type PipelineSolutionStatus,
  type PipelineOrderStatus,
} from "@/server/lead-pipeline-model";

const log = logger.child({ module: "server/lead-pipeline" });

/** 版本（改聚合口径须升版记原因，规则 13）。 */
export const LEAD_PIPELINE_VERSION = "1.1.0"; // 1.0.0（R7-D）：首版按留资投影只读漏斗。1.1.0（mandate §五）：additive 集合式批量读 getLeadPipelineRows + CSV 序列化（决策真源仍同一 deriveLeadPipeline，语义零变）。

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

/* ═════════════════════════ 批量视图：跨多条留资的集合式漏斗（mandate §五 · 零新表 · 只读） ═════════════════════════ */

/**
 * 集合式批量读：把 `listLeads` 那批留资一次性投影成扁平漏斗行（供 `/admin/leads` 批量表 + CSV 导出）。
 *
 * 为什么不是"再套一层 `getLeadPipeline` 循环"（N× 查询、跨太平洋必超时）：本函数用**分组查询**
 *   把 identity / project / scenario / solution / order 各一次 `findMany(in)` 拉全，再在内存里按客户归堆。
 * 但**决策真源仍是同一个 `deriveLeadPipeline` 纯函数**——批量与单条共享唯一的"段是否到达 / 下一步"逻辑，
 *   因此两套读法不会给出互相矛盾的漏斗位置（只有**取数形状**不同，**语义**同源，无第二套状态机）。
 *
 * 刻意与 `getLeadPipeline` **同口径**的三处判定（防漂移）：
 *   ① 身份优先 `lead.userId` 命中 User，否则按 `email` 不敏感匹配；② `computedScenarioCount` =
 *   `calcStatus==="ok"` 且 `report` 非空对象的情景；③ 订单命中 = 归属 `userId` 或 `buyerEmail`(小写) 相等。
 *
 * 只读、不改任何状态、不推进流程；上限 `limit`（默认 200，硬钳到 [1,200]）。DB 异常 → `{ok:false,error}`。
 */
export type LeadPipelineRowsResult =
  | { ok: true; rows: LeadPipelineRow[] }
  | { ok: false; error: string };

// 分组查询的内存硬闸（留资 ≤200，正常远达不到；纯防御，防脏库把导出打爆）。
const PROJECT_CAP = 5000;
const SCENARIO_CAP = 20000;
const SOLUTION_CAP = 5000;
const ORDER_CAP = 20000;

function nonEmptyJson(v: unknown): boolean {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0;
}

export async function getLeadPipelineRows(
  params: { status?: string; limit?: number } = {},
): Promise<LeadPipelineRowsResult> {
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 200);
  const status =
    params.status && ["NEW", "CONTACTED", "CLOSED"].includes(params.status) ? params.status : undefined;

  try {
    const leads = await prisma.lead.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, company: true, email: true, userId: true, createdAt: true, updatedAt: true },
    });
    if (leads.length === 0) return { ok: true, rows: [] };

    // ① 身份解析（与单条同口径：userId 优先，否则邮箱不敏感匹配）。
    const userIds = [...new Set(leads.map((l) => l.userId).filter((u): u is string => Boolean(u)))];
    const emails = [...new Set(leads.map((l) => l.email))];

    const [usersById, usersByEmail] = await Promise.all([
      userIds.length
        ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
        : Promise.resolve([] as { id: string; email: string }[]),
      emails.length
        ? prisma.user.findMany({
            where: { OR: emails.map((e) => ({ email: { equals: e, mode: "insensitive" as const } })) },
            select: { id: true, email: true },
          })
        : Promise.resolve([] as { id: string; email: string }[]),
    ]);
    const byId = new Map(usersById.map((u) => [u.id, u]));
    const byEmailLower = new Map<string, { id: string; email: string }>();
    for (const u of usersByEmail) {
      const k = u.email.toLowerCase();
      if (!byEmailLower.has(k)) byEmailLower.set(k, u);
    }

    interface Resolved {
      uid: string | null;
      ownerEmail: string;
      emailLower: string;
    }
    const resolvedByLead = new Map<string, Resolved>();
    for (const l of leads) {
      const emailLower = l.email.toLowerCase();
      let uid: string | null = null;
      if (l.userId && byId.has(l.userId)) uid = l.userId;
      if (!uid) uid = byEmailLower.get(emailLower)?.id ?? null;
      const ownerEmail =
        (uid && byId.get(uid)?.email) || (uid && byEmailLower.get(emailLower)?.email) || "";
      resolvedByLead.set(l.id, { uid, ownerEmail, emailLower });
    }

    const allUids = [...new Set([...resolvedByLead.values()].map((r) => r.uid).filter((u): u is string => Boolean(u)))];
    const allEmailsLower = [...new Set([...resolvedByLead.values()].map((r) => r.emailLower))];

    // ② 项目（分组：owner → 数量 + 最近名）+ 其 projectId 集。
    const projects = allUids.length
      ? await prisma.project.findMany({
          where: { ownerId: { in: allUids } },
          orderBy: { updatedAt: "desc" },
          take: PROJECT_CAP,
          select: { id: true, name: true, ownerId: true, updatedAt: true },
        })
      : [];
    const projByOwner = new Map<string, { count: number; latest: string; ids: string[] }>();
    for (const p of projects) {
      if (!p.ownerId) continue;
      const slot = projByOwner.get(p.ownerId) ?? { count: 0, latest: "", ids: [] };
      slot.count += 1;
      if (!slot.latest) slot.latest = p.name; // 已按 updatedAt desc，首见即最近
      slot.ids.push(p.id);
      projByOwner.set(p.ownerId, slot);
    }
    const projectIds = projects.map((p) => p.id);

    // ③ 算通出报告的情景（calcStatus ok 且 report 非空）按 project 归堆 → 折算到 owner。
    const computedScen = projectIds.length
      ? await prisma.projectScenario.findMany({
          where: { projectId: { in: projectIds }, calcStatus: "ok" },
          take: SCENARIO_CAP,
          select: { projectId: true, report: true },
        })
      : [];
    const projToOwner = new Map(projects.map((p) => [p.id, p.ownerId ?? ""]));
    const computedByOwner = new Map<string, number>();
    for (const s of computedScen) {
      if (!nonEmptyJson(s.report)) continue;
      const owner = projToOwner.get(s.projectId);
      if (!owner) continue;
      computedByOwner.set(owner, (computedByOwner.get(owner) ?? 0) + 1);
    }

    // ④ 方案（creator → 数量 + 状态多重集）。
    const sols = allUids.length
      ? await prisma.solution.findMany({
          where: { creatorId: { in: allUids } },
          take: SOLUTION_CAP,
          select: { creatorId: true, status: true },
        })
      : [];
    const solByOwner = new Map<string, { count: number; statuses: PipelineSolutionStatus[] }>();
    for (const s of sols) {
      if (!s.creatorId) continue;
      const slot = solByOwner.get(s.creatorId) ?? { count: 0, statuses: [] };
      slot.count += 1;
      slot.statuses.push((SOLUTION_STATUSES.has(s.status) ? s.status : "DRAFT") as PipelineSolutionStatus);
      solByOwner.set(s.creatorId, slot);
    }

    // ⑤ 订单（userId 命中 或 buyerEmail(小写) 命中）。
    const orders =
      allUids.length || allEmailsLower.length
        ? await prisma.order.findMany({
            where: {
              OR: [
                ...(allUids.length ? [{ userId: { in: allUids } }] : []),
                ...(allEmailsLower.length ? [{ buyerEmail: { in: allEmailsLower } }] : []),
              ],
            },
            take: ORDER_CAP,
            select: { userId: true, buyerEmail: true, status: true },
          })
        : [];

    const rows: LeadPipelineRow[] = leads.map((l) => {
      const r = resolvedByLead.get(l.id)!;
      const proj = r.uid ? projByOwner.get(r.uid) : undefined;
      const sol = r.uid ? solByOwner.get(r.uid) : undefined;
      const orderStatuses: PipelineOrderStatus[] = [];
      for (const o of orders) {
        const byUser = r.uid && o.userId === r.uid;
        const byEmail = o.buyerEmail && o.buyerEmail.toLowerCase() === r.emailLower;
        if (byUser || byEmail) {
          orderStatuses.push((ORDER_STATUSES.has(o.status) ? o.status : "PENDING") as PipelineOrderStatus);
        }
      }
      const evidence: PipelineEvidence = {
        hasLead: true,
        projectCount: proj?.count ?? 0,
        computedScenarioCount: r.uid ? computedByOwner.get(r.uid) ?? 0 : 0,
        solutionCount: sol?.count ?? 0,
        solutionStatuses: sol?.statuses ?? [],
        orderStatuses,
      };
      const pipeline = deriveLeadPipeline(evidence);
      const f = pipelineRowFields(pipeline);
      return {
        leadId: l.id,
        identityResolved: r.uid !== null,
        company: l.company,
        project: proj?.latest ?? "",
        currentStage: f.currentStage,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        ownerReviewer: r.ownerEmail,
        nextAction: f.nextAction,
        blockers: f.blockers,
      };
    });

    return { ok: true, rows };
  } catch (err) {
    log.error("getLeadPipelineRows failed", { err });
    return { ok: false, error: "留资漏斗批量视图加载失败，请稍后重试" };
  }
}

