import { describe, it, expect, vi, beforeEach } from "vitest";

// requireStaffWrite 依赖 authz 的 requireRole（读会话）。把 authz mock 成可控输入，
// 无 DB、无真实登录即可固定测试「CSRF + 角色门禁」的组合判定（总控 §28 权限测试重点）。
vi.mock("@/server/authz", () => ({
  STAFF_ROLES: ["REVIEWER", "ADMIN"],
  requireRole: vi.fn(),
  getCurrentUser: vi.fn(),
}));

import { requireRole, getCurrentUser } from "@/server/authz";
import {
  isSameOrigin,
  actorOf,
  mutationResponse,
  errorResponse,
  requireStaffWrite,
  requireSameOriginActor,
} from "@/server/api-guard";

const requireRoleMock = requireRole as unknown as ReturnType<typeof vi.fn>;
const getCurrentUserMock = getCurrentUser as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  requireRoleMock.mockReset();
  getCurrentUserMock.mockReset();
});

/* ─────────────── isSameOrigin（纯函数 · CSRF 判定） ─────────────── */

describe("api-guard.isSameOrigin（CSRF 同源判定）", () => {
  it("无 Origin/Referer 头 → 允许（非浏览器脚本/curl 调用，真正防线是会话 SameSite + 鉴权）", () => {
    expect(isSameOrigin(null, "example.com")).toBe(true);
  });

  it("同源（host 精确相等）→ 允许", () => {
    expect(isSameOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
    expect(isSameOrigin("https://app.example.com", "app.example.com")).toBe(true);
  });

  it("跨站 host → 拒绝", () => {
    expect(isSameOrigin("https://evil.com", "app.example.com")).toBe(false);
    // 端口不同即不同源
    expect(isSameOrigin("http://localhost:4000", "localhost:3000")).toBe(false);
    // 子域不同即不同源
    expect(isSameOrigin("https://evil.example.com", "app.example.com")).toBe(false);
  });

  it("Origin 头无法解析 → 按不安全处理，拒绝", () => {
    expect(isSameOrigin("not a url", "localhost:3000")).toBe(false);
    expect(isSameOrigin("", "localhost:3000")).toBe(true); // 空串视作「无头」
  });
});

/* ─────────────── actorOf ─────────────── */

describe("api-guard.actorOf（审计标识）", () => {
  it("拼成 human:<userId>（不接受客户端传入 actor）", () => {
    expect(
      actorOf({ id: "u_9", email: "a@b.co", name: null, role: "ADMIN" }),
    ).toBe("human:u_9");
  });
});

/* ─────────────── mutationResponse（判别联合 → HTTP 状态） ─────────────── */

async function jsonOf(res: Response) {
  return (await res.json()) as {
    ok?: boolean;
    error?: { code: string; message: string; details?: Record<string, unknown> };
    [key: string]: unknown;
  };
}

describe("api-guard.mutationResponse（写入结果翻译）", () => {
  it("ok → 200 + {ok:true,...其余字段}（剥掉 status 键，透出 caseId/recompute 等）", async () => {
    const res = mutationResponse({ status: "ok", caseId: "c_1", recompute: "computed" });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.caseId).toBe("c_1");
    expect(body.recompute).toBe("computed");
    expect(body.status).toBeUndefined();
  });

  it("invalid → 400 VALIDATION_ERROR（details.fields 透出字段错误）", async () => {
    const res = mutationResponse({
      status: "invalid",
      fieldErrors: { title: ["标题不能为空"] },
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(body.error?.details).toEqual({ fields: { title: ["标题不能为空"] } });
  });

  it("not_found → 404 NOT_FOUND", async () => {
    const res = mutationResponse({ status: "not_found" });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error?.code).toBe("NOT_FOUND");
  });

  it("blocked → 409 CONFLICT（守卫拒绝，透出原因）", async () => {
    const res = mutationResponse({
      status: "blocked",
      fieldErrors: { solutions: ["仍有 1 个已发布方案，禁止删除"] },
    });
    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    expect(body.error?.code).toBe("CONFLICT");
    expect(body.error?.details).toEqual({
      fields: { solutions: ["仍有 1 个已发布方案，禁止删除"] },
    });
  });

  it("error → 500 INTERNAL_ERROR（非生产透出原始 message）", async () => {
    // vitest 默认 NODE_ENV=test（非 production），故 error 分支应透出原始 message。
    const res = mutationResponse({ status: "error", error: "db blew up" });
    expect(res.status).toBe(500);
    const body = await jsonOf(res);
    expect(body.error?.code).toBe("INTERNAL_ERROR");
    expect(body.error?.message).toBe("db blew up");
  });

  it("未知状态 → 500（默认分支兜底）", async () => {
    const res = mutationResponse({ status: "weird" as never });
    expect(res.status).toBe(500);
    expect((await jsonOf(res)).error?.code).toBe("INTERNAL_ERROR");
  });

  it("ok（订单结果）→ 200 透出 orderId/deduped/order 视图，剥掉 status", async () => {
    const res = mutationResponse({
      status: "ok",
      orderId: "o_1",
      deduped: true,
      order: { id: "o_1", amount: "1999.00", currency: "CNY", amountDisplay: "¥1999.00", status: "PENDING" },
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.orderId).toBe("o_1");
    expect(body.deduped).toBe(true);
    expect((body.order as Record<string, unknown>).amount).toBe("1999.00");
    expect(body.status).toBeUndefined();
  });
});

/* ─────────────── errorResponse ─────────────── */

describe("api-guard.errorResponse", () => {
  it("带 details 与不带 details 两种形态", async () => {
    const a = errorResponse("FORBIDDEN", "nope", 403);
    expect(a.status).toBe(403);
    expect(await jsonOf(a)).toEqual({ error: { code: "FORBIDDEN", message: "nope" } });

    const b = errorResponse("FORBIDDEN", "nope", 403, { required: ["ADMIN"] });
    expect((await jsonOf(b)).error?.details).toEqual({ required: ["ADMIN"] });
  });
});

/* ─────────────── requireStaffWrite（CSRF + 角色组合） ─────────────── */

function makeRequest(url: string, origin?: string, referer?: string): Request {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers.origin = origin;
  if (referer !== undefined) headers.referer = referer;
  return new Request(url, { method: "POST", headers });
}

describe("api-guard.requireStaffWrite（后台写端点统一门禁）", () => {
  const SAME = "http://localhost:3000/api/admin/cases";

  it("跨站 Origin → 403 CSRF，且根本不查角色（先挡跨站）", async () => {
    const res = await requireStaffWrite(makeRequest(SAME, "https://evil.com"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      expect((await jsonOf(res.response)).error?.message).toContain("CSRF");
    }
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("同源 + 未登录 → 401 UNAUTHORIZED", async () => {
    requireRoleMock.mockResolvedValue({ ok: false, reason: "unauthenticated" });
    const res = await requireStaffWrite(makeRequest(SAME, "http://localhost:3000"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it("同源 + USER（角色不符）→ 403 FORBIDDEN，透出 required", async () => {
    requireRoleMock.mockResolvedValue({
      ok: false,
      reason: "forbidden",
      required: ["REVIEWER", "ADMIN"],
    });
    const res = await requireStaffWrite(makeRequest(SAME, "http://localhost:3000"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      expect((await jsonOf(res.response)).error?.details).toEqual({
        required: ["REVIEWER", "ADMIN"],
      });
    }
  });

  it("同源 + ADMIN → 放行，返回服务端注入的 actor（human:<id>）", async () => {
    const user = { id: "u_42", email: "admin@x.co", name: "Admin", role: "ADMIN" as const };
    requireRoleMock.mockResolvedValue({ ok: true, user });
    const res = await requireStaffWrite(makeRequest(SAME, "http://localhost:3000"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.actor).toBe("human:u_42");
      expect(res.user.id).toBe("u_42");
    }
  });

  it("无 Origin 但带同源 Referer → 允许（退化到 Referer 的 origin）", async () => {
    const user = { id: "u_7", email: "r@x.co", name: null, role: "REVIEWER" as const };
    requireRoleMock.mockResolvedValue({ ok: true, user });
    const res = await requireStaffWrite(
      makeRequest(SAME, undefined, "http://localhost:3000/admin/cases/new"),
    );
    expect(res.ok).toBe(true);
  });

  it("无 Origin 且带跨站 Referer → 403 CSRF", async () => {
    const res = await requireStaffWrite(
      makeRequest(SAME, undefined, "https://evil.com/attack"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
    expect(requireRoleMock).not.toHaveBeenCalled();
  });
});

/* ─────────────── requireSameOriginActor（用户下单：CSRF + 会话身份，不查角色） ─────────────── */

describe("api-guard.requireSameOriginActor（买家写端点：只 CSRF、不 gate 角色）", () => {
  const ORD = "http://localhost:3000/api/orders";

  it("跨站 Origin → 403 CSRF，且根本不读会话（先挡跨站）", async () => {
    const res = await requireSameOriginActor(makeRequest(ORD, "https://evil.com"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      expect((await jsonOf(res.response)).error?.message).toContain("CSRF");
    }
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  it("同源 + 已登录 → ok，注入会话身份与 actor=human:<id>", async () => {
    const user = { id: "buyer_5", email: "b@x.co", name: null, role: "USER" as const };
    getCurrentUserMock.mockResolvedValue(user);
    const res = await requireSameOriginActor(makeRequest(ORD, "http://localhost:3000"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user?.id).toBe("buyer_5");
      expect(res.actor).toBe("human:buyer_5");
    }
    // 下单端点绝不套角色门禁
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it("同源 + 游客（无会话）→ ok，user 与 actor 均为 null", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await requireSameOriginActor(makeRequest(ORD, "http://localhost:3000"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user).toBeNull();
      expect(res.actor).toBeNull();
    }
    expect(requireRoleMock).not.toHaveBeenCalled();
  });
});
