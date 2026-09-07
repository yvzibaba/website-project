import { describe, it, expect } from "vitest";
import {
  deriveOrderDisplayState,
  isAwaitingBuyerProof,
  orderStatusLabel,
  orderStatusVariant,
  ORDER_STATE_LABEL,
  ORDER_STATE_VARIANT,
} from "@/lib/order-status";

/**
 * 单元测试：订单展示态派生（Phase 12 M4，过渡版购买路径）。纯函数、无 DB、无 env——单测主战场。
 * 死守「已提交凭证」只在 PENDING + 非空 paymentRef 时升格；终态绝不因残留 paymentRef 回退；
 * 展示口径与解锁判定解耦（这里不涉及 hasPaidEntitlement）。
 */

describe("deriveOrderDisplayState", () => {
  it("PENDING 且 paymentRef 非空 → PROOF_SUBMITTED", () => {
    expect(deriveOrderDisplayState("PENDING", "工行尾号1234 09-07 转账")).toBe("PROOF_SUBMITTED");
  });

  it("PENDING 且 paymentRef 为 null/空串/纯空白 → 仍 PENDING（不把脏数据误标成已提交）", () => {
    expect(deriveOrderDisplayState("PENDING", null)).toBe("PENDING");
    expect(deriveOrderDisplayState("PENDING", undefined)).toBe("PENDING");
    expect(deriveOrderDisplayState("PENDING", "")).toBe("PENDING");
    expect(deriveOrderDisplayState("PENDING", "   ")).toBe("PENDING");
  });

  it("非 PENDING 的终态即使带 paymentRef 也不变（已支付/已取消/已退款不回退成待支付）", () => {
    expect(deriveOrderDisplayState("PAID", "已付款流水X")).toBe("PAID");
    expect(deriveOrderDisplayState("CANCELED", "旧凭证Y")).toBe("CANCELED");
    expect(deriveOrderDisplayState("REFUNDED", "旧凭证Z")).toBe("REFUNDED");
  });
});

describe("isAwaitingBuyerProof", () => {
  it("仅 PENDING 为真（无论是否已提交过，仍可更新凭证）", () => {
    expect(isAwaitingBuyerProof("PENDING")).toBe(true);
    expect(isAwaitingBuyerProof("PAID")).toBe(false);
    expect(isAwaitingBuyerProof("CANCELED")).toBe(false);
    expect(isAwaitingBuyerProof("REFUNDED")).toBe(false);
  });
});

describe("展示态文案 / 变体（三页共用，防漂移）", () => {
  it("PROOF_SUBMITTED 文案=已提交付款凭证、变体=info；PENDING 文案=待支付、变体=warning", () => {
    expect(orderStatusLabel("PENDING", "abc")).toBe("已提交付款凭证");
    expect(orderStatusVariant("PENDING", "abc")).toBe("info");
    expect(orderStatusLabel("PENDING", null)).toBe("待支付");
    expect(orderStatusVariant("PENDING", null)).toBe("warning");
  });

  it("PAID→已支付/success，CANCELED/REFUNDED→neutral", () => {
    expect(ORDER_STATE_LABEL.PAID).toBe("已支付");
    expect(ORDER_STATE_VARIANT.PAID).toBe("success");
    expect(ORDER_STATE_VARIANT.CANCELED).toBe("neutral");
    expect(ORDER_STATE_VARIANT.REFUNDED).toBe("neutral");
  });

  it("便捷函数与显式派生结果一致（orderStatusLabel == LABEL[derive]）", () => {
    const cases = [
      ["PENDING", null],
      ["PENDING", "凭证"],
      ["PAID", "凭证"],
      ["CANCELED", null],
      ["REFUNDED", "凭证"],
    ] as const;
    for (const [s, r] of cases) {
      expect(orderStatusLabel(s, r)).toBe(ORDER_STATE_LABEL[deriveOrderDisplayState(s, r)]);
      expect(orderStatusVariant(s, r)).toBe(ORDER_STATE_VARIANT[deriveOrderDisplayState(s, r)]);
    }
  });
});
