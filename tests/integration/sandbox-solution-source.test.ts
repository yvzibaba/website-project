import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { runSandboxModel } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { buildSandboxSolutionDraft } from "@/lib/sandbox-solution";
import { persistSandboxSolutionDraft } from "@/server/sandbox-solution-store";
import { createProject } from "@/server/sandbox-store";
import { findSolutionsBySandboxSource, verifySandboxSource } from "@/server/sandbox-solution-source";
import { SANDBOX_SOURCE_FIELD, readSandboxSourceFromFinancials } from "@/lib/sandbox-solution-source";
import { isSandboxSourcedSolution } from "@/lib/sandbox-solution-lineage";
import { verifyReproducibility } from "@/lib/sandbox-solution-provenance";

/**
 * 集成测试（真连 Neon，中途重构 R8.6 · 商业闭环「反查关联」端到端）：
 *   沙盘情景保存为项目（拿真 projectId/scenarioId）→ 导出产业方案时随草案上行来源指针 →
 *   服务端验存确有其行 → 指针并入 SolutionFinancial.assumptions.sandboxSource（★不破坏 R8.3 沙盘识别 / R8.4 可复算）→
 *   反查 findSolutionsBySandboxSource（scenario / project 两向）找回该方案。
 *
 * 关键实证（§12 可追溯 / §16 不破坏脊柱 / §20 诚实丢假指针）：
 *   - ★关联不伤脊柱：挂了指针后，落库行 `solutionCalcRef` 指纹仍在（isSandboxSourcedSolution 仍 true）、
 *     Decimal 列与 assumptions 源值仍可复算（verifyReproducibility allReproducible）——证不可变合并没覆盖溯源键。
 *   - ★验存：指向不存在情景的指针 → **诚实丢弃**（导出仍成功、进 warnings、行内无 sandboxSource），绝不让方案挂一条通往虚空 id 的假关联。
 *   - 反查两向都命中；查一个从没导出过的情景 → count 0（诚实空态）。
 * 身份走**已保存项目**（真情景行），隔离 runId 唯一，afterAll 按外键序清理（project 级联删 scenario / 手动删 solution/case/changeLog）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[sandbox-solution-source] DATABASE_URL not set — integration tests will be skipped.");
}

const runId = `it-sbxsrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
const createdProjectIds: string[] = [];
const actor = `human:${runId}`;

function sanitizeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function buildRealDraft() {
  const layers = {};
  const resolved = resolveSandbox(layers);
  const calc = runSandboxModel(layers);
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({ layers });
  const discountRate = (resolved.numeric["finance.discountRate"] ?? 8) / 100;
  const vm = buildSandboxViewModel({ calc, tech: tech && tech.ok ? tech.firstYear : null, tornado, discountRate });
  return buildSandboxSolutionDraft({ calc, vm, regionName: "山西", price: "12800.00", currency: "CNY" });
}

/** 建一个真沙盘项目（含基线情景），返回 projectId + scenarioId。 */
async function newSandboxProject(tag: string) {
  const res = await createProject({ name: `来源反查-${tag}-${runId}`, ownerId: null, initialLayers: {}, actor });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("project create failed");
  createdProjectIds.push(res.projectId);
  return { projectId: res.projectId, scenarioId: res.scenarioId };
}

