import { describe, it, expect, vi, beforeEach } from "vitest";

// 用 vi.mock 替换 @/auth 的 auth()，把「会话有无 / 角色」做成可控输入，
// 从而在无 DB、无真实登录的情况下固定测试鉴权判定（总控 §28 权限测试重点）。
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import {
  hasRole,
  requireUser,
  requireRole,
  getCurrentUser,
  STAFF_ROLES,
} from "@/server/authz";
import type { UserRole } from "@/lib/validation";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;

function fakeSession(role: UserRole | null, opts: { noId?: boolean; noUser?: boolean } = {}) {
  if (role === null || opts.noUser) return { user: undefined };
  return {
    user: {
      id: opts.noId ? "" : "u_1",
      email: "staff@example.com",
      name: "Staff",
      role,
    },
  };
}

describe("authz.hasRole（纯函数 · 角色判定）", () => {
  it("STAFF_ROLES = [REVIEWER, ADMIN]（守护：普通用户被排除）", () => {
    expect(STAFF_ROLES).toEqual(["REVIEWER", "ADMIN"]);
    expect(STAFF_ROLES).not.toContain("USER");
  });

  it("管理员/审核员在员工集合内 → true", () => {
    expect(hasRole("ADMIN", STAFF_ROLES)).toBe(true);
    expect(hasRole("REVIEWER", STAFF_ROLES)).toBe(true);
  });

  it("普通用户在员工集合外 → false", () => {
    expect(hasRole("USER", STAFF_ROLES)).toBe(false);
  });

  it("role 缺失（undefined）→ 保守拒绝 false", () => {
    expect(hasRole(undefined, STAFF_ROLES)).toBe(false);
  });

  it("允许集合为空 → 一律 false", () => {
    expect(hasRole("ADMIN", [])).toBe(false);
  });

  it("任意允许集合精确匹配（不只员工）", () => {
    const only: readonly UserRole[] = ["ADMIN"];
    expect(hasRole("ADMIN", only)).toBe(true);
    expect(hasRole("REVIEWER", only)).toBe(false);
  });
});

describe("authz.getCurrentUser（会话 → 身份视图）", () => {
  beforeEach(() => authMock.mockReset());

  it("有效会话 → 返回 id/email/name/role", async () => {
    authMock.mockResolvedValue(fakeSession("ADMIN"));
    const user = await getCurrentUser();
    expect(user).toEqual({ id: "u_1", email: "staff@example.com", name: "Staff", role: "ADMIN" });
  });

  it("无会话 → null", async () => {
    authMock.mockResolvedValue(null);
    expect(await getCurrentUser()).toBeNull();
  });

  it("会话缺 id → 保守视为未登录（null）", async () => {
    authMock.mockResolvedValue(fakeSession("USER", { noId: true }));
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("authz.requireUser（仅要求已登录）", () => {
  beforeEach(() => authMock.mockReset());

  it("已登录 → ok + user", async () => {
    authMock.mockResolvedValue(fakeSession("USER"));
    const res = await requireUser();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.role).toBe("USER");
  });

  it("未登录 → unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const res = await requireUser();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthenticated");
  });
});

describe("authz.requireRole（要求角色在允许集合内）", () => {
  beforeEach(() => authMock.mockReset());

  it("未登录 → unauthenticated", async () => {
    authMock.mockResolvedValue(null);
    const res = await requireRole(STAFF_ROLES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unauthenticated");
  });

  it("已登录普通用户 → forbidden（携带 required 集合）", async () => {
    authMock.mockResolvedValue(fakeSession("USER"));
    const res = await requireRole(STAFF_ROLES);
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "forbidden") expect(res.required).toEqual(["REVIEWER", "ADMIN"]);
  });

  it("审核员 → ok", async () => {
    authMock.mockResolvedValue(fakeSession("REVIEWER"));
    const res = await requireRole(STAFF_ROLES);
    expect(res.ok).toBe(true);
  });

  it("管理员 → ok", async () => {
    authMock.mockResolvedValue(fakeSession("ADMIN"));
    const res = await requireRole(STAFF_ROLES);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.role).toBe("ADMIN");
  });
});
