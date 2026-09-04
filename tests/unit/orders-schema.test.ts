import { describe, it, expect, vi } from "vitest";

// 纯 schema 契约测试：只验订单入参校验规则，绝不触库。
// 把 prisma 单例 mock 掉，避免在 CI/无 DATABASE_URL 环境下 import 期实例化客户端。
vi.mock("@/lib/prisma", () => ({ prisma: {}, disconnectPrisma: vi.fn() }));

import { OrderCreateSchema } from "@/server/orders";

/**
 * Phase 12 M1 订单数据层的**无 DB** 单测：锁定「钱与身份」这两条不可妥协契约里
 * 纯校验的部分（集成测试另有覆盖写入路径，但那些需要 Neon）。
 *
 * 关注点：
 *   - 客户端无法从 schema 夹带 amount/status/currency（白名单解析 → 这些键被剥离）。
 *   - 身份：userId 与 buyerEmail 至少其一，否则 invalid 且错误挂在 path=["identity"]。
 *   - buyerEmail 归一小写（与属主找回/解锁判定同一口径）。
 *   - buyerType 缺省 INDIVIDUAL，仅接受 INDIVIDUAL/ENTERPRISE。
 *   - solutionId 必须是 cuid 形状。
 */

const VALID_CUID = "clrx1z2ab3cd4ef5gh6ij7kl";

describe("OrderCreateSchema (pure contract, no DB)", () => {
  it("合法：带 buyerEmail 的游客下单通过，且邮箱归一小写、buyerType 缺省 INDIVIDUAL", () => {
    const r = OrderCreateSchema.safeParse({
      solutionId: VALID_CUID,
      buyerEmail: "Buyer@Example.COM",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.buyerEmail).toBe("buyer@example.com");
      expect(r.data.buyerType).toBe("INDIVIDUAL");
    }
  });

  it("合法：登录用户带 userId 下单通过", () => {
    const r = OrderCreateSchema.safeParse({ solutionId: VALID_CUID, userId: VALID_CUID });
    expect(r.success).toBe(true);
  });

  it("缺身份（既无 userId 也无 buyerEmail）→ invalid，错误在 identity 路径", () => {
    const r = OrderCreateSchema.safeParse({ solutionId: VALID_CUID });
    expect(r.success).toBe(false);
    if (!r.success) {
      const identityIssue = r.error.issues.find((i) => i.path.join(".") === "identity");
      expect(identityIssue).toBeDefined();
    }
  });

  it("白名单解析：客户端夹带的 amount/status/currency/price 被剥离（防篡改金额）", () => {
    const r = OrderCreateSchema.safeParse({
      solutionId: VALID_CUID,
      buyerEmail: "x@example.com",
      amount: "0.01",
      status: "PAID",
      currency: "USD",
      price: 0,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as Record<string, unknown>;
      expect(data).not.toHaveProperty("amount");
      expect(data).not.toHaveProperty("status");
      expect(data).not.toHaveProperty("currency");
      expect(data).not.toHaveProperty("price");
    }
  });

  it("非法邮箱 → invalid", () => {
    const r = OrderCreateSchema.safeParse({ solutionId: VALID_CUID, buyerEmail: "not-an-email" });
    expect(r.success).toBe(false);
  });

  it("非法 buyerType → invalid", () => {
    const r = OrderCreateSchema.safeParse({
      solutionId: VALID_CUID,
      userId: VALID_CUID,
      buyerType: "GOVERNMENT",
    });
    expect(r.success).toBe(false);
  });

  it("solutionId 非 cuid 形状 → invalid", () => {
    const r = OrderCreateSchema.safeParse({ solutionId: "nope", buyerEmail: "x@example.com" });
    expect(r.success).toBe(false);
  });
});