/** 用真草案 + 真案例 + 可选来源指针落一条 DRAFT，返回 solutionId 与 persist 结果。 */
async function persistWithTag(tag: string, sandboxSource?: { scenarioId?: string; projectId?: string }) {
  const draft = buildRealDraft();
  expect(draft.ok).toBe(true);
  if (!draft.ok) throw new Error("draft not ok");
  const c = await prisma.case.create({
    data: { title: `来源-${tag}-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
  });
  createdCaseIds.push(c.id);
  const res = await persistSandboxSolutionDraft(
    {
      caseId: c.id,
      title: draft.title,
      slug: sanitizeSlug(`it-sbxsrc-${tag}-${runId}`),
      summary: draft.summary,
      body: draft.body,
      riskDomains: draft.riskDomains,
      needsProfessionalReview: draft.needsProfessionalReview,
      price: draft.price,
      currency: draft.currency,
      financials: draft.financials,
      unknowns: draft.unknowns,
      publishBlockers: draft.publishBlockers,
      ...(sandboxSource ? { sandboxSource } : {}),
    },
    actor,
  );
  if (res.solutionId) createdSolutionIds.push(res.solutionId);
  return { res, draft };
}

describeDb("sandbox-solution-source · 沙盘情景↔方案反查关联端到端（Neon Postgres）", () => {
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
    await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }).catch(() => undefined);
    await prisma.changeLog
      .deleteMany({
        where: {
          OR: [
            { entityId: { in: [...createdSolutionIds, ...createdCaseIds, ...createdProjectIds] } },
            { changedBy: actor },
          ],
        },
      })
      .catch(() => undefined);
    await disconnectPrisma();
  });

  it("①主链：保存情景→导出带指针→验存落库→反查两向命中 + ★关联不伤 R8.3/R8.4 脊柱", async () => {
    const { projectId, scenarioId } = await newSandboxProject("happy");
    const { res } = await persistWithTag("happy", { scenarioId, projectId });
    expect(res.status).toBe("ok");
    const solutionId = res.solutionId!;

    // 落库行 assumptions 里确有 sandboxSource，且指针两 id 齐全。
    const fin = await prisma.solutionFinancial.findFirst({ where: { solutionId }, select: { assumptions: true } });
    expect(fin).not.toBeNull();
    const ref = readSandboxSourceFromFinancials([{ assumptions: fin!.assumptions }]);
    expect(ref).not.toBeNull();
    expect(ref!.scenarioId).toBe(scenarioId);
    expect(ref!.projectId).toBe(projectId);

    // ★不破坏既有脊柱：沙盘指纹仍在 → isSandboxSourcedSolution true；Decimal/源值仍可复算。
    const finRow = await prisma.solutionFinancial.findFirst({
      where: { solutionId },
      select: { assumptions: true, calcRef: true, roiPct: true, irrPct: true, paybackYears: true },
    });
    const like = [{ calcRef: finRow!.calcRef, assumptions: finRow!.assumptions }];
    expect(isSandboxSourcedSolution(like)).toBe(true);
    const rep = verifyReproducibility({
      calcRef: finRow!.calcRef,
      assumptions: finRow!.assumptions,
      roiPct: finRow!.roiPct == null ? null : String(finRow!.roiPct),
      irrPct: finRow!.irrPct == null ? null : String(finRow!.irrPct),
      paybackYears: finRow!.paybackYears == null ? null : String(finRow!.paybackYears),
    } as never);
    expect(rep.reproducible).toBe(true);
    expect(rep.issues).toEqual([]);

    // 反查：按 scenarioId 命中。
    const byScen = await findSolutionsBySandboxSource({ scenarioId });
    expect(byScen.status).toBe("ok");
    if (byScen.status === "ok") {
      expect(byScen.count).toBeGreaterThanOrEqual(1);
      expect(byScen.items.some((x) => x.id === solutionId)).toBe(true);
    }
    // 反查：按 projectId 命中（同一方案）。
    const byProj = await findSolutionsBySandboxSource({ projectId });
    expect(byProj.status).toBe("ok");
    if (byProj.status === "ok") {
      expect(byProj.items.some((x) => x.id === solutionId)).toBe(true);
    }
    // 反查：两 id 都给，仍命中且回读指针吻合。
    const both = await findSolutionsBySandboxSource({ scenarioId, projectId });
    expect(both.status).toBe("ok");
    if (both.status === "ok") {
      const hit = both.items.find((x) => x.id === solutionId);
      expect(hit).toBeTruthy();
      expect(hit!.source?.scenarioId).toBe(scenarioId);
    }
  });

  it("②诚实丢假指针：指向不存在情景 → 导出仍成功但行内无 sandboxSource（+ warnings）", async () => {
    // 合法 cuid 形状但库里确无此情景/项目。
    const fakeScenario = "c" + "f".repeat(24);
    const fakeProject = "c" + "b".repeat(24);
    const { res } = await persistWithTag("fake", { scenarioId: fakeScenario, projectId: fakeProject });
    expect(res.status).toBe("ok"); // 导出主链不被卡住
    const solutionId = res.solutionId!;
    // 诚实：应有一条来源关联未附的 warning。
    expect((res.warnings ?? []).some((w) => w.includes("来源关联"))).toBe(true);

    const fin = await prisma.solutionFinancial.findFirst({ where: { solutionId }, select: { assumptions: true } });
    const a = fin!.assumptions as Record<string, unknown>;
    expect(a[SANDBOX_SOURCE_FIELD]).toBeUndefined(); // 绝不落一条通往虚空 id 的假关联
    // 但沙盘指纹仍在（草案自身写的）。
    expect(typeof a.solutionCalcRef).toBe("string");

    // 反查一个不存在的情景 → 空。
    const r = await findSolutionsBySandboxSource({ scenarioId: fakeScenario });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.count).toBe(0);
  });

  it("③验存函数直连：真情景 ok / 假情景 拒 / 情景项目不一致 拒", async () => {
    const { projectId, scenarioId } = await newSandboxProject("verify");
    const good = await verifySandboxSource({ scenarioId, projectId });
    expect(good.ok).toBe(true);
    expect(good.ref?.scenarioId).toBe(scenarioId);

    const missing = await verifySandboxSource({ scenarioId: "c" + "g".repeat(24) });
    expect(missing.ok).toBe(false);
    expect(missing.ref).toBeNull();
    expect(missing.note).toContain("不存在");

    // 情景真、项目假（张冠李戴）→ 拒，防错挂。
    const mismatch = await verifySandboxSource({ scenarioId, projectId: "c" + "h".repeat(24) });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.ref).toBeNull();

    // 无 id → 静默 null。
    const none = await verifySandboxSource({});
    expect(none.ok).toBe(false);
    expect(none.ref).toBeNull();
  });

  it("④未保存情景导出（不带指针）→ 行内无 sandboxSource、反查它为空", async () => {
    const { res } = await persistWithTag("nosrc");
    expect(res.status).toBe("ok");
    const fin = await prisma.solutionFinancial.findFirst({ where: { solutionId: res.solutionId! }, select: { assumptions: true } });
    expect((fin!.assumptions as Record<string, unknown>)[SANDBOX_SOURCE_FIELD]).toBeUndefined();
    // 无任何 (scenario/project) 反查会命中它。
    const { scenarioId, projectId } = { scenarioId: "c" + "q".repeat(24), projectId: "c" + "w".repeat(24) };
    const r = await findSolutionsBySandboxSource({ scenarioId, projectId });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.items.some((x) => x.id === res.solutionId)).toBe(false);
  });
});
