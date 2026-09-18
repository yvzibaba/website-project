import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * V1.1 P6 · 商业/买家路径两处 P1 缺口的回归测试（无真实 DB、无 fetch、纯 node 环境）。
 *
 * 修的两件事（均不触碰 MODEL/TECH/PARAMS/SENSITIVITY/PROFILES/VIEW/REPORT 与任何经济公式/黄金样本）：
 *   ① 买家「导出 DRAFT 方案」成功后不再被硬链到 staff-only 的 /admin（点了必撞 403）——导出端点
 *      回 isStaff，成功 UI 据此分流。本测锁路由在 USER / REVIEWER / ADMIN 三态会话下透出的 isStaff。
 *   ② 后台「Lead 状态管理」补上唯一写入口 POST /api/admin/leads/[id]/status（P4 尾巴），走 staff 门禁；
 *      本测锁：非 staff/未登录 → 403/401 且绝不触库、未知状态 → 400 且不下传、合法状态 → 落数据层并翻译。
 *   另补 updateLeadStatus 数据层真实单测（此前后台页面注释称「已被单测覆盖」实为假绿——全仓无一处测到它）。
 *
 * 做法：把 @/server/authz mock 成可控会话/角色（顺带打破 next-auth→next/server 的 ESM 解析链）；
 * 把 @/lib/prisma 换成 spy —— 于是「路由 → 真实 updateLeadStatus → 假 prisma」这条链被端到端钉死。
 */

const { leadFindUnique, leadUpdate } = vi.hoisted(() => ({ leadFindUnique: vi.fn(), leadUpdate: vi.fn() }));
vi.mock("@app/kernel/lib/prisma", () => ({
  prisma: { lead: { findUnique: leadFindUnique, update: leadUpdate } },
  disconnectPrisma: vi.fn(),
}));
vi.mock("@/server/authz", () => ({
  STAFF_ROLES: ["REVIEWER", "ADMIN"],
  requireRole: vi.fn(),
  getCurrentUser: vi.fn(),
}));
vi.mock("@/server/feature-flags", () => ({ hasEntitlement: vi.fn(() => true) }));
vi.mock("@app/kernel/server/sandbox-solution-source", () => ({ ownsSandboxSource: vi.fn(async () => ({ owned: true })) }));
vi.mock("@app/kernel/server/sandbox-solution-store", () => ({
  persistSandboxSolutionDraft: vi.fn(async () => ({
    status: "ok",
    solutionId: "sol_1",
    financialCount: 2,
    unknownCount: 1,
    warnings: [],
    publishBlockers: [],
  })),
}));

import { requireRole, getCurrentUser } from "@/server/authz";
import { updateLeadStatus } from "@/server/leads";
import { POST as exportSolution } from "@/app/api/sandbox/solution/route";
import { POST as setLeadStatus } from "@/app/api/admin/leads/[id]/status/route";

const requireRoleMock = requireRole as unknown as ReturnType<typeof vi.fn>;
const getCurrentUserMock = getCurrentUser as unknown as ReturnType<typeof vi.fn>;

function makeReq(url: string, body: unknown): Request {
  const origin = new URL(url).origin;
  return new Request(url, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ───────────────────────── ① 导出端点 isStaff 透出 ───────────────────────── */

describe("V1.1 P6 · /api/sandbox/solution 回 isStaff（买家导出死路修复的核心契约）", () => {
  async function isStaffForRole(role: "USER" | "REVIEWER" | "ADMIN") {
    getCurrentUserMock.mockResolvedValue({ id: "u_1", email: "x@y.co", name: null, role });
    const res = (await exportSolution(
      makeReq("http://localhost:3000/api/sandbox/solution", { caseId: "c_1" }) as never,
    )) as unknown as Response;
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.solutionId).toBe("sol_1");
    return body.isStaff;
  }

  it("普通买家 USER → isStaff=false（前端据此不给后台链接）", async () => {
    expect(await isStaffForRole("USER")).toBe(false);
  });
  it("审核员 REVIEWER → isStaff=true", async () => {
    expect(await isStaffForRole("REVIEWER")).toBe(true);
  });
  it("管理员 ADMIN → isStaff=true", async () => {
    expect(await isStaffForRole("ADMIN")).toBe(true);
  });
  it("未登录 → requireUserWrite 直接 401，根本不落库", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = (await exportSolution(
      makeReq("http://localhost:3000/api/sandbox/solution", { caseId: "c_1" }) as never,
    )) as unknown as Response;
    expect(res.status).toBe(401);
  });
});

