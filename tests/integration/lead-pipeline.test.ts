import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@app/kernel/lib/prisma";
import { registerUser } from "@/server/users";
import { createLead } from "@/server/leads";
import { getLeadPipeline } from "@/server/lead-pipeline";

/**
 * R7-D · 企业项目工作流「按留资聚合」端到端（真连 Neon，不 mock）。
 *
 * 纯函数 `deriveLeadPipeline` 的判定已由 node 单测穷举钉死；本文件只证**服务端聚合层**在真库上：
 *   ① 已注册客户：留资→（按 userId/邮箱解析身份）→ 项目 / 算通出报告情景 / 已发布方案 / 已支付订单
 *      被完整聚成证据，派生一路到 DELIVERY；
 *   ② 游客留资（邮箱未注册）：identityResolved=false、项目/方案无从关联（如实空），但订单仍按
 *      buyerEmail 命中 → 漏斗诚实停在能确证的最浅段（不臆造关联）；
 *   ③ 垃圾 id → notFound（不泄露格式错差异）。
 * 一次性 runId 前缀 + afterAll 按外键序清理，绝不污染真库、不留孤儿行。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[lead-pipeline] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-lp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let slugSeq = 0;
const slugFor = (label: string) => `${label}-${runId.slice(-8)}-${slugSeq++}`.toLowerCase();

const created = {
  leadIds: [] as string[],
  orderIds: [] as string[],
  solutionIds: [] as string[],
  projectIds: [] as string[],
  caseIds: [] as string[],
  userIds: [] as string[],
};

async function warmup() {
  for (let i = 0; i < 4; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function newCase(title: string): Promise<string> {
  const c = await prisma.case.create({ data: { title, industry: "OTHER", stage: "DEEP_CASE" }, select: { id: true } });
  created.caseIds.push(c.id);
  return c.id;
}

async function newProject(ownerId: string): Promise<string> {
  const p = await prisma.project.create({ data: { name: `LP 项目 ${runId}`, ownerId }, select: { id: true } });
  created.projectIds.push(p.id);
  return p.id;
}

async function newOkScenario(projectId: string, withReport: boolean): Promise<string> {
  const s = await prisma.projectScenario.create({
    data: {
      projectId,
      paramLayers: {},
      paramSnapshot: {},
      calcStatus: "ok",
      ...(withReport ? { report: { sections: [{ id: "summary" }] } } : {}),
    },
    select: { id: true },
  });
  return s.id;
}

async function newPublishedSolution(creatorId: string | null): Promise<string> {
  const caseId = await newCase(`LP case ${runId}`);
  const s = await prisma.solution.create({
    data: {
      title: `LP 方案 ${runId}`,
      slug: slugFor("lpsol"),
      caseId,
      creatorId,
      status: "PUBLISHED",
      price: "1888.00",
      currency: "CNY",
      publishedAt: new Date(),
    },
    select: { id: true },
  });
  created.solutionIds.push(s.id);
  return s.id;
}

async function newOrder(args: { solutionId: string; userId?: string | null; buyerEmail: string; status: "PAID" | "PENDING" }) {
  const o = await prisma.order.create({
    data: {
      solutionId: args.solutionId,
      userId: args.userId ?? null,
      buyerEmail: args.buyerEmail,
      buyerName: "LP 买家",
      buyerType: "ENTERPRISE",
      amount: "1888.00",
      currency: "CNY",
      status: args.status,
      paidAt: args.status === "PAID" ? new Date() : null,
    },
    select: { id: true },
  });
  created.orderIds.push(o.id);
  return o.id;
}

describeDb("lead pipeline rollup (Neon)", () => {
  beforeAll(async () => {
    await warmup();
  }, 60_000);

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { id: { in: created.solutionIds } } }).catch(() => undefined);
    await prisma.project.deleteMany({ where: { id: { in: created.projectIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: created.caseIds } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { id: { in: created.leadIds } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { email: { contains: runId } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } }).catch(() => undefined);
    await disconnectPrisma().catch(() => undefined);
  });

  it("① 已注册客户全链：留资→项目→算通出报告→已发布方案→已支付订单 → 派生至 DELIVERY", async () => {
    const u = await registerUser({ email: `lp-owner-${runId}@example.com`, password: "integration-pw-123", name: "客户" });
    expect(u.status).toBe("created");
    if (u.status !== "created") return;
    const userId = u.userId;
    created.userIds.push(userId);

    const lead = await createLead(
      { company: `LP 企业 ${runId}`, contactName: "赵六", email: u.email, source: "enterprise" },
      { id: userId, email: u.email, name: "客户", role: "USER" },
    );
    expect(lead.status).toBe("ok");
    if (lead.status !== "ok") return;
    created.leadIds.push(lead.id);

    const projectId = await newProject(userId);
    await newOkScenario(projectId, true); // 算通且有报告
    const solutionId = await newPublishedSolution(userId);
    await newOrder({ solutionId, userId, buyerEmail: u.email, status: "PAID" });

    const res = await getLeadPipeline(lead.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = res.data;

    expect(v.identityResolved).toBe(true);
    expect(v.matchedUserId).toBe(userId);
    expect(v.evidence).toMatchObject({
      hasLead: true,
      projectCount: 1,
      computedScenarioCount: 1,
      solutionCount: 1,
    });
    expect(v.evidence.solutionStatuses).toEqual(["PUBLISHED"]);
    expect(v.evidence.orderStatuses).toEqual(["PAID"]);
    expect(v.pipeline.furthest).toBe("DELIVERY");
    expect(v.pipeline.nextActions).toEqual([]);
  });

  it("② 游客留资（邮箱未注册）：身份未确证、项目/方案如实空，但订单按 buyerEmail 命中", async () => {
    const anonEmail = `lp-anon-${runId}@example.com`;
    const lead = await createLead(
      { company: `LP 游客 ${runId}`, contactName: "钱七", email: anonEmail, source: "report" },
      null,
    );
    expect(lead.status).toBe("ok");
    if (lead.status !== "ok") return;
    created.leadIds.push(lead.id);

    // 无 User，但有一条以其邮箱下单的待支付订单（挂在一个非属主的已发布方案上）
    const solutionId = await newPublishedSolution(null);
    await newOrder({ solutionId, userId: null, buyerEmail: anonEmail, status: "PENDING" });

    const res = await getLeadPipeline(lead.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = res.data;

    expect(v.identityResolved).toBe(false);
    expect(v.evidence.projectCount).toBe(0);
    expect(v.evidence.solutionCount).toBe(0);
    expect(v.evidence.orderStatuses).toEqual(["PENDING"]); // 仅按邮箱命中
    expect(v.pipeline.furthest).toBe("LEAD"); // 未臆造立项
  });

  it("③ 垃圾 / 不存在 id → notFound（不泄露格式差异）", async () => {
    const bad = await getLeadPipeline("nope");
    expect(bad).toEqual({ ok: false, notFound: true });
    const missing = await getLeadPipeline("c" + "z".repeat(24)); // 合法形状但库里无
    expect(missing).toEqual({ ok: false, notFound: true });
  });
});
