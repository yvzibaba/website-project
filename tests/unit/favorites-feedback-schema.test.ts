import { describe, it, expect, vi } from "vitest";

// 纯 schema 契约测试（Phase 4 模块 C）：只验收藏 / 反馈的入参校验规则，绝不触库。
// 把 prisma 单例 mock 掉，避免在 CI/无 DATABASE_URL 环境下 import 期实例化客户端。
vi.mock("@/lib/prisma", () => ({ prisma: {}, disconnectPrisma: vi.fn() }));

import { favoriteMutationSchema, FAVORITE_TARGET_TYPES } from "@/server/favorites";
import { createFeedbackSchema, listFeedbackSchema, FEEDBACK_KINDS, FEEDBACK_STATUSES } from "@/server/feedback";

/**
 * 关注点（无 DB 单测；写入路径归集成/真机验证）：
 *   - 收藏：targetType 白名单只认 CASE/SOLUTION（不是任意串）；targetId 必填且去空白。
 *   - 反馈：kind 白名单、message 5–2000、email 空串归一为 undefined + 格式校验、page 截断语义（trim 后超长拒）。
 *   - 列表：limit coerce 数字并夹在 1–200，缺省 50；status 白名单 OPEN/RESOLVED。
 */

describe("favoriteMutationSchema (pure contract, no DB)", () => {
  it("合法：CASE + 非空 targetId 通过", () => {
    const r = favoriteMutationSchema.safeParse({ targetType: "CASE", targetId: " clrx1z2ab3cd4ef5gh6ij7kl " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.targetId).toBe("clrx1z2ab3cd4ef5gh6ij7kl");
  });

  it("拒绝：targetType 不在白名单（如 USER/PROJECT）", () => {
    for (const bad of ["USER", "PROJECT", "case", ""]) {
      const r = favoriteMutationSchema.safeParse({ targetType: bad, targetId: "x" });
      expect(r.success).toBe(false);
    }
    expect(FAVORITE_TARGET_TYPES).toEqual(["CASE", "SOLUTION"]);
  });

  it("拒绝：缺 targetId / 空 targetId", () => {
    expect(favoriteMutationSchema.safeParse({ targetType: "SOLUTION" }).success).toBe(false);
    expect(favoriteMutationSchema.safeParse({ targetType: "SOLUTION", targetId: "   " }).success).toBe(false);
  });
});

describe("createFeedbackSchema (pure contract, no DB)", () => {
  it("合法：BUG + 足够长的 message；email 空串归一为 undefined", () => {
    const r = createFeedbackSchema.safeParse({ kind: "BUG", message: "沙盘页点保存报错", email: "" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBeUndefined();
      expect(FEEDBACK_KINDS).toContain(r.data.kind);
    }
  });

  it("合法：SUGGESTION + page 来源路径", () => {
    const r = createFeedbackSchema.safeParse({ kind: "SUGGESTION", message: "希望增加导出 Excel 功能", page: "/sandbox" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.page).toBe("/sandbox");
  });

  it("拒绝：kind 不在白名单", () => {
    const r = createFeedbackSchema.safeParse({ kind: "SPAM", message: "测试内容长度足够" });
    expect(r.success).toBe(false);
  });

  it("拒绝：message 过短（<5）或过长（>2000）", () => {
    expect(createFeedbackSchema.safeParse({ kind: "BUG", message: "短" }).success).toBe(false);
    expect(createFeedbackSchema.safeParse({ kind: "BUG", message: "a".repeat(2001) }).success).toBe(false);
  });

  it("拒绝：email 格式非法；合法邮箱通过", () => {
    expect(createFeedbackSchema.safeParse({ kind: "BUG", message: "内容长度足够", email: "not-an-email" }).success).toBe(false);
    const ok = createFeedbackSchema.safeParse({ kind: "BUG", message: "内容长度足够", email: "a@b.co" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.email).toBe("a@b.co");
  });
});

describe("listFeedbackSchema (pure contract, no DB)", () => {
  it("缺省 limit=50；字符串数字被 coerce", () => {
    const r = listFeedbackSchema.safeParse({ limit: "10" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(10);
    const d = listFeedbackSchema.safeParse({});
    expect(d.success).toBe(true);
    if (d.success) expect(d.data.limit).toBe(50);
  });

  it("limit 出界被拒；status 只认 OPEN/RESOLVED", () => {
    expect(listFeedbackSchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listFeedbackSchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(listFeedbackSchema.safeParse({ status: "CLOSED" }).success).toBe(false);
    expect(FEEDBACK_STATUSES).toEqual(["OPEN", "RESOLVED"]);
  });
});
