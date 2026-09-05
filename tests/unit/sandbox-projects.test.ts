import { describe, it, expect, vi, beforeEach } from "vitest";

// 离线单测：顶掉 prisma / logger / authz / sandbox-store，专注验证「鉴权真值表 + 编排契约」，绝不触库、绝不打真模型。
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: vi.fn() }, projectScenario: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock("@/server/authz", () => ({ STAFF_ROLES: ["REVIEWER", "ADMIN"] }));
vi.mock("@/server/sandbox-store", () => ({
  createProject: vi.fn(),
  updateScenarioLayers: vi.fn(),
  saveScenarioAsVersion: vi.fn(),
  restoreScenarioFromVersion: vi.fn(),
  getProjectWithScenarios: vi.fn(),
  listScenarioVersions: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
  canAccessProject,
  createProjectSchema,
  createSandboxProject,
  updateSandboxScenario,
  saveSandboxScenarioVersion,
  restoreSandboxScenarioVersion,
  readSandboxProject,
  readSandboxScenarioVersions,
  SANDBOX_PROJECTS_VERSION,
} from "@/server/sandbox-projects";
import * as store from "@/server/sandbox-store";
import type { SessionUser } from "@/server/authz";

const findProject = prisma.project.findUnique as unknown as ReturnType<typeof vi.fn>;
const findScenario = prisma.projectScenario.findUnique as unknown as ReturnType<typeof vi.fn>;

const USER: SessionUser = { id: "u-owner", email: "o@x.com", name: "O", role: "USER" };
const INTRUDER: SessionUser = { id: "u-other", email: "i@x.com", name: "I", role: "USER" };
const REVIEWER: SessionUser = { id: "u-rev", email: "r@x.com", name: "R", role: "REVIEWER" };
const ADMIN: SessionUser = { id: "u-admin", email: "a@x.com", name: "A", role: "ADMIN" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sandbox-projects · 常量与输入契约", () => {
  it("SANDBOX_PROJECTS_VERSION 是语义化版本串", () => {
    expect(SANDBOX_PROJECTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("createProjectSchema：trim 名称、拒空名、给 layers 默认 {}", () => {
    const ok = createProjectSchema.safeParse({ name: "  山西方案  " });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.name).toBe("山西方案");
      expect(ok.data.layers).toEqual({});
    }
    expect(createProjectSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createProjectSchema.safeParse({}).success).toBe(false);
  });

  it("layers 原样保留（不剥离政策日期窗等未声明键 —— R6.3 正确性所系）", () => {
    const layers = {
      region: { values: { "region.elecPrice": 0.55 }, source: "X", bounds: { "region.elecPrice": { min: 0.35 } } },
      policy: [{ values: { "policy.feedInTariff": 0.33 }, effectiveFrom: "2024-01-01T00:00:00.000Z", confidence: 45 }],
      user: { values: { "project.chargingPrice": 1.2 } },
      now: "2026-06-01T00:00:00.000Z",
    };
    const parsed = createProjectSchema.safeParse({ name: "x", layers });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const p = parsed.data.layers as Record<string, unknown>;
      expect((p.policy as Array<Record<string, unknown>>)[0].effectiveFrom).toBe("2024-01-01T00:00:00.000Z");
      expect((p.region as Record<string, unknown>).bounds).toBeDefined();
      expect(p.now).toBe("2026-06-01T00:00:00.000Z");
    }
  });
});

describe("sandbox-projects · canAccessProject（§28 权限真值表 / 纯函数）", () => {
  it("owner 本人可访问自己的项目", () => {
    expect(canAccessProject("u-owner", USER)).toBe(true);
  });
  it("普通 USER 不可访问他人项目，也不得认领无主（null owner）dev 项目", () => {
    expect(canAccessProject("u-owner", INTRUDER)).toBe(false);
    expect(canAccessProject(null, USER)).toBe(false);
    expect(canAccessProject(undefined, USER)).toBe(false);
  });
  it("STAFF（REVIEWER/ADMIN）越过 owner 限制（含 null owner）", () => {
    expect(canAccessProject("u-owner", REVIEWER)).toBe(true);
    expect(canAccessProject(null, REVIEWER)).toBe(true);
    expect(canAccessProject("u-owner", ADMIN)).toBe(true);
    expect(canAccessProject(null, ADMIN)).toBe(true);
  });
});

describe("sandbox-projects · createSandboxProject（ownerId 强制服务端会话）", () => {
  it("成功：忽略客户端伪造的 ownerId、注入会话 user.id + actor，透传 layers 交 store 现算", async () => {
    (store.createProject as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, projectId: "p1", scenarioId: "s1" });
    const res = await createSandboxProject(
      { name: "方案", ownerId: "victim-should-be-ignored", layers: { user: { values: { "project.chargingPrice": 1.2 } } } },
      { user: USER },
    );
    expect(res).toMatchObject({ status: "ok", projectId: "p1", scenarioId: "s1" });
    const arg = (store.createProject as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.ownerId).toBe("u-owner"); // ★绝不用客户端 ownerId
    expect(arg.actor).toBe("human:u-owner");
    expect(arg.initialLayers).toEqual({ user: { values: { "project.chargingPrice": 1.2 } } });
  });

  it("空名 → invalid，且不触 store", async () => {
    const res = await createSandboxProject({ name: "  " }, { user: USER });
    expect(res.status).toBe("invalid");
    expect(store.createProject).not.toHaveBeenCalled();
  });

  it("store 报错 → 归一 error", async () => {
    (store.createProject as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: "error", detail: "数据库错误(P2002)" });
    const res = await createSandboxProject({ name: "x" }, { user: USER });
    expect(res).toEqual({ status: "error", error: "数据库错误(P2002)" });
  });
});

