import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { runSandboxModel } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { buildSandboxSolutionDraft } from "@/lib/sandbox-solution";
import { persistSandboxSolutionDraft } from "@/server/sandbox-solution-store";
import { updateSolution } from "@/server/solution-admin";
import { getPublishedSolutionById } from "@/server/solutions";
import { createOrder, confirmOrderPaid, hasPaidEntitlement } from "@/server/orders";
import { describeSandboxLineage } from "@/lib/sandbox-solution-lineage";

/**
 * 集成测试（真连 Neon，中途重构 R8.3）：端到端实证沙盘来源方案的**商业闭环真跑通**——
 *   沙盘结果 → 产业方案 DRAFT（R8.2）→ 人工发布（publishGuard）→ 公开详情页可见 + 沙盘溯源可识别 →
 *   下单（金额服务端快照、不可被客户端篡改）→ 后台确认到账 → 解锁门控翻转（hasPaidEntitlement）。
 *
 * 这条链正是总控第一优先级「商业闭环」对沙盘输出的收口，也是 §17 式「E2E 实证 > 逐块单测」的兑现：
 *   - **绝不自动发布**：草案落库恒 DRAFT，`getPublishedSolutionById` 在发布前必 not_found（§10 高风险默认禁公开）。
 *   - **发布须真过 publishGuard**：无价格沙盘方案想直接置 PUBLISHED → blocked 点名 price（不可绕过后门上架）。
 *   - **购买与解锁闭环成立**：仅 PUBLISHED 且定价的方案可下单；金额来自服务端读价快照；PAID 才翻转 entitlement。
 *   - **详情页诚实声明有数可依**：发布后 `describeSandboxLineage(公开详情财务)` 应识别为沙盘来源（供 §16/§20 声明）。
 *
 * 刻意走**完整引擎链**造真草案（非手搓），使落库 Decimal 串 = App 真实上行值，覆盖列精度/JSONB/FK/级联/ChangeLog。
 * 身份走**游客 buyerEmail**（避免额外建 User 行；entitlement 按归一邮箱匹配）。隔离：runId 唯一；afterAll 按外键序清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[sandbox-solution-loop] DATABASE_URL not set — integration tests will be skipped.");
}

const runId = `it-sbxloop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
const createdOrderIds: string[] = [];
const actor = `human:${runId}`;
const buyerEmail = `buyer-${runId}@example.test`.toLowerCase();

function sanitizeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

/** 引擎链造一份真草案：resolve→run→tech→tornado→view→draft。 */
function buildRealDraft(price: string | undefined) {
  const layers = {};
  const resolved = resolveSandbox(layers);
  const calc = runSandboxModel(layers);
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({ layers });
  const discountRate = (resolved.numeric["finance.discountRate"] ?? 8) / 100;
  const vm = buildSandboxViewModel({ calc, tech: tech && tech.ok ? tech.firstYear : null, tornado, discountRate });
  const draft = buildSandboxSolutionDraft({ calc, vm, regionName: "山西", price, currency: "CNY" });
  return { calc, vm, draft };
}

