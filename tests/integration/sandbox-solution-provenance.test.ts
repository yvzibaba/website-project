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
import { evaluateSandboxSolutionProvenance, type FinancialLike } from "@/lib/sandbox-solution-provenance";

/**
 * 集成测试（真连 Neon，中途重构 R8.4）：实证沙盘来源方案的**溯源审计在真实数据库往返后仍站得住**——
 *   沙盘结果 → DRAFT（R8.2）→ 人工发布 → 公开详情页财务读回 → `evaluateSandboxSolutionProvenance`。
 *
 * 这是把 R8.4 纯函数「落在校验存量一致性」的承诺钉到**真 Decimal 列精度**上：
 *   - **公式可复算穿越真实列定点舍入**：草案把 roiPct/irrPct/paybackYears 写成 toFixed 串，落进
 *     Decimal(8,4)/(8,4)/(8,2)，Prisma 读回是「补零到列精度」的串（如 "400.3500"）——本审计须**数值带容差**判其
 *     与同行 assumptions 源值（roiRatio×100 等）一致（`allReproducible:true`），证明 §7「公式可复算」在落库后仍可取证。
 *   - **可追溯诚实为 0/N**：沙盘全新导出无 sourceUrl、evidenceKind=ASSUMPTION → `traceableCount:0`、
 *     `fullyTraceable:false`（§12/§20：没来源就绝不谎称可追溯）。
 *   - **篡改可被揪出**：直接改库把某条 roiPct 改成明显错值 → 再读回审计须 `allReproducible:false` 且点名 roiPct
 *     （证明本审计真能作「落库途中数字被动过」的事后取证，而非走过场的永真检查）。
 *
 * 刻意走**完整引擎链**造真草案（非手搓），使落库串 = App 真实上行值。身份走人工 actor；隔离：runId 唯一，afterAll 按 FK 序清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[sandbox-solution-provenance] DATABASE_URL not set — integration tests will be skipped.");
}

const runId = `it-sbxprov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
const actor = `human:${runId}`;

function sanitizeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

/** 引擎链造一份真草案并落成 DRAFT（带价以便发布），回 solutionId。 */
async function persistPublishedDraft(tag: string): Promise<string> {
  const layers = {};
  const resolved = resolveSandbox(layers);
  const calc = runSandboxModel(layers);
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({ layers });
  const discountRate = (resolved.numeric["finance.discountRate"] ?? 8) / 100;
  const vm = buildSandboxViewModel({ calc, tech: tech && tech.ok ? tech.firstYear : null, tornado, discountRate });
  const draft = buildSandboxSolutionDraft({ calc, vm, regionName: "山西", price: "19800.00", currency: "CNY" });
  expect(draft.ok).toBe(true);
  if (!draft.ok) throw new Error("draft not ok");

  const c = await prisma.case.create({
    data: { title: `溯源-${tag}-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
  });
  createdCaseIds.push(c.id);

  const res = await persistSandboxSolutionDraft(
    {
      caseId: c.id,
      title: draft.title,
      slug: sanitizeSlug(`it-sbxprov-${tag}-${runId}`),
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
  const solutionId = res.solutionId!;
  createdSolutionIds.push(solutionId);

  const pub = await updateSolution(solutionId, { status: "PUBLISHED" }, actor);
  expect(pub.status).toBe("ok");
  return solutionId;
}

describeDb("sandbox-solution-provenance · 沙盘来源方案溯源审计真 Neon 往返", () => {
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
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog
      .deleteMany({ where: { entityId: { in: [...createdSolutionIds, ...createdCaseIds] } } })
      .catch(() => undefined);
    await disconnectPrisma();
  });

  it("发布后读回财务：真实列舍入下仍可复算(allReproducible) + 可追溯诚实为 0/N", async () => {
    const solutionId = await persistPublishedDraft("roundtrip");
    const post = await getPublishedSolutionById(solutionId, false);
    expect(post.status).toBe("found");
    if (post.status !== "found") return;
    expect(post.data.status).toBe("PUBLISHED");

    // 详情页财务已是 Prisma Decimal 读回的补零串（如 "400.3500"）——审计须容忍列精度仍判一致。
    const fins = post.data.financials as unknown as FinancialLike[];
    expect(fins.length).toBeGreaterThanOrEqual(1);
    const roiStr = fins[0].roiPct;
    expect(typeof roiStr).toBe("string");

    const p = evaluateSandboxSolutionProvenance(fins);
    expect(p.financialCount).toBe(fins.length);
    expect(p.reproducibility.allReproducible).toBe(true);
    expect(p.reproducibility.issues).toEqual([]);
    // 沙盘全新导出无来源、仍 ASSUMPTION → 不可追溯（诚实，不谎称可追溯）。
    expect(p.traceability.traceableCount).toBe(0);
    expect(p.traceability.withSourceUrlCount).toBe(0);
    expect(p.traceability.fullyTraceable).toBe(false);
    expect(p.buyerSummary).toContain("复算");
  });

  it("篡改落库 roiPct → 再审计揪出复算异常（点名 roiPct，证明是真取证非永真检查）", async () => {
    const solutionId = await persistPublishedDraft("tamper");
    const post = await getPublishedSolutionById(solutionId, false);
    expect(post.status).toBe("found");
    if (post.status !== "found") return;
    const finId = post.data.financials[0].id;

    // 直接把库里的 roiPct 改成明显与源值对不上的值（模拟落库途中数字被动过）。
    await prisma.solutionFinancial.update({ where: { id: finId }, data: { roiPct: "999.9900" } });

    const re = await getPublishedSolutionById(solutionId, false);
    expect(re.status).toBe("found");
    if (re.status !== "found") return;
    const p = evaluateSandboxSolutionProvenance(re.data.financials as unknown as FinancialLike[]);
    expect(p.reproducibility.allReproducible).toBe(false);
    expect(p.reproducibility.issues.some((s) => s.includes("roiPct"))).toBe(true);
    expect(p.buyerSummary).toContain("对不上");
  });
});
