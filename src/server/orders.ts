import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma, type ChangeAction, type Order } from "@prisma/client";
import { CuidSchema, EmailSchema, BuyerTypeSchema } from "@/lib/validation";

/**
 * 订单数据层（Phase 12 M1，server-only）——「用户查看 → 购买 → 后台确认 → 解锁」闭环的可信底座。
 *
 * 为什么现在能做（不撞外部阻塞）：`Order` 表早在 Phase 4/5 就随 schema 建好（含
 * PENDING/PAID/REFUNDED/CANCELED 状态机、amount Decimal、paymentProvider 预留字段），总控 §5/PRODUCT_SPEC
 * 与详情页占位均已把 V1 购买流明确为「下单 → 支付说明 → 后台确认 → 解锁」——**刻意不接支付网关**（ROADMAP #5），
 * 而用「后台人工把 PENDING 确认为 PAID」这一最简闭环先跑通商业链路。故本里程碑无需任何 schema 迁移。
 *
 * 不可妥协的诚实与安全（宪法第 7/20 条 + 优先级：安全/数据质量 > 功能数量）：
 *   - **金额只从服务端读取的 `Solution.price` 快照进 `Order.amount`，绝不接受客户端传入的金额**——
 *     否则用户可把 1999 改成 0.01 下单。这是"钱"的路径，必须程序可复算、来源唯一。
 *   - 只能对 **status=PUBLISHED** 的方案下单（DRAFT / 审核中不可购买，与公开详情门控一致）。
 *   - **同一买家对同一方案的重复下单幂等去重**：已有一张未支付（PENDING）单时直接复用、不再新建，
 *     避免用户误点产生一堆待支付单；已支付过（PAID）则不重复下单（返回 blocked 提示已拥有）。
 *   - 身份：登录用户带 `userId`（由上层从会话注入，本层只透传不鉴权），游客带 `buyerEmail`（归一小写）。
 *     二者至少其一，否则事后无法找回订单、也无法判定解锁。
 *   - 状态机：`confirmPaid` 只允许 PENDING→PAID 且 `paidAt` 仅首次落库（幂等）；PAID/REFUNDED/CANCELED
 *     为终态不可再 confirm。`cancel` 只允许 PENDING→CANCELED（V1 无退款流程，PAID 不能 cancel，属 #5）。
 *
 * 本模块**不做鉴权**——信任调用方（后台路由 / 详情页服务端）已按角色与属主过滤；`actor` 仅写审计。
 * 一律判别联合返回，不向调用方抛裸异常。
 */

const log = logger.child({ module: "server/orders" });

/* ─────────────────────────── 入参 schema（复用 validation 单一真源） ─────────────────────────── */

export const OrderCreateSchema = z
  .object({
    solutionId: CuidSchema,
    userId: CuidSchema.optional(),
    buyerEmail: EmailSchema.optional(),
    buyerName: z.string().trim().max(120, "姓名过长").optional(),
    buyerType: BuyerTypeSchema.default("INDIVIDUAL"),
  })
  .refine((v) => Boolean(v.userId || v.buyerEmail), {
    message: "需要登录身份或联系邮箱",
    path: ["identity"],
  });
export type OrderCreateInput = z.infer<typeof OrderCreateSchema>;

/* ─────────────────────────── 视图 / 结果类型 ─────────────────────────── */

export interface OrderView {
  id: string;
  solutionId: string;
  solutionTitle: string | null;
  status: Order["status"];
  /** 服务端从方案价快照的金额（两位小数字符串，金额不走浮点，宪法第 7 条）。 */
  amount: string;
  currency: string;
  amountDisplay: string;
  buyerType: Order["buyerType"];
  buyerEmail: string | null;
  buyerName: string | null;
  userId: string | null;
  paidAt: Date | null;
  createdAt: Date;
  version: number;
}

export interface OrderMutationResult {
  status: "ok" | "invalid" | "not_found" | "blocked" | "error";
  orderId?: string;
  order?: OrderView;
  /** 命中已存在的待支付单（幂等去重），非本次新建。 */
  deduped?: boolean;
  fieldErrors?: Record<string, string[]>;
  error?: string;
}

