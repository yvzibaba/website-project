import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  createSolution,
  updateSolution,
  deleteSolution,
  addSolutionFinancial,
  removeSolutionFinancial,
  addSolutionUnknown,
  removeSolutionUnknown,
} from "@/server/solution-admin";

/**
 * 集成测试：方案数据层 CRUD（Phase 8 M1），真连 Neon，不 mock。
 *
 * 覆盖：createSolution（成功 / slug 冲突 / 缺 case / 强制 DRAFT）、updateSolution
 * （version 自增 + ChangeLog / 空 patch 拒绝 / 不存在 not_found / slug 冲突）、
 * publishGuard（无价格 blocked / 高风险域未勾 review blocked / 全通过则落 publishedAt）、
 * deleteSolution（有 Order 时 blocked / 无 Order 时级联删 financials+unknowns）、
 * addSolutionFinancial / removeSolutionFinancial、addSolutionUnknown / removeSolutionUnknown
 * （unknownVariableCount 自动同步）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[solution-admin] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-sol-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const slugFor = (label: string) => `${label}-${runId.slice(-8)}`.toLowerCase();

const createdSolutionIds: string[] = [];
const createdCaseIds: string[] = [];
const createdOrderIds: string[] = [];

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

async function newCase(title: string): Promise<string> {
  const c = await prisma.case.create({
    data: { title, industry: "OTHER", stage: "DEEP_CASE" },
    select: { id: true },
  });
  createdCaseIds.push(c.id);
  return c.id;
}

function countChanges(solutionId: string, action: "CREATE" | "UPDATE" | "DELETE") {
  return prisma.changeLog.count({ where: { entityType: "Solution", entityId: solutionId, action } });
}

describeDb("solution data-layer CRUD (Neon)", () => {
  beforeAll(async () => {
    await warmup();
  });

  afterAll(async () => {
    // 严格按外键序：order → solution → case；changeLog 兜底按 entityId 清；再 runId 兜底
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { slug: { contains: runId.slice(-8).toLowerCase() } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    if (createdSolutionIds.length) {
      await prisma.changeLog.deleteMany({ where: { entityType: "Solution", entityId: { in: createdSolutionIds } } }).catch(() => undefined);
    }
    await disconnectPrisma().catch(() => undefined);
  });

  /* ───── 1. createSolution 成功 + 强制 DRAFT + CREATE 审计 ───── */
  it("creates a DRAFT solution and writes CREATE ChangeLog", async () => {
    const caseId = await newCase(`case-for-sol-${runId}`);
    const res = await createSolution(
      { title: `方案A ${runId}`, slug: slugFor("solA"), caseId, summary: "摘要", price: "1999.00" },
      `human:${runId}`,
    );
    expect(res.status).toBe("ok");
    expect(res.solutionId).toBeTruthy();
    createdSolutionIds.push(res.solutionId!);

    const row = await prisma.solution.findUnique({ where: { id: res.solutionId! } });
    expect(row?.status).toBe("DRAFT");
    expect(row?.currency).toBe("CNY");
    expect(row?.version).toBe(1);
    expect(row?.publishedAt).toBeNull();
    // Prisma Decimal.toString() 会去掉尾零（"1999.00"→"1999"），用 toFixed 比对
    expect(row?.price?.toFixed?.(2) ?? null).toBe("1999.00");

    expect(await countChanges(res.solutionId!, "CREATE")).toBe(1);
  });

  /* ───── 2. createSolution：slug 冲突 → invalid（P2002 归一） ───── */
  it("rejects duplicate slug as invalid (unique P2002 mapped)", async () => {
    const caseId = await newCase(`case-dup-${runId}`);
    const slug = slugFor("dupSlug");
    const first = await createSolution({ title: `first ${runId}`, slug, caseId });
    expect(first.status).toBe("ok");
    if (first.solutionId) createdSolutionIds.push(first.solutionId);

    const dup = await createSolution({ title: `dup ${runId}`, slug, caseId });
    expect(dup.status).toBe("invalid");
    expect(dup.fieldErrors?.slug?.[0]).toMatch(/已被占用/);
  });

  /* ───── 3. createSolution：case 不存在 → invalid + fieldErrors.caseId ───── */
  it("rejects non-existent case reference", async () => {
    // 合法 cuid 格式但库里不存在（走 FK 预检分支，非 schema regex 拒绝）
    const fakeId = "c" + "z".repeat(25);
    const res = await createSolution({
      title: `orphan ${runId}`,
      slug: slugFor("orphan"),
      caseId: fakeId,
    });
    expect(res.status).toBe("invalid");
    expect(res.fieldErrors?.caseId?.[0]).toMatch(/不存在/);
  });

  /* ───── 4. updateSolution：version 自增 + UPDATE 审计；空 patch → invalid；未知 id → not_found ───── */
  it("bumps version + logs UPDATE, rejects empty patch, not_found for unknown id", async () => {
    const caseId = await newCase(`case-upd-${runId}`);
    const created = await createSolution({ title: `待改 ${runId}`, slug: slugFor("upd"), caseId });
    expect(created.status).toBe("ok");
    const id = created.solutionId!;
    createdSolutionIds.push(id);

    const upd = await updateSolution(id, { summary: "新摘要", needsProfessionalReview: true }, `human:${runId}`);
    expect(upd.status).toBe("ok");
    const row = await prisma.solution.findUnique({ where: { id } });
    expect(row?.version).toBe(2);
    expect(row?.summary).toBe("新摘要");
    expect(row?.needsProfessionalReview).toBe(true);
    expect(await countChanges(id, "UPDATE")).toBe(1);

    const empty = await updateSolution(id, {});
    expect(empty.status).toBe("invalid");

    const notFound = await updateSolution("cuid_not_there_xxxxxxxxxxxxxxxxxxxxxxxxx", { title: "x" });
    expect(notFound.status).toBe("not_found");
  });

  /* ───── 5. publishGuard：无价格 → blocked ───── */
  it("blocks publish when price is missing", async () => {
    const caseId = await newCase(`case-noprice-${runId}`);
    const created = await createSolution({ title: `无价 ${runId}`, slug: slugFor("noprice"), caseId });
    const id = created.solutionId!;
    createdSolutionIds.push(id);

    const res = await updateSolution(id, { status: "PUBLISHED" });
    expect(res.status).toBe("blocked");
    expect(res.fieldErrors?.price?.[0]).toMatch(/必须填写价格/);

    const row = await prisma.solution.findUnique({ where: { id } });
    expect(row?.status).toBe("DRAFT"); // 未变更
    expect(row?.publishedAt).toBeNull();
  });

  /* ───── 6. publishGuard：有 riskDomains 但未勾 needsProfessionalReview → blocked（宪法第 21 条） ───── */
  it("blocks publish when riskDomains listed but needsProfessionalReview=false", async () => {
    const caseId = await newCase(`case-risk-${runId}`);
    const created = await createSolution({
      title: `能源医疗 ${runId}`,
      slug: slugFor("risk"),
      caseId,
      price: "888.00",
      riskDomains: ["能源", "医疗"],
      // 故意不勾 needsProfessionalReview
    });
    const id = created.solutionId!;
    createdSolutionIds.push(id);

    const res = await updateSolution(id, { status: "PUBLISHED" });
    expect(res.status).toBe("blocked");
    expect(res.fieldErrors?.needsProfessionalReview?.[0]).toMatch(/高风险领域/);
  });

  /* ───── 7. 全条件满足 → PUBLISHED 且 publishedAt 落库、重复发布不刷新 publishedAt ───── */
  it("publishes with price+review-guard, stamps publishedAt once", async () => {
    const caseId = await newCase(`case-pub-${runId}`);
    const created = await createSolution({
      title: `可发布 ${runId}`,
      slug: slugFor("pub"),
      caseId,
      price: "2999.00",
      riskDomains: ["投资"],
      needsProfessionalReview: true,
    });
    const id = created.solutionId!;
    createdSolutionIds.push(id);

    const res = await updateSolution(id, { status: "PUBLISHED" }, `human:${runId}`);
    expect(res.status).toBe("ok");
    const published = await prisma.solution.findUnique({ where: { id } });
    expect(published?.status).toBe("PUBLISHED");
    expect(published?.publishedAt).not.toBeNull();
    const firstStamp = published!.publishedAt!.getTime();

    // 二次改字段（非发布）不动 publishedAt
    const res2 = await updateSolution(id, { summary: "补充摘要" });
    expect(res2.status).toBe("ok");
    const again = await prisma.solution.findUnique({ where: { id } });
    expect(again?.publishedAt?.getTime()).toBe(firstStamp);
  });

  /* ───── 8. deleteSolution：有 Order → blocked；无 Order → 级联删 financials + unknowns ───── */
  it("delete guards on orders, otherwise cascades financials+unknowns", async () => {
    const caseId = await newCase(`case-del-${runId}`);
    const created = await createSolution({
      title: `待删 ${runId}`,
      slug: slugFor("del"),
      caseId,
      price: "100.00",
    });
    const id = created.solutionId!;
    createdSolutionIds.push(id);

    // 先挂一条财务 + 一条未知，验证级联
    const fin = await addSolutionFinancial(id, { capex: "50.00", revenueAnnual: "200.00", note: "夹具" });
    expect(fin.status).toBe("ok");
    const unk = await addSolutionUnknown(id, { name: "政策落地时点", impact: "回款周期", severity: 60 });
    expect(unk.status).toBe("ok");
    const beforeCounts = await prisma.solution.findUnique({
      where: { id },
      select: { _count: { select: { financials: true, unknowns: true } }, unknownVariableCount: true },
    });
    expect(beforeCounts?._count.financials).toBe(1);
    expect(beforeCounts?._count.unknowns).toBe(1);
    expect(beforeCounts?.unknownVariableCount).toBe(1);

    // 挂 Order → blocked
    const order = await prisma.order.create({
      data: {
        solutionId: id,
        buyerName: "测试买家",
        buyerEmail: `${runId}@example.com`,
        buyerType: "INDIVIDUAL",
        amount: "100.00",
        currency: "CNY",
        status: "PENDING",
      },
      select: { id: true },
    });
    createdOrderIds.push(order.id);

    const blocked = await deleteSolution(id, `human:${runId}`);
    expect(blocked.status).toBe("blocked");
    expect(blocked.fieldErrors?.orders?.[0]).toMatch(/仍有 1 条订单/);
    expect(await prisma.solution.findUnique({ where: { id } })).not.toBeNull();

    // 撤单后再删：应成功并级联
    await prisma.order.delete({ where: { id: order.id } });
    createdOrderIds.splice(createdOrderIds.indexOf(order.id), 1);
    const ok = await deleteSolution(id, `human:${runId}`);
    expect(ok.status).toBe("ok");
    expect(await prisma.solution.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.solutionFinancial.count({ where: { solutionId: id } })).toBe(0);
    expect(await prisma.unknownVariable.count({ where: { solutionId: id } })).toBe(0);
    expect(await countChanges(id, "DELETE")).toBe(1);

    // 从清理列表剔除（已删）
    const idx = createdSolutionIds.indexOf(id);
    if (idx >= 0) createdSolutionIds.splice(idx, 1);
  });

  /* ───── 9. removeSolutionFinancial + removeSolutionUnknown 归属回查 + 计数回写 ───── */
  it("removes nested financial/unknown by their id and resyncs unknownVariableCount", async () => {
    const caseId = await newCase(`case-nested-${runId}`);
    const created = await createSolution({ title: `嵌套 ${runId}`, slug: slugFor("nested"), caseId });
    const id = created.solutionId!;
    createdSolutionIds.push(id);

    const f1 = await addSolutionFinancial(id, { capex: "10.00" });
    const u1 = await addSolutionUnknown(id, { name: "变量1", severity: 30 });
    const u2 = await addSolutionUnknown(id, { name: "变量2", severity: 40 });
    expect([f1.status, u1.status, u2.status]).toEqual(["ok", "ok", "ok"]);

    let s = await prisma.solution.findUnique({ where: { id }, select: { unknownVariableCount: true } });
    expect(s?.unknownVariableCount).toBe(2);

    const rf1 = await removeSolutionFinancial(f1.financialId!, `human:${runId}`);
    expect(rf1.status).toBe("ok");
    expect(rf1.solutionId).toBe(id);
    expect(await prisma.solutionFinancial.count({ where: { solutionId: id } })).toBe(0);

    const ru1 = await removeSolutionUnknown(u1.unknownId!, `human:${runId}`);
    expect(ru1.status).toBe("ok");
    s = await prisma.solution.findUnique({ where: { id }, select: { unknownVariableCount: true } });
    expect(s?.unknownVariableCount).toBe(1); // 剩 u2

    const ru2 = await removeSolutionUnknown(u2.unknownId!);
    expect(ru2.status).toBe("ok");
    s = await prisma.solution.findUnique({ where: { id }, select: { unknownVariableCount: true } });
    expect(s?.unknownVariableCount).toBe(0);

    // 不存在的 id
    const notFound = await removeSolutionUnknown("cuid_missing_xxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(notFound.status).toBe("not_found");
  });
});
