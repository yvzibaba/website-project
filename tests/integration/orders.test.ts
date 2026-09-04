import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  createOrder,
  confirmOrderPaid,
  cancelOrder,
  getOrderById,
  listOrdersForBuyer,
  listOrdersForAdmin,
  hasPaidEntitlement,
} from "@/server/orders";

/**
 * 集成测试：订单数据层（Phase 12 M1），真连 Neon，不 mock。
 *
 * 死守"钱"的路径不可篡改 + 状态机 + 幂等 + 解锁判定：
 *   金额从方案价服务端快照（客户端传的 amount 被 schema 剥掉）、只能对 PUBLISHED 且有价方案下单、
 *   缺身份 invalid、同买家同方案重复下单幂等复用、confirmPaid 首次打 paidAt 且幂等、
 *   PAID 不可 cancel、取消仅 PENDING、已购买再下单 blocked、hasPaidEntitlement 前后翻转、
 *   属主/后台列表、审计 ChangeLog(entityType=Order) 落痕。afterAll 按外键序 order→solution→case 清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[orders] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-orders-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const buyerEmail = `buyer-${runId}@example.com`;
const otherEmail = `other-${runId}@example.com`;

let caseId = "";
let solutionId = "";
let draftSolutionId = "";
const orderIds: string[] = [];

async function warmup() {
  for (let i = 0; i < 4; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function track(id?: string) {
  if (id) orderIds.push(id);
}
function countChanges(orderId: string, action: "CREATE" | "UPDATE") {
  return prisma.changeLog.count({ where: { entityType: "Order", entityId: orderId, action } });
}

describeDb("order data layer (Neon)", () => {
  beforeAll(async () => {
    await warmup();
    const c = await prisma.case.create({
      data: { title: `下单用案例-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
      select: { id: true },
    });
    caseId = c.id;
    const s = await prisma.solution.create({
      data: { title: `下单用方案-${runId}`, slug: `it-ord-p-${runId}`, caseId, status: "PUBLISHED", price: "1999.00", currency: "CNY", publishedAt: new Date() },
      select: { id: true },
    });
    solutionId = s.id;
    const ds = await prisma.solution.create({
      data: { title: `草稿方案-${runId}`, slug: `it-ord-d-${runId}`, caseId, status: "DRAFT", price: "88.00" },
      select: { id: true },
    });
    draftSolutionId = ds.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => undefined);
    await prisma.order.deleteMany({ where: { solutionId: { in: [solutionId, draftSolutionId] } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { id: { in: [solutionId, draftSolutionId] } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: caseId } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog.deleteMany({ where: { entityId: { in: [...orderIds, solutionId, draftSolutionId, caseId] } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("金额服务端快照：客户端传入的 amount 被剥离，订单金额取方案价 1999.00", async () => {
    const res = await createOrder(
      // 故意夹带 amount/currency/status 试图篡改——schema 无这些字段应被忽略
      { solutionId, buyerEmail, amount: "0.01", currency: "USD", status: "PAID" } as never,
      "human:tester",
    );
    expect(res.status).toBe("ok");
    expect(res.order?.amount).toBe("1999.00");
    expect(res.order?.currency).toBe("CNY");
    expect(res.order?.amountDisplay).toBe("¥1999.00");
    expect(res.order?.status).toBe("PENDING"); // 客户端 status 不被采信
    track(res.orderId);
    expect(await countChanges(res.orderId!, "CREATE")).toBe(1);
  });

  it("缺身份（无 userId 也无 buyerEmail）→ invalid(identity)", async () => {
    const res = await createOrder({ solutionId } as never);
    expect(res.status).toBe("invalid");
    expect(res.fieldErrors?.identity).toBeDefined();
  });

  it("只能对 PUBLISHED 方案下单：DRAFT → blocked", async () => {
    const res = await createOrder({ solutionId: draftSolutionId, buyerEmail } as never);
    expect(res.status).toBe("blocked");
    expect(res.fieldErrors?.solutionId).toBeDefined();
  });

  it("不存在方案 → invalid.solutionId", async () => {
    const res = await createOrder({ solutionId: "c".repeat(24), buyerEmail } as never);
    expect(res.status).toBe("invalid");
    expect(res.fieldErrors?.solutionId).toBeDefined();
  });

  it("同买家同方案重复下单幂等复用 PENDING（不产生第二张单）", async () => {
    const first = await createOrder({ solutionId, buyerEmail } as never);
    const second = await createOrder({ solutionId, buyerEmail } as never);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(second.deduped).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    const rows = await prisma.order.count({ where: { solutionId, buyerEmail } });
    expect(rows).toBe(1);
  });

  it("confirmPaid：PENDING→PAID、paidAt 首次落库、version 自增、UPDATE 审计；再次确认幂等不刷新时间戳", async () => {
    const made = await createOrder({ solutionId, buyerEmail } as never);
    track(made.orderId);
    const confirmed = await confirmOrderPaid(made.orderId!, "human:admin");
    expect(confirmed.status).toBe("ok");
    expect(confirmed.order?.status).toBe("PAID");
    expect(confirmed.order?.paidAt).not.toBeNull();
    expect(confirmed.order?.version).toBe(2);
    expect(await countChanges(made.orderId!, "UPDATE")).toBe(1);
    const paidAt1 = confirmed.order!.paidAt!.getTime();

    const again = await confirmOrderPaid(made.orderId!, "human:admin");
    expect(again.status).toBe("ok");
    expect(again.deduped).toBe(true);
    expect(again.order!.paidAt!.getTime()).toBe(paidAt1); // 幂等，不刷新
  });

  it("已购买（PAID）再对同方案下单 → blocked（不重复收钱）", async () => {
    const made = await createOrder({ solutionId, buyerEmail: `paid-${runId}@example.com` } as never);
    track(made.orderId);
    await confirmOrderPaid(made.orderId!, "human:admin");
    const dup = await createOrder({ solutionId, buyerEmail: `paid-${runId}@example.com` } as never);
    expect(dup.status).toBe("blocked");
  });

  it("PAID 不可 cancel（仅 PENDING）；新 PENDING 可 cancel→CANCELED", async () => {
    const made = await createOrder({ solutionId, buyerEmail: `cx-${runId}@example.com` } as never);
    track(made.orderId);
    await confirmOrderPaid(made.orderId!, "human:admin");
    const cancelPaid = await cancelOrder(made.orderId!, "human:admin");
    expect(cancelPaid.status).toBe("blocked");

    const fresh = await createOrder({ solutionId, buyerEmail: `cxlive-${runId}@example.com` } as never);
    track(fresh.orderId);
    const cancelPending = await cancelOrder(fresh.orderId!, "human:admin");
    expect(cancelPending.status).toBe("ok");
    expect(cancelPending.order?.status).toBe("CANCELED");
  });

  it("hasPaidEntitlement：确认前 false、确认后按 email true；非属主 email 恒 false", async () => {
    const made = await createOrder({ solutionId, buyerEmail: otherEmail } as never);
    track(made.orderId);
    expect(await hasPaidEntitlement(solutionId, { email: otherEmail })).toBe(false);
    await confirmOrderPaid(made.orderId!, "human:admin");
    expect(await hasPaidEntitlement(solutionId, { email: otherEmail })).toBe(true);
    // 换一个从未下过单的邮箱，验证非属主不共享（buyerEmail 在前面的用例会真实 PAID，不能拿来当反例）
    const strangerEmail = `stranger-${runId}@example.com`;
    expect(await hasPaidEntitlement(solutionId, { email: strangerEmail })).toBe(false);
    expect(await hasPaidEntitlement(solutionId, {})).toBe(false); // 无身份保守 false
  });

  it("listOrdersForBuyer 按 email 找回名下订单；listOrdersForAdmin 可按状态过滤并分页自洽", async () => {
    const mine = await listOrdersForBuyer({ email: buyerEmail });
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((o) => o.solutionId === solutionId)).toBe(true);

    const paidOnly = await listOrdersForAdmin({ status: "PAID", page: 1, pageSize: 100 });
    expect(paidOnly.ok).toBe(true);
    expect(paidOnly.items.every((o) => o.status === "PAID")).toBe(true);
    expect(paidOnly.items.length).toBeLessThanOrEqual(100);
    expect(paidOnly.total).toBeGreaterThanOrEqual(paidOnly.items.length);

    const all = await listOrdersForAdmin({ page: 1, pageSize: 1 });
    expect(all.items.length).toBeLessThanOrEqual(1);
    expect(all.hasNext).toBe(all.total > 1);

    const one = await getOrderById(mine[0].id);
    expect(one.status).toBe("found");
    const missing = await getOrderById("c".repeat(24));
    expect(missing.status).toBe("not_found");
  });
});