/** 把真草案（+ 真案例）落成 DRAFT，回 solutionId。 */
async function persistDraft(tag: string, price: string | undefined) {
  const { draft } = buildRealDraft(price);
  expect(draft.ok).toBe(true);
  if (!draft.ok) throw new Error("draft not ok");
  const c = await prisma.case.create({
    data: { title: `闭环-${tag}-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
  });
  createdCaseIds.push(c.id);
  const res = await persistSandboxSolutionDraft(
    {
      caseId: c.id,
      title: draft.title,
      slug: sanitizeSlug(`it-sbxloop-${tag}-${runId}`),
      summary: draft.summary,
      body: draft.body,
      riskDomains: draft.riskDomains,
      needsProfessionalReview: draft.needsProfessionalReview,
      price: draft.price,
      currency: draft.currency,
      financials: draft.financials,
      unknowns: draft.unknowns,
      publishBlockers: draft.publishBlockers,
    },
    actor,
  );
  expect(res.status).toBe("ok");
  createdSolutionIds.push(res.solutionId!);
  return { solutionId: res.solutionId!, draft };
}

describeDb("sandbox-solution-loop · 沙盘来源方案端到端商业闭环（Neon Postgres）", () => {
  beforeAll(async () => {
    for (let i = 0; i < 4; i++) {
      try {
        await prisma.$queryRaw`SELECT 1`;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.order.deleteMany({ where: { solutionId: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog
      .deleteMany({ where: { entityId: { in: [...createdSolutionIds, ...createdCaseIds, ...createdOrderIds] } } })
      .catch(() => undefined);
    await disconnectPrisma();
  });

  it("主链：DRAFT(不可见)→发布(过 publishGuard)→公开可见+沙盘溯源→下单(服务端金额)→确认到账→解锁翻转", async () => {
    const price = "19800.00";
    const { solutionId } = await persistDraft("happy", price);

    // ① 发布前：DRAFT 绝不公开可见（§10：高风险/未审默认禁 AI 自动公开）。
    const pre = await getPublishedSolutionById(solutionId, false);
    expect(pre.status).toBe("not_found");

    // ② 人工发布（仅切状态；价格/需专业确认已在草案里，publishGuard 应放行）。
    const pub = await updateSolution(solutionId, { status: "PUBLISHED" }, actor);
    expect(pub.status).toBe("ok");

    // ③ 发布后公开可见，且财务带沙盘指纹 → 详情页可据 lineage 挂诚实声明（§16/§20）。
    const post = await getPublishedSolutionById(solutionId, false);
    expect(post.status).toBe("found");
    if (post.status !== "found") return;
    expect(post.data.status).toBe("PUBLISHED");
    expect(post.data.isFree).toBe(false);
    expect(post.data.needsProfessionalReview).toBe(true);
    expect(post.data.financials.some((f) => f.calcRef === "model@1.0.0")).toBe(true);
    const lineage = describeSandboxLineage(post.data.financials);
    expect(lineage).not.toBeNull();
    expect(lineage?.draftVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lineage?.evidenceKind).toBe("ASSUMPTION");

    // ④ 未下单 → 无解锁权益。
    expect(await hasPaidEntitlement(solutionId, { email: buyerEmail })).toBe(false);

    // ⑤ 下单：金额须由服务端读价快照（游客仅带 solutionId + buyerEmail）。
    const order = await createOrder({ solutionId, buyerEmail }, actor);
    expect(order.status).toBe("ok");
    expect(order.orderId).toBeTruthy();
    createdOrderIds.push(order.orderId!);
    const o = await prisma.order.findUnique({ where: { id: order.orderId! } });
    expect(o).not.toBeNull();
    expect(o!.status).toBe("PENDING");
    expect(Number(o!.amount)).toBeCloseTo(19800, 2);
    expect(o!.currency).toBe("CNY");

    // ⑥ PENDING 尚未到账 → 仍不解锁（付费交付物只在 PAID 后放开）。
    expect(await hasPaidEntitlement(solutionId, { email: buyerEmail })).toBe(false);

    // ⑦ 后台确认到账（PENDING→PAID）→ 解锁门控翻转 = 闭环合上。
    const confirm = await confirmOrderPaid(order.orderId!, actor);
    expect(confirm.status).toBe("ok");
    expect(await hasPaidEntitlement(solutionId, { email: buyerEmail })).toBe(true);

    // ⑧ 已拥有 → 再下单被拦截（不重复售卖，且指向已购提示）。
    const again = await createOrder({ solutionId, buyerEmail }, actor);
    expect(again.status).toBe("blocked");

    // ⑨ 审计留痕：Solution CREATE + Order 相关 ChangeLog 均在。
    const solCreate = await prisma.changeLog.count({
      where: { entityType: "Solution", entityId: solutionId, action: "CREATE" },
    });
    expect(solCreate).toBe(1);
    const orderLogs = await prisma.changeLog.count({ where: { entityId: order.orderId! } });
    expect(orderLogs).toBeGreaterThanOrEqual(1);
  });

  it("发布后门：无价格沙盘方案直接置 PUBLISHED → 被 publishGuard 拦停在 blocked（点名 price，不自动上架）", async () => {
    const { solutionId } = await persistDraft("noprice", undefined); // 草案未定价

    const pub = await updateSolution(solutionId, { status: "PUBLISHED" }, actor);
    expect(pub.status).toBe("blocked");
    expect(pub.fieldErrors?.price?.length).toBeGreaterThan(0);

    // 被拦停后仍非公开可见。
    const view = await getPublishedSolutionById(solutionId, false);
    expect(view.status).toBe("not_found");

    // 也无法下单（未发布）。
    const order = await createOrder({ solutionId, buyerEmail }, actor);
    expect(order.status).toBe("blocked");
  });
});
