import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * V1.1 P4 · 买家闭环最小可用的单元契约测试（无 DB、无 fetch）。
 *
 * 覆盖范围（P4 三块新面）：
 *   ① `/api/leads` 数据层 zod 契约（`createLeadSchema` + 白名单常量稳定）；
 *   ② `hasEntitlement`（feature flag）env 解析（默认开、显式关、非布尔串不误伤）；
 *   ③ `requireUserWrite`（api-guard）在 CSRF 通过 / 未登录 / 已登录三态下的响应；
 *   ④ `ownsSandboxSource` 属主核验：staff 恒放行；无来源指针放行；有 project/scenario 且 ownerId
 *      吻合放行；不吻合或非自有拒绝；DB 异常保守拒绝（绝不因核验失败而放行越权写入）。
 *
 * 集成（真 Neon）留待 P6 测试网阶段一并补：
 *   - `/api/leads` 端到端 + 单实例频控；
 *   - `/api/sandbox/solution` 属主 & entitlement 关时 403；
 *   - `findSolutionsBySandboxSource` `restrictToCreatorId` 过滤在 JSONB + creatorId 双约束下的实际命中集合。
 */

// ────────────────────────── ① Leads schema + 常量稳定 ──────────────────────────

import {
  createLeadSchema,
  LEAD_SOURCES,
  LEAD_PROJECT_STAGES,
  LEAD_BUDGET_RANGES,
  LEAD_STATUSES,
  LEADS_VERSION,
} from "@/server/leads";