/* ───────────────────────── ② Lead 状态管理路由（P4 尾巴补全） ───────────────────────── */

describe("V1.1 P6 · POST /api/admin/leads/[id]/status（留资状态回写门禁 + 端到端真实数据层）", () => {
  const url = "http://localhost:3000/api/admin/leads/lead_9/status";
  const ctx = { params: Promise.resolve({ id: "lead_9" }) };
  const STAFF_OK = { ok: true, user: { id: "adm_1", email: "a@x.co", name: "A", role: "ADMIN" } };

  it("非 staff（角色不符）→ 403，且绝不触库", async () => {
    requireRoleMock.mockResolvedValue({ ok: false, reason: "forbidden", required: ["REVIEWER", "ADMIN"] });
    const res = (await setLeadStatus(makeReq(url, { status: "CLOSED" }) as never, ctx as never)) as unknown as Response;
    expect(res.status).toBe(403);
    expect(leadFindUnique).not.toHaveBeenCalled();
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it("未登录 → 401，且绝不触库", async () => {
    requireRoleMock.mockResolvedValue({ ok: false, reason: "unauthenticated" });
    const res = (await setLeadStatus(makeReq(url, { status: "CLOSED" }) as never, ctx as never)) as unknown as Response;
    expect(res.status).toBe(401);
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it("staff + 非法状态 → 400 VALIDATION_ERROR，且绝不下传数据层", async () => {
    requireRoleMock.mockResolvedValue(STAFF_OK);
    const res = (await setLeadStatus(makeReq(url, { status: "BOGUS" }) as never, ctx as never)) as unknown as Response;
    expect(res.status).toBe(400);
    expect(leadFindUnique).not.toHaveBeenCalled();
  });

  it("staff + 合法状态 → 落到真实数据层、写库并返回 200", async () => {
    requireRoleMock.mockResolvedValue(STAFF_OK);
    leadFindUnique.mockResolvedValue({ id: "lead_9" });
    leadUpdate.mockResolvedValue({ id: "lead_9" });
    const res = (await setLeadStatus(makeReq(url, { status: "CONTACTED" }) as never, ctx as never)) as unknown as Response;
    expect(res.status).toBe(200);
    expect(leadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lead_9" }, data: { status: "CONTACTED" } }),
    );
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.id).toBe("lead_9");
  });

  it("staff + 记录不存在 → 404（数据层给缺失语义，路由照翻译）", async () => {
    requireRoleMock.mockResolvedValue(STAFF_OK);
    leadFindUnique.mockResolvedValue(null);
    const res = (await setLeadStatus(makeReq(url, { status: "CLOSED" }) as never, ctx as never)) as unknown as Response;
    expect(res.status).toBe(404);
    expect(leadUpdate).not.toHaveBeenCalled();
  });
});

/* ───────────────────────── ③ updateLeadStatus 数据层真实覆盖（纠正假绿声明） ───────────────────────── */

describe("V1.1 P6 · updateLeadStatus 数据层真实覆盖", () => {
  it("空 id / 超长 id → invalid，不查库", async () => {
    expect((await updateLeadStatus("", "NEW")).status).toBe("invalid");
    expect((await updateLeadStatus("x".repeat(101), "NEW")).status).toBe("invalid");
    expect(leadFindUnique).not.toHaveBeenCalled();
  });

  it("未知状态 → invalid，不查库", async () => {
    const r = await updateLeadStatus("lead_1", "NOPE" as never);
    expect(r.status).toBe("invalid");
    expect(leadFindUnique).not.toHaveBeenCalled();
  });

  it("记录不存在 → not_found，且不写库", async () => {
    leadFindUnique.mockResolvedValue(null);
    const r = await updateLeadStatus("lead_missing", "CLOSED");
    expect(r.status).toBe("not_found");
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it("存在 → 写状态并返回 ok（幂等：写同状态也 ok）", async () => {
    leadFindUnique.mockResolvedValue({ id: "lead_1" });
    leadUpdate.mockResolvedValue({ id: "lead_1" });
    const r = await updateLeadStatus("lead_1", "CONTACTED");
    expect(r).toEqual({ status: "ok", id: "lead_1" });
    expect(leadUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lead_1" }, data: { status: "CONTACTED" } }),
    );
  });

  it("DB 抛错 → 保守 error，不裸抛", async () => {
    leadFindUnique.mockResolvedValue({ id: "lead_1" });
    leadUpdate.mockRejectedValue(new Error("db blew up"));
    const r = await updateLeadStatus("lead_1", "CLOSED");
    expect(r.status).toBe("error");
  });
});