describe("sandbox-projects · 情景级操作先过 owner-or-staff（越权在动库前拦）", () => {
  it("update：非 owner USER → forbidden，store 绝不被调用", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    const res = await updateSandboxScenario("s1", { layers: { user: { values: {} } } }, { user: INTRUDER });
    expect(res.status).toBe("forbidden");
    expect(store.updateScenarioLayers).not.toHaveBeenCalled();
  });
  it("update：情景不存在 → not_found", async () => {
    findScenario.mockResolvedValue(null);
    const res = await updateSandboxScenario("ghost", { layers: {} }, { user: USER });
    expect(res.status).toBe("not_found");
    expect(store.updateScenarioLayers).not.toHaveBeenCalled();
  });
  it("update：owner 通过 → 调 store 重算并回 ok", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    (store.updateScenarioLayers as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, calcStatus: "ok", version: 3 });
    const res = await updateSandboxScenario("s1", { layers: { user: { values: { "project.chargingPrice": 1.5 } } } }, { user: USER });
    expect(res).toMatchObject({ status: "ok", version: 3, calcStatus: "ok" });
    expect(store.updateScenarioLayers).toHaveBeenCalledWith(
      "s1",
      { user: { values: { "project.chargingPrice": 1.5 } } },
      { actor: "human:u-owner" },
    );
  });
  it("update：STAFF 非 owner 亦可（后台治理）", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    (store.updateScenarioLayers as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, calcStatus: "ok", version: 2 });
    const res = await updateSandboxScenario("s1", { layers: {} }, { user: REVIEWER });
    expect(res.status).toBe("ok");
  });

  it("saveVersion：owner 通过 → store 收到 savedBy actor", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    (store.saveScenarioAsVersion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, versionId: "v1", seq: 1 });
    const res = await saveSandboxScenarioVersion("s1", { label: "调电价后" }, { user: USER });
    expect(res).toMatchObject({ status: "ok", versionId: "v1", seq: 1 });
    expect(store.saveScenarioAsVersion).toHaveBeenCalledWith("s1", { label: "调电价后", note: undefined, savedBy: "human:u-owner" });
  });
  it("saveVersion：非 owner USER → forbidden，store 不被调用", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    const res = await saveSandboxScenarioVersion("s1", {}, { user: INTRUDER });
    expect(res.status).toBe("forbidden");
    expect(store.saveScenarioAsVersion).not.toHaveBeenCalled();
  });

  it("restore：缺 versionId → invalid，store 不被调用", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    const res = await restoreSandboxScenarioVersion("s1", {}, { user: USER });
    expect(res.status).toBe("invalid");
    expect(store.restoreScenarioFromVersion).not.toHaveBeenCalled();
  });
  it("restore：store 判版本不属此情景(forbidden) → 透传 forbidden", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    (store.restoreScenarioFromVersion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: "forbidden", detail: "该版本不属于此情景" });
    const res = await restoreSandboxScenarioVersion("s1", { versionId: "vx" }, { user: USER });
    expect(res).toEqual({ status: "forbidden", error: "该版本不属于此情景" });
  });
});

describe("sandbox-projects · 读取（精简视图，不外泄快照/Decimal）", () => {
  it("readProject：owner 通过 → 映射 Decimal→number、Date→ISO、无 calcResult", async () => {
    findProject.mockResolvedValue({ id: "p1", ownerId: "u-owner" });
    (store.getProjectWithScenarios as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "p1",
      name: "方案",
      description: null,
      regionId: "shanxi",
      status: "DRAFT",
      ownerId: "u-owner",
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      region: { id: "r", name: "山西", code: "SX" },
      scenarios: [
        {
          id: "s1",
          name: "基准情景",
          isBaseline: true,
          version: 2,
          calcStatus: "ok",
          calcRef: "model@1.0.0",
          capexNet: { toString: () => "3524500.00" },
          npv: { toString: () => "4277409.00" },
          irrPct: null,
          paybackYears: null,
          roiRatio: null,
          calcResult: { secret: "big-json" },
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
    });
    const res = await readSandboxProject("p1", { user: USER });
    expect(res.status).toBe("ok");
    const project = (res as { project: Record<string, unknown> }).project;
    const sc = (project.scenarios as Array<Record<string, unknown>>)[0];
    expect(sc.npv).toBe(4277409); // Decimal → number
    expect(sc.irrPct).toBeNull(); // null 诚实保留
    expect(sc).not.toHaveProperty("calcResult"); // 快照不外泄
    expect(sc.updatedAt).toBe("2026-06-01T00:00:00.000Z"); // Date → ISO 串
  });
  it("readProject：非 owner USER → forbidden，store 不被调用", async () => {
    findProject.mockResolvedValue({ id: "p1", ownerId: "u-owner" });
    const res = await readSandboxProject("p1", { user: INTRUDER });
    expect(res.status).toBe("forbidden");
    expect(store.getProjectWithScenarios).not.toHaveBeenCalled();
  });
  it("readVersions：STAFF 可读他人项目版本时间线", async () => {
    findScenario.mockResolvedValue({ id: "s1", projectId: "p1", project: { ownerId: "u-owner" } });
    (store.listScenarioVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "v1", seq: 2, label: "L", note: null, calcRef: "model@1.0.0", savedBy: "human:x", createdAt: new Date("2026-05-01T00:00:00.000Z") },
    ]);
    const res = await readSandboxScenarioVersions("s1", { user: ADMIN });
    expect(res.status).toBe("ok");
    const versions = (res as { versions: Array<Record<string, unknown>> }).versions;
    expect(versions[0].createdAt).toBe("2026-05-01T00:00:00.000Z");
  });
});