describe("P4 · createLeadSchema（留资入参契约）", () => {
  it("版本语义化 + 三处 source 白名单锁定", () => {
    expect(LEADS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(LEAD_SOURCES).toEqual(["enterprise", "report", "pricing"]);
    expect(LEAD_STATUSES).toEqual(["NEW", "CONTACTED", "CLOSED"]);
  });

  it("最小合法（company/contactName/email/source）通过，可选字段留空即 undefined/''", () => {
    const r = createLeadSchema.safeParse({
      company: "大同港电新能源",
      contactName: "张三",
      email: "zhang@example.com",
      source: "enterprise",
      role: "",
      phone: "",
      message: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.company).toBe("大同港电新能源");
      expect(r.data.role).toBe("");
    }
  });

  it("拒绝：company 过短 / email 非法 / source 非白名单 / projectStage & budgetRange 越界", () => {
    expect(
      createLeadSchema.safeParse({ company: "A", contactName: "张", email: "a@b.co", source: "enterprise" }).success,
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({ company: "ABC", contactName: "张", email: "nope", source: "enterprise" }).success,
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({ company: "ABC", contactName: "张", email: "a@b.co", source: "homepage" }).success,
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({
        company: "ABC",
        contactName: "张",
        email: "a@b.co",
        source: "pricing",
        projectStage: "试运行",
      }).success,
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({
        company: "ABC",
        contactName: "张",
        email: "a@b.co",
        source: "pricing",
        budgetRange: "10亿",
      }).success,
    ).toBe(false);
  });

  it("长度上限守住：message ≤2000 / company ≤200 / page ≤500", () => {
    expect(
      createLeadSchema.safeParse({
        company: "ABC",
        contactName: "张",
        email: "a@b.co",
        source: "report",
        message: "字".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({
        company: "公".repeat(201),
        contactName: "张",
        email: "a@b.co",
        source: "report",
      }).success,
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({
        company: "ABC",
        contactName: "张",
        email: "a@b.co",
        source: "report",
        page: "/x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("阶段 / 预算白名单快照（防误改）", () => {
    expect(LEAD_PROJECT_STAGES).toEqual(["规划", "在建", "运营", "其他"]);
    expect(LEAD_BUDGET_RANGES).toEqual([
      "50万以内",
      "50-200万",
      "200-1000万",
      "1000-5000万",
      "5000万以上",
      "暂不清楚",
    ]);
  });
});

// ────────────────────────── ② feature-flags 环境变量解析 ──────────────────────────

import { hasEntitlement } from "@/server/feature-flags";

describe("P4 · hasEntitlement（未来接计费的唯一 seam）", () => {
  it("缺 env → 三项默认全开", () => {
    expect(hasEntitlement("export", {})).toBe(true);
    expect(hasEntitlement("multiProject", {})).toBe(true);
    expect(hasEntitlement("versionRollback", {})).toBe(true);
  });

  it("显式 0/false/off（大小写不敏感 / 允许前后空白）→ 关", () => {
    expect(hasEntitlement("export", { SANDBOX_ENTITLEMENT_EXPORT: "0" })).toBe(false);
    expect(hasEntitlement("export", { SANDBOX_ENTITLEMENT_EXPORT: "FALSE" })).toBe(false);
    expect(hasEntitlement("export", { SANDBOX_ENTITLEMENT_EXPORT: "  off  " })).toBe(false);
  });

  it("空串按「未设」处理、保持默认开（避免 CI 里 .env 空赋值误关功能）", () => {
    expect(hasEntitlement("export", { SANDBOX_ENTITLEMENT_EXPORT: "" })).toBe(true);
  });

  it("非约定字符串（'1' / 'yes' / 乱码）→ 保持开，不意外关闭功能", () => {
    expect(hasEntitlement("export", { SANDBOX_ENTITLEMENT_EXPORT: "1" })).toBe(true);
    expect(hasEntitlement("export", { SANDBOX_ENTITLEMENT_EXPORT: "on" })).toBe(true);
    expect(hasEntitlement("export", { SANDBOX_ENTITLEMENT_EXPORT: "banana" })).toBe(true);
  });
});

// ────────────────────────── ③ requireUserWrite（CSRF + 登录） ──────────────────────────

vi.mock("@/server/authz", () => ({
  STAFF_ROLES: ["REVIEWER", "ADMIN"],
  requireRole: vi.fn(),
  getCurrentUser: vi.fn(),
}));

import { getCurrentUser } from "@/server/authz";
import { requireUserWrite } from "@/server/api-guard";

const getCurrentUserMock = getCurrentUser as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getCurrentUserMock.mockReset();
});

function makeReq(url = "http://localhost:3000/api/sandbox/solution", init?: RequestInit): Request {
  return new Request(url, init);
}

describe("P4 · requireUserWrite（登录即可、任意角色）", () => {
  it("CSRF 跨站 → 403（无 Origin 头视为非浏览器，放行到下一环）", async () => {
    const req = makeReq("http://localhost:3000/api/sandbox/solution", {
      headers: { origin: "https://evil.example.com" },
    });
    const res = await requireUserWrite(req);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });

  it("未登录 → 401", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await requireUserWrite(makeReq());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it("已登录（普通 USER）→ 通过并回传 creatorId / actor", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "u_buyer", email: "b@x.co", name: null, role: "USER" });
    const res = await requireUserWrite(makeReq());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.creatorId).toBe("u_buyer");
      expect(res.actor).toBe("human:u_buyer");
    }
  });

  it("已登录（REVIEWER / ADMIN）→ 同样通过（本层不区分角色，属主判定在调用端）", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "u_rev", email: "r@x.co", name: null, role: "REVIEWER" });
    const a = await requireUserWrite(makeReq());
    expect(a.ok).toBe(true);
    getCurrentUserMock.mockResolvedValue({ id: "u_adm", email: "a@x.co", name: null, role: "ADMIN" });
    const b = await requireUserWrite(makeReq());
    expect(b.ok).toBe(true);
  });
});

// ────────────────────────── ④ ownsSandboxSource（属主核验原语） ──────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn() },
    projectScenario: { findUnique: vi.fn() },
  },
  disconnectPrisma: vi.fn(),
}));

import { prisma as mockedPrisma } from "@/lib/prisma";
import { ownsSandboxSource } from "@/server/sandbox-solution-source";

