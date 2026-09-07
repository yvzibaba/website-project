/**
 * 订单「展示态」映射（Phase 12 M4 过渡版真实购买路径，纯函数·client-safe）。
 *
 * 为什么要单独收口（宪法第 16 条防漂移）：购买闭环引入「买家已提交付款凭证」这一**派生展示态**后，
 * 同一个 status=PENDING 会在「方案订单页 / 我的订单 / 后台订单台」三处各渲染一次徽章。若每页
 * 各写一份 `status==='PENDING' ? (paymentRef ? '已提交凭证' : '待支付')` 的判断，三处口径极易漂移
 * （改一处忘改另一处）。这里把「DB 状态 + 是否已提交凭证」→「展示态 / 文案 / 徽章变体」的唯一映射
 * 收敛到本模块，三页只引用、不再各自 `if`。
 *
 * 关键诚实边界（安全 > 功能）：本模块只做**展示**，绝不参与解锁判定——解锁只由 `hasPaidEntitlement`
 * （数 status=PAID 订单）裁决；「提交了凭证」≠「已付款」≠「已解锁」。凭证态仅是给买家/员工看的进度提示。
 *
 * 无 DB、无 Next 运行时、无 process.env，纯入参→纯输出，可在 client/server 两侧安全导入，是单测主战场。
 */

/** Order.status 的原始枚举（与 Prisma enum OrderStatus 对齐，避免引 Prisma 到 client 侧）。 */
export type OrderRawStatus = "PENDING" | "PAID" | "REFUNDED" | "CANCELED";

/**
 * 面向用户的展示态。相比 DB 的 4 枚举，多出一个「已提交付款凭证」——它不是新状态机节点，
 * 而是 PENDING 且已回填 paymentRef 的派生视图（零迁移：复用闲置的 Order.paymentRef 存凭证摘要）。
 */
export type OrderDisplayState =
  | "PENDING" // 待支付：尚未提交付款凭证
  | "PROOF_SUBMITTED" // 已提交付款凭证：等待人工核对确认
  | "PAID" // 已支付（后台确认到账，正文已解锁）
  | "REFUNDED" // 已退款
  | "CANCELED"; // 已取消

/** Badge 变体（对齐 src/components/ui/badge.tsx 的 BadgeVariant 子集，避免在此引 UI 依赖）。 */
export type OrderStateBadgeVariant = "warning" | "info" | "success" | "neutral";

/**
 * 派生展示态：仅 PENDING + 已回填非空 paymentRef 才升格为「已提交凭证」；
 * 其它状态不受 paymentRef 影响（已支付/已取消即便带旧凭证摘要也不回退成待支付）。
 * paymentRef 为空串/纯空白视为「未提交」（防脏数据把待支付误标成已提交）。
 */
export function deriveOrderDisplayState(
  status: OrderRawStatus,
  paymentRef: string | null | undefined,
): OrderDisplayState {
  if (status === "PENDING" && typeof paymentRef === "string" && paymentRef.trim().length > 0) {
    return "PROOF_SUBMITTED";
  }
  return status;
}

/**
 * 是否处于「待买家操作」（可提交/更新付款凭证）。仅未支付未取消的 PENDING 态——含「已提交凭证」子态
 * （买家仍可更正凭证）。终态（PAID/REFUNDED/CANCELED）不可再提交。
 */
export function isAwaitingBuyerProof(status: OrderRawStatus): boolean {
  return status === "PENDING";
}

export const ORDER_STATE_LABEL: Record<OrderDisplayState, string> = {
  PENDING: "待支付",
  PROOF_SUBMITTED: "已提交付款凭证",
  PAID: "已支付",
  REFUNDED: "已退款",
  CANCELED: "已取消",
};

export const ORDER_STATE_VARIANT: Record<OrderDisplayState, OrderStateBadgeVariant> = {
  PENDING: "warning",
  PROOF_SUBMITTED: "info",
  PAID: "success",
  REFUNDED: "neutral",
  CANCELED: "neutral",
};

/** 便捷：一步拿到展示态的文案（三页直接调用，杜绝各写各的 label map）。 */
export function orderStatusLabel(
  status: OrderRawStatus,
  paymentRef: string | null | undefined,
): string {
  return ORDER_STATE_LABEL[deriveOrderDisplayState(status, paymentRef)];
}

/** 便捷：一步拿到展示态的徽章变体。 */
export function orderStatusVariant(
  status: OrderRawStatus,
  paymentRef: string | null | undefined,
): OrderStateBadgeVariant {
  return ORDER_STATE_VARIANT[deriveOrderDisplayState(status, paymentRef)];
}