export interface OrderListResult {
  ok: boolean;
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  error?: string;
}

/* ─────────────────────────── 内部工具 ─────────────────────────── */

function toFieldErrors(err: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === null || v === undefined ? (Prisma.DbNull as typeof Prisma.DbNull) : (v as Prisma.InputJsonValue);
}

function changeLogArgs(
  entityId: string,
  action: ChangeAction,
  actor: string | undefined,
  reason: string,
  before: unknown,
  after: unknown,
): Prisma.ChangeLogUncheckedCreateInput {
  return {
    entityType: "Order",
    entityId,
    action,
    changedBy: actor ?? null,
    reason,
    before: jsonOrNull(before),
    after: jsonOrNull(after),
  };
}

function mapPrismaWriteError(err: unknown): OrderMutationResult | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2003") return { status: "invalid", fieldErrors: { relation: ["关联的方案或用户不存在"] } };
    if (err.code === "P2025") return { status: "not_found" };
  }
  return null;
}

/** Decimal(方案价) → 两位小数字符串（Prisma Decimal 提供 toFixed；toString 会丢尾零）。 */
function decimalToAmount(dec: Prisma.Decimal): string {
  return dec.toFixed(2);
}
function displayOf(amount: string, currency: string): string {
  return `${currency === "USD" ? "$" : "¥"}${amount}`;
}
function toView(o: {
  id: string;
  solutionId: string;
  status: Order["status"];
  amount: Prisma.Decimal;
  currency: Order["currency"];
  buyerType: Order["buyerType"];
  buyerEmail: string | null;
  buyerName: string | null;
  userId: string | null;
  paidAt: Date | null;
  createdAt: Date;
  version: number;
  solution?: { title: string } | null;
}): OrderView {
  const amount = decimalToAmount(o.amount);
  return {
    id: o.id,
    solutionId: o.solutionId,
    solutionTitle: o.solution?.title ?? null,
    status: o.status,
    amount,
    currency: o.currency,
    amountDisplay: displayOf(amount, o.currency),
    buyerType: o.buyerType,
    buyerEmail: o.buyerEmail,
    buyerName: o.buyerName,
    userId: o.userId,
    paidAt: o.paidAt,
    createdAt: o.createdAt,
    version: o.version,
  };
}

/* ─────────────────────────── create（下单，PENDING） ─────────────────────────── */

/**
 * 下单。方案须存在且 PUBLISHED；金额由服务端读取方案价快照（绝不信任客户端）。
 * 幂等：同一买家对该方案已有 PENDING 单则复用返回（deduped=true）；已 PAID 则 blocked。
 */
export async function createOrder(input: unknown, actor?: string): Promise<OrderMutationResult> {
  const parsed = OrderCreateSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", fieldErrors: toFieldErrors(parsed.error) };
  const d = parsed.data;

  const solution = await prisma.solution.findUnique({
    where: { id: d.solutionId },
    select: { id: true, title: true, status: true, price: true, currency: true },
  });
  if (!solution) return { status: "invalid", fieldErrors: { solutionId: ["方案不存在"] } };
  if (solution.status !== "PUBLISHED") return { status: "blocked", fieldErrors: { solutionId: ["该方案尚未发布，暂不可购买"] } };
  if (solution.price === null) return { status: "blocked", fieldErrors: { solutionId: ["该方案未定价，暂不可购买"] } };

  // 属主匹配：登录用户按 userId，游客按归一 buyerEmail。
  const ownerWhere: Prisma.OrderWhereInput = d.userId
    ? { solutionId: d.solutionId, userId: d.userId }
    : { solutionId: d.solutionId, buyerEmail: d.buyerEmail ?? null };

  try {
    const existing = await prisma.order.findFirst({
      where: ownerWhere,
      orderBy: { createdAt: "desc" },
      include: { solution: { select: { title: true } } },
    });
    if (existing && existing.status === "PAID") {
      return { status: "blocked", orderId: existing.id, fieldErrors: { solutionId: ["你已购买过该方案，无需重复下单"] } };
    }
    if (existing && existing.status === "PENDING") {
      log.info("createOrder deduped to existing pending order", { orderId: existing.id, solutionId: d.solutionId });
      return { status: "ok", orderId: existing.id, order: toView(existing), deduped: true };
    }

    const amount = decimalToAmount(solution.price);
    const created = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          solutionId: d.solutionId,
          userId: d.userId ?? null,
          buyerEmail: d.buyerEmail ?? null,
          buyerName: d.buyerName ?? null,
          buyerType: d.buyerType,
          amount, // 服务端快照，两位小数字符串写入 Decimal 列
          currency: solution.currency,
          status: "PENDING",
        },
        include: { solution: { select: { title: true } } },
      });
      await tx.changeLog.create({
        data: changeLogArgs(o.id, "CREATE", actor, "创建订单（待支付）", null, {
          solutionId: d.solutionId,
          solutionTitle: o.solution.title,
          amount,
          currency: o.currency,
          buyerType: o.buyerType,
          buyerEmail: o.buyerEmail,
          status: "PENDING",
        }),
      });
      return o;
    });

    log.info("order created", { orderId: created.id, solutionId: d.solutionId, amount });
    return { status: "ok", orderId: created.id, order: toView(created) };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return mapped;
    const message = err instanceof Error ? err.message : String(err);
    log.error("createOrder failed", { error: message });
    return { status: "error", error: message };
  }
}

