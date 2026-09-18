import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@app/kernel/lib/prisma";
import { registerUser } from "@/server/users";
import {
  createLead,
  listLeads,
  updateLeadStatus,
  type LeadStatus,
} from "@/server/leads";
import type { SessionUser } from "@/server/authz";

/**
 * 集成测试：留资（RFQ）商业路径的完整闭环（真连 Neon，不 mock）。
 *
 * 为什么放 P6（而非只做单测）：这是对「真实陌生用户能不能走完商业路径」的端到端证明，
 * 也是 P4 收尾时明确「留待 P6 测试网阶段一并补」的 /api/leads 端到端项。锁死三段：
 *   ① 游客留资：createLead(userId 恒为 null，凭自填 email) → listLeads 读回一致（含 P4-brief 三资格字段）；
 *   ② 登录留资：注册一次性真用户 → createLead 归因 userId → listLeads 带 submitterUserEmail；
 *   ③ 状态管理闭环（P6 补的 P4 尾巴在真库上成立）：NEW → CONTACTED → CLOSED 逐次回写，每次读回都变；
 *      并对不存在的 lead 回写返回 not_found（后台点了不该 500）。
 * 一次性 runId 前缀 + afterAll 按 email 兜底删除 lead + user，绝不污染真库、不留孤儿行。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[leads-lifecycle] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

const createdLeadIds: string[] = [];
let createdUserId: string | null = null;

describeDb("leads lifecycle · 商业路径端到端 (Neon)", () => {
  beforeAll(async () => {
    await warmup();
  }, 60_000);

  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { email: { contains: runId } } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } }).catch(() => undefined);
    if (createdUserId) {
      await prisma.user.delete({ where: { id: createdUserId } }).catch(() => undefined);
    }
    await disconnectPrisma();
  });

  async function findLead(id: string) {
    return prisma.lead.findUnique({ where: { id } });
  }

  it("① 游客留资 → listLeads 读回一致（含三资格字段），userId 恒 null", async () => {
    const res = await createLead(
      {
        company: `测试企业-${runId}`,
        contactName: "张三",
        email: `guest-${runId}@example.com`,
        projectRegion: "山西大同",
        fleetSize: "200-500台",
        needType: "投资测算/可行性",
        source: "enterprise",
        page: "/enterprise",
      },
      null,
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    createdLeadIds.push(res.id);

    const row = await findLead(res.id);
    expect(row).not.toBeNull();
    expect(row!.userId).toBeNull();
    expect(row!.status).toBe("NEW");
    expect(row!.projectRegion).toBe("山西大同");
    expect(row!.fleetSize).toBe("200-500台");
    expect(row!.needType).toBe("投资测算/可行性");

    const list = await listLeads({ status: "NEW", limit: 200 });
    expect(list.ok).toBe(true);
    const seen = list.items.find((l) => l.id === res.id);
    expect(seen?.company).toBe(`测试企业-${runId}`);
    expect(seen?.submitterUserEmail).toBeNull();
  });

  it("② 登录留资 → 归因 userId、listLeads 带 submitterUserEmail", async () => {
    const u = await registerUser({ email: `owner-${runId}@example.com`, password: "integration-pw-123", name: "买家" });
    expect(u.status).toBe("created");
    if (u.status !== "created") return;
    createdUserId = u.userId;
    const session: SessionUser = { id: u.userId, email: u.email, name: "买家", role: "USER" };

    const res = await createLead(
      {
        company: `买家企业-${runId}`,
        contactName: "李四",
        email: u.email,
        source: "report",
      },
      session,
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    createdLeadIds.push(res.id);

    const row = await findLead(res.id);
    expect(row!.userId).toBe(u.userId);

    const list = await listLeads({ status: "NEW", limit: 200 });
    const seen = list.ok ? list.items.find((l) => l.id === res.id) : undefined;
    expect(seen?.submitterUserEmail).toBe(u.email);
  });

  it("③ 状态管理闭环：NEW→CONTACTED→CLOSED 逐次回写生效；不存在 → not_found", async () => {
    const res = await createLead(
      { company: `状态流转-${runId}`, contactName: "王五", email: `flow-${runId}@example.com`, source: "pricing" },
      null,
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    const id = res.id;
    createdLeadIds.push(id);

    const seq: LeadStatus[] = ["CONTACTED", "CLOSED"];
    for (const s of seq) {
      const r = await updateLeadStatus(id, s);
      expect(r.status).toBe("ok");
      const row = await findLead(id);
      expect(row!.status).toBe(s);
    }

    // 幂等：重复标记同状态仍 ok，不报错、不变。
    expect((await updateLeadStatus(id, "CLOSED")).status).toBe("ok");

    // 后台点了不存在的 lead → not_found（不是 500/崩溃）。
    const missing = await updateLeadStatus("cuid_missing_" + runId, "CLOSED");
    expect(missing.status).toBe("not_found");
  });
});
