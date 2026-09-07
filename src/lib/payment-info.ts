/**
 * 人工收款信息（Phase 12 M4 过渡版真实购买路径，仅服务端读取的环境配置）。
 *
 * 背景与硬约束（宪法第 20 条诚实 + 优先级：安全/数据质量 > 功能数量）：V1 **刻意不接第三方支付网关**
 * （ROADMAP #5），采用「站外人工转账 + 后台确认到账」最简闭环。订单页要给买家展示「往哪个账户、
 * 付多少钱、备注写什么」的收款说明——但这些是**真实经营信息**（对公账户/收款人/收款二维码说明等），
 * **绝不可由代码虚构**（编造一个假账号或假二维码去让人转账是危险的）。因此本模块只做一件事：
 *   读取运维在部署环境里显式配置的 `PAYMENT_*` 环境变量，原样透出；**未配置时如实返回 configured=false**，
 *   由页面显示「人工付款信息待配置」占位，而不是编一个默认账户。
 *
 * 为什么用非 NEXT_PUBLIC 变量（不进前端包）：收款账户属敏感经营信息，只在 RSC（订单页）服务端渲染时读取，
 * 不经 client bundle 泄露；买家侧看到的是服务端渲染好的文本。这也保证 `.env*` 被 gitignore、密钥/账户不入库。
 *
 * 纯函数、无 DB；仅类型上"建议只在服务端调用"（读 process.env 服务端变量）。
 */

/** 单个环境变量归一：空串/纯空白 → undefined（与 site.ts 同样处理 `X=` 得到 "" 的坑）。 */
function envTrim(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

export interface PaymentInfo {
  /** 收款人 / 主体名称（如公司户名）。未配置为 undefined。 */
  payeeName?: string;
  /** 收款账户说明（银行账号 / 支付宝或微信收款方式文字说明等）。未配置为 undefined。 */
  account?: string;
  /** 付款步骤 / 转账指引（多行文本，由运维自填）。 */
  instruction?: string;
  /** 补充备注（如对账备注口径、到账时效、防诈提示覆盖项）。 */
  note?: string;
  /**
   * 是否已配置**任何**实质收款信息。三者（payeeName/account/instruction）全缺 → false，
   * 页面据此显示「人工付款信息待配置」，避免给出无法照做的空指令或虚构账户。
   * （note 单独存在不算 configured——仅有备注没有账户同样无法付款。）
   */
  configured: boolean;
}

/** 读取当前环境的人工收款信息（每次调用现读，便于测试注入 process.env）。 */
export function getPaymentInfo(): PaymentInfo {
  const payeeName = envTrim("PAYEE_NAME");
  const account = envTrim("PAYMENT_ACCOUNT");
  const instruction = envTrim("PAYMENT_INSTRUCTION");
  const note = envTrim("PAYMENT_NOTE");
  const configured = Boolean(payeeName || account || instruction);
  return {
    ...(payeeName ? { payeeName } : {}),
    ...(account ? { account } : {}),
    ...(instruction ? { instruction } : {}),
    ...(note ? { note } : {}),
    configured,
  };
}

/** 未配置时的统一占位文案（全站唯一口径，页面与单测都引用此常量，避免各处字符串漂移）。 */
export const PAYMENT_UNCONFIGURED_LABEL = "人工付款信息待配置";