/* ─────────────────────────── confirmPaid（后台确认收款） ─────────────────────────── */

/**
 * 后台把待支付订单确认为已付（最简支付闭环：线下收款后人工点确认）。
 * 仅 PENDING→PAID，`paidAt` 首次落库；已 PAID 幂等返回 ok（不重复打时间戳）；终态（REFUNDED/CANCELED）blocked。
 */
export async function confirmOrderPaid(orderId: string, actor?: string): Promise<OrderMutationResult> {
  const idParsed = CuidSchema.safeParse(orderId);
  if (!idParsed.success) return { status: "not_found", orderId };

  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    include: { solution: { select: { title: true } } },
  });
  if (!existing) return { status: "not_found", orderId };
  if (existing.status === "PAID") {
    return { status: "ok", orderId, order: toView(existing), deduped: true }; // 幂等
  }
  if (existing.status !== "PENDING") {
    return { status: "blocked", orderId, fieldErrors: { status: [`订单当前为 ${existing.status}，无法确认为已付`] } };
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const o = await tx.order.update({
        where: { id: orderId },
        data: { status: "PAID", paidAt: new Date(), version: { increment: 1 } },
        include: { solution: { select: { title: true } } },
      });
      await tx.changeLog.create({
        data: changeLogArgs(orderId, "UPDATE", actor, "后台确认收款（PENDING→PAID）", { status: "PENDING" }, { status: "PAID", paidAt: o.paidAt }),
      });
      return o;
    });
    log.info("order confirmed paid", { orderId, actor: actor ?? null });
    return { status: "ok", orderId, order: toView(updated) };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, orderId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("confirmOrderPaid failed", { error: message, orderId });
    return { status: "error", orderId, error: message };
  }
}

/* ─────────────────────────── cancel（取消待支付单） ─────────────────────────── */

/** 取消：仅 PENDING→CANCELED。已支付不可取消（V1 无退款流程，属 ROADMAP #5）。 */
export async function cancelOrder(orderId: string, actor?: string): Promise<OrderMutationResult> {
  const idParsed = CuidSchema.safeParse(orderId);
  if (!idParsed.success) return { status: "not_found", orderId };

  const existing = await prisma.order.findUnique({ where: { id: orderId }, include: { solution: { select: { title: true } } } });
  if (!existing) return { status: "not_found", orderId };
  if (existing.status === "CANCELED") return { status: "ok", orderId, order: toView(existing), deduped: true };
  if (existing.status !== "PENDING") {
    return { status: "blocked", orderId, fieldErrors: { status: [`仅待支付订单可取消，当前为 ${existing.status}`] } };
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const o = await tx.order.update({
        where: { id: orderId },
        data: { status: "CANCELED", version: { increment: 1 } },
        include: { solution: { select: { title: true } } },
      });
      await tx.changeLog.create({
        data: changeLogArgs(orderId, "UPDATE", actor, "取消待支付订单（PENDING→CANCELED）", { status: "PENDING" }, { status: "CANCELED" }),
      });
      return o;
    });
    log.info("order canceled", { orderId, actor: actor ?? null });
    return { status: "ok", orderId, order: toView(updated) };
  } catch (err) {
    const mapped = mapPrismaWriteError(err);
    if (mapped) return { ...mapped, orderId };
    const message = err instanceof Error ? err.message : String(err);
    log.error("cancelOrder failed", { error: message, orderId });
    return { status: "error", orderId, error: message };
  }
}