const prismaProjectFindUnique = mockedPrisma.project.findUnique as unknown as ReturnType<typeof vi.fn>;
const prismaScenarioFindUnique = mockedPrisma.projectScenario.findUnique as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  prismaProjectFindUnique.mockReset();
  prismaScenarioFindUnique.mockReset();
});

const SCEN_ID = "cs1enarioaaaaaaaaaaaaaaa1"; // 合法 cuid 形状（c + 24 [a-z0-9]）
const PROJ_ID = "cp1rojectbbbbbbbbbbbbbbb2";
const BUYER = { id: "u_owner", email: "o@x.co", name: null, role: "USER" as const };
const STAFF = { id: "u_rev", email: "r@x.co", name: null, role: "REVIEWER" as const };

describe("P4 · ownsSandboxSource（属主核验：登录 + 属主 端点语义的原语）", () => {
  it("staff（REVIEWER/ADMIN）→ 恒放行，不触库", async () => {
    const r = await ownsSandboxSource({ projectId: PROJ_ID }, STAFF);
    expect(r).toEqual({ owned: true });
    expect(prismaProjectFindUnique).not.toHaveBeenCalled();
  });

  it("无来源指针 / 脏 id → 放行（没有可越权的东西；主链由 verifySandboxSource 处理）", async () => {
    expect(await ownsSandboxSource(null, BUYER)).toEqual({ owned: true });
    expect(await ownsSandboxSource({}, BUYER)).toEqual({ owned: true });
    expect(await ownsSandboxSource({ projectId: "not-a-cuid" }, BUYER)).toEqual({ owned: true });
  });

  it("projectId 存在且 owner 吻合 → 放行", async () => {
    prismaProjectFindUnique.mockResolvedValue({ ownerId: "u_owner" });
    const r = await ownsSandboxSource({ projectId: PROJ_ID }, BUYER);
    expect(r.owned).toBe(true);
  });

  it("projectId 存在但 owner 不是本人 → 拒绝", async () => {
    prismaProjectFindUnique.mockResolvedValue({ ownerId: "u_other" });
    const r = await ownsSandboxSource({ projectId: PROJ_ID }, BUYER);
    expect(r.owned).toBe(false);
    expect(r.reason).toContain("不属于");
  });

  it("projectId 无主（ownerId=null）→ 拒绝（保守，绝不认领无主数据）", async () => {
    prismaProjectFindUnique.mockResolvedValue({ ownerId: null });
    const r = await ownsSandboxSource({ projectId: PROJ_ID }, BUYER);
    expect(r.owned).toBe(false);
  });

  it("scenarioId → 通过其所属项目的 ownerId 判定（本函数只查一次 projectScenario）", async () => {
    prismaScenarioFindUnique.mockResolvedValue({ project: { ownerId: "u_owner" } });
    const r = await ownsSandboxSource({ scenarioId: SCEN_ID }, BUYER);
    expect(r.owned).toBe(true);
    expect(prismaScenarioFindUnique).toHaveBeenCalledTimes(1);
  });

  it("scenarioId 属于别人的项目 → 拒绝", async () => {
    prismaScenarioFindUnique.mockResolvedValue({ project: { ownerId: "u_other" } });
    const r = await ownsSandboxSource({ scenarioId: SCEN_ID }, BUYER); // BUYER = u_owner ≠ u_other
    expect(r.owned).toBe(false);
    expect(r.reason).toContain("所属项目");
  });

  it("scenario 行不存在 → 放行（无指针可越权；persist 层的 verify 会负责不写假关联）", async () => {
    prismaScenarioFindUnique.mockResolvedValue(null);
    const r = await ownsSandboxSource({ scenarioId: SCEN_ID }, BUYER);
    expect(r.owned).toBe(true);
  });

  it("DB 读异常 → 保守拒绝（绝不因核验失败而放行越权写入）", async () => {
    prismaProjectFindUnique.mockRejectedValueOnce(new Error("network blip"));
    const r = await ownsSandboxSource({ projectId: PROJ_ID }, BUYER);
    expect(r.owned).toBe(false);
    expect(r.reason).toBeDefined();
  });
});
