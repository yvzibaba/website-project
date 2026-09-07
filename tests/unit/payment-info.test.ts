import { describe, it, expect, afterEach } from "vitest";
import { getPaymentInfo, PAYMENT_UNCONFIGURED_LABEL } from "@/lib/payment-info";

/**
 * 单元测试：人工收款信息读取（Phase 12 M4）。核心是「诚实」——未配置绝不虚构账户，
 * configured 只在有实质收款信息（payeeName/account/instruction 任一）时为真；
 * 空串/纯空白归一为「未配置」（复刻 site.ts 的 `X=` 得到 "" 的坑）。
 */

const KEYS = ["PAYEE_NAME", "PAYMENT_ACCOUNT", "PAYMENT_INSTRUCTION", "PAYMENT_NOTE"] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function seed(partial: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) {
    saved[k] ??= process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(partial)) process.env[k] = v as string;
}

describe("getPaymentInfo", () => {
  it("全部未配置 → configured=false 且各字段缺省（不编造账户）", () => {
    seed({});
    const info = getPaymentInfo();
    expect(info.configured).toBe(false);
    expect(info.payeeName).toBeUndefined();
    expect(info.account).toBeUndefined();
    expect(info.instruction).toBeUndefined();
    expect(info.note).toBeUndefined();
  });

  it("仅有 PAYMENT_NOTE（无账户/收款人/说明）→ 仍 configured=false（光有备注没法付款）", () => {
    seed({ PAYMENT_NOTE: "工作日 9-18 点核对" });
    const info = getPaymentInfo();
    expect(info.configured).toBe(false);
    expect(info.note).toBe("工作日 9-18 点核对");
  });

  it("配置了收款账户 → configured=true，字段原样透出", () => {
    seed({
      PAYEE_NAME: "某某科技有限公司",
      PAYMENT_ACCOUNT: "6222 0000 0000 0000",
      PAYMENT_INSTRUCTION: "请转账至对公账户",
      PAYMENT_NOTE: "备注写订单号",
    });
    const info = getPaymentInfo();
    expect(info.configured).toBe(true);
    expect(info.payeeName).toBe("某某科技有限公司");
    expect(info.account).toBe("6222 0000 0000 0000");
    expect(info.instruction).toBe("请转账至对公账户");
    expect(info.note).toBe("备注写订单号");
  });

  it("空串 / 纯空白归一为未配置（防 `.env` 写 PAYMENT_ACCOUNT= 得到 \"\"）", () => {
    seed({ PAYEE_NAME: "   ", PAYMENT_ACCOUNT: "", PAYMENT_INSTRUCTION: "" });
    const info = getPaymentInfo();
    expect(info.configured).toBe(false);
    expect(info.payeeName).toBeUndefined();
    expect(info.account).toBeUndefined();
  });

  it("instruction 单独存在也算 configured=true（有指引即可操作）", () => {
    seed({ PAYMENT_INSTRUCTION: "联系客服获取对公账户" });
    expect(getPaymentInfo().configured).toBe(true);
  });

  it("占位文案常量稳定（页面与测试同一口径）", () => {
    expect(PAYMENT_UNCONFIGURED_LABEL).toBe("人工付款信息待配置");
  });
});