/* ─────────────────────────── 读取：单条 / 属主列表 / 后台列表 / 解锁判定 ─────────────────────────── */

export async function getOrderById(orderId: string): Promise<{ status: "found" | "not_found" | "error"; data?: OrderView; error?: string }> {
  const idParsed = CuidSchema.safeParse(orderId);
  if (!idParsed.success) return { status: "not_found" };
  try {
    const o = await prisma.order.findUnique({ where: { id: orderId }, include: { solution: { select: { title: true } } } });
    if (!o) return { status: "not_found" };
    return { status: "found", data: toView(o) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("getOrderById failed", { error: message, orderId });
    return { status: "error", error: message };
  }
}

/** 某买家（登录 userId 或归一 email）名下的订单，含未支付，按创建时间倒序——用于「我的订单」。 */
export async function listOrdersForBuyer(identity: { userId?: string | null; email?: string | null }): Promise<OrderView[]> {
  const or: Prisma.OrderWhereInput[] = [];
  if (identity.userId) or.push({ userId: identity.userId });
  if (identity.email) or.push({ buyerEmail: identity.email.toLowerCase() });
  if (or.length === 0) return [];
  try {
    const rows = await prisma.order.findMany({
      where: { OR: or },
      orderBy: { createdAt: "desc" },
      include: { solution: { select: { title: true } } },
    });
    return rows.map(toView);
  } catch (err) {
    log.error("listOrdersForBuyer failed", { err });
    return [];
  }
}

/** 后台订单列表：可按状态过滤，按创建时间倒序，返回总数用于分页。 */
export async function listOrdersForAdmin(params: { status?: Order["status"]; page: number; pageSize: number }): Promise<OrderListResult> {
  const where: Prisma.OrderWhereInput = params.status ? { status: params.status } : {};
  const empty: OrderListResult = { ok: false, items: [], total: 0, page: params.page, pageSize: params.pageSize, hasPrev: false, hasNext: false };
  try {
    const [rows, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { solution: { select: { title: true } } },
      }),
      prisma.order.count({ where }),
    ]);
    return {
      ok: true,
      items: rows.map(toView),
      total,
      page: params.page,
      pageSize: params.pageSize,
      hasPrev: params.page > 1,
      hasNext: (params.page - 1) * params.pageSize + rows.length < total,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("listOrdersForAdmin failed", { err });
    return { ...empty, error: message };
  }
}

/**
 * 解锁判定（V1 假设，可后续按产品裁决调整）：买家对某方案是否拥有已支付订单。
 * 命中条件 = 存在一条 status=PAID 且 (userId 相同 或 buyerEmail 归一相同) 的订单。
 * 注：方案定价为 0 视为免费、恒可解锁（由调用方另行传 freeAsUnlocked=true 时短路）。
 */
export async function hasPaidEntitlement(
  solutionId: string,
  identity: { userId?: string | null; email?: string | null },
): Promise<boolean> {
  const or: Prisma.OrderWhereInput[] = [];
  if (identity.userId) or.push({ userId: identity.userId });
  if (identity.email) or.push({ buyerEmail: identity.email.toLowerCase() });
  if (or.length === 0) return false;
  try {
    const count = await prisma.order.count({ where: { solutionId, status: "PAID", AND: [{ OR: or }] } });
    return count > 0;
  } catch (err) {
    log.error("hasPaidEntitlement failed", { err, solutionId });
    return false; // 判定失败保守不解锁（宁缺毋滥，避免白送付费内容）
  }
}
