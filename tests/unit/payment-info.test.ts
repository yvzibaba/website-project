import { describe, it, expect, afterEach } from "vitest";
import {
  getPaymentInfo,
  PAYMENT_UNCONFIGURED_LABEL,
  getSupportContact,
  SUPPORT_UNCONFIGURED_LABEL,
} from "@/lib/payment-info";

/**
 * 单元测试：人工收款信息 + 客服入口读取（Phase 12 M4 + 决策1.5）。核心是「诚实」——未配置
 * 绝不虚构账户 / 邮箱 / 微信 / URL，configured 只在有实质信息时为真；空串/纯空白归一为「未配置」
 * （复刻 site.ts 的 `X=` 得到 "" 的坑）。
 */

const PAYMENT_KEYS = ["PAYEE_NAME", "PAYMENT_ACCOUNT", "PAYMENT_INSTRUCTION", "PAYMENT_NOTE"] as const;
const SUPPORT_KEYS = ["SUPPORT_EMAIL", "SUPPORT_WECHAT", "SUPPORT_URL"] as const;
const ALL_KEYS: readonly string[] = [...PAYMENT_KEYS, ...SUPPORT_KEYS];
type PaymentKey = (typeof PAYMENT_KEYS)[number];
type SupportKey = (typeof SUPPORT_KEYS)[number];
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function seed(partial: Partial<Record<PaymentKey | SupportKey, string>>) {
  for (const k of ALL_KEYS) {
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

describe("getSupportContact", () => {
  it("全部未配置 → configured=false 且各字段缺省（绝不虚构邮箱/微信/链接）", () => {
    seed({});
    const s = getSupportContact();
    expect(s.configured).toBe(false);
    expect(s.email).toBeUndefined();
    expect(s.wechat).toBeUndefined();
    expect(s.url).toBeUndefined();
  });

  it("任一非空即 configured=true（email / wechat / url 都算实质联系入口）", () => {
    seed({ SUPPORT_EMAIL: "support@example.com" });
    expect(getSupportContact().configured).toBe(true);
    seed({ SUPPORT_WECHAT: "acme-support" });
    expect(getSupportContact().configured).toBe(true);
    seed({ SUPPORT_URL: "https://help.example.com/contact" });
    expect(getSupportContact().configured).toBe(true);
  });

  it("三槽可组合，字段原样透出（前端渲染前再自校 URL 协议）", () => {
    seed({
      SUPPORT_EMAIL: "hi@acme.example",
      SUPPORT_WECHAT: "acme_support",
      SUPPORT_URL: "https://acme.example/help",
    });
    const s = getSupportContact();
    expect(s.configured).toBe(true);
    expect(s.email).toBe("hi@acme.example");
    expect(s.wechat).toBe("acme_support");
    expect(s.url).toBe("https://acme.example/help");
  });

  it("空串 / 纯空白归一为未配置（防 SUPPORT_EMAIL= 得到 \"\"）", () => {
    seed({ SUPPORT_EMAIL: "   ", SUPPORT_WECHAT: "", SUPPORT_URL: "" });
    const s = getSupportContact();
    expect(s.configured).toBe(false);
    expect(s.email).toBeUndefined();
    expect(s.wechat).toBeUndefined();
    expect(s.url).toBeUndefined();
  });

  it("客服与收款两组环境变量互不干扰（configured 独立判定）", () => {
    seed({ PAYMENT_ACCOUNT: "6222 0000 0000", SUPPORT_EMAIL: "hi@acme.example" });
    expect(getPaymentInfo().configured).toBe(true);
    expect(getSupportContact().configured).toBe(true);
    seed({ PAYMENT_ACCOUNT: "6222 0000 0000" });
    expect(getPaymentInfo().configured).toBe(true);
    expect(getSupportContact().configured).toBe(false);
    seed({ SUPPORT_EMAIL: "hi@acme.example" });
    expect(getPaymentInfo().configured).toBe(false);
    expect(getSupportContact().configured).toBe(true);
  });

  it("占位文案常量稳定（页面与测试同一口径）", () => {
    expect(SUPPORT_UNCONFIGURED_LABEL).toBe("客服联系信息待配置");
  });
});
