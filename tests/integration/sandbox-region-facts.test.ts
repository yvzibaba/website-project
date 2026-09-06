import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { runSandboxModel, type CalcResult } from "@/server/sandbox-model";
import type { ResolveLayers } from "@/server/parameter-engine";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { buildSandboxSolutionDraft } from "@/lib/sandbox-solution";
import { persistSandboxSolutionDraft } from "@/server/sandbox-solution-store";
import { upgradeSolutionFinancialProvenance } from "@/server/sandbox-provenance-store";
import { isSandboxSourcedSolution } from "@/lib/sandbox-solution-lineage";
import { evaluateSandboxSolutionProvenance, type FinancialLike } from "@/lib/sandbox-solution-provenance";

/**
 * 集成测试（真连 Neon，中途重构 R8.7 · 地区真实数据接入闭环真实化）：
 *   把某地区默认值（如山西工商业电价）在**真引擎链**上挂一个可核验 http(s) 来源 →
 *   解析层承认为逐值 FACT → `CalcResult.inputProvenance` 带出 → 方案草案行级 `sourceUrl` + `assumptions.inputProvenance` 落地 →
 *   原样 persist 进 `SolutionFinancial`（sourceUrl 列 + JSONB 都在）→ 再走 R8.5 升级写路径把该行 evidenceKind 升 FACT →
 *   `evaluateSandboxSolutionProvenance` 从 0/N 翻转为「可追溯」，且★全程不破坏 R8.3 来源识别 / R8.4 可复算脊柱。
 *
 * 关键诚实实证（§12 可追溯 / §16 单一真源 / §20 绝不把无来源的值当事实）：
 *   - 只有**合法 http(s)** 来源才让值经链贯通到 sourceUrl；脏链接（ftp）在解析层即被降级，
 *     草案根本不带 sourceUrl、落库该行 sourceUrl 仍 null——**接入机制不成为编造来源的后门**。
 *   - 生产地区编目现全为诚实 ASSUMPTION（见 `sandbox-region-facts`），故这些 FACT 由测试注入，
 *     证明「一旦人工核实到权威原文，仅需改编目即自动打通闭环」，非把未核数据伪造成 FACT。
 *
 * 隔离：runId 唯一；afterAll 按 FK 序清理 solution/case/changeLog。身份走人工 actor（route 层门禁另测）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[sandbox-region-facts] DATABASE_URL not set — integration tests will be skipped.");
}

const runId = `it-sbxfacts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
const actor = `human:${runId}`;

function sanitizeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

/** 用「带逐值 FACT 来源的山西地区层」走完整真引擎链造草案（layers 可注入 FACT/脏链接）。 */
function buildDraftWithRegionSources(layers: Omit<ResolveLayers, "derived">) {
  const resolved = resolveSandbox(layers);
  const calc: CalcResult = runSandboxModel(layers);
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({ layers });
  const discountRate = (resolved.numeric["finance.discountRate"] ?? 8) / 100;
  const vm = buildSandboxViewModel({ calc, tech: tech && tech.ok ? tech.firstYear : null, tornado, discountRate });
  return { calc, draft: buildSandboxSolutionDraft({ calc, vm, regionName: "山西", price: "15800.00", currency: "CNY" }) };
}

async function persistDraft(
  tag: string,
  draft: ReturnType<typeof buildDraftWithRegionSources>["draft"],
): Promise<string> {
  expect(draft.ok).toBe(true);
  if (!draft.ok) throw new Error("draft not ok");
  const c = await prisma.case.create({
    data: { title: `接入-${tag}-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
  });
  createdCaseIds.push(c.id);
  const res = await persistSandboxSolutionDraft(
    {
      caseId: c.id,
      title: draft.title,
      slug: sanitizeSlug(`it-sbxfacts-${tag}-${runId}`),
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
  return solutionId;
}

const FACT_URL = "https://fgw.example.gov.cn/shanxi-price-2024";

describeDb("sandbox-region-facts · 地区真实来源经引擎链→落库→R8.5 升级为可追溯 FACT（Neon）", () => {
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

  it("①合法来源：解析认 FACT → 草案带 sourceUrl → 落库列+JSONB → R8.5 升级翻转可追溯，且脊柱全程不破", async () => {
    const { calc, draft } = buildDraftWithRegionSources({
      region: {
        values: { "region.elecPrice": 0.55 },
        evidenceKind: "ASSUMPTION",
        sources: { "region.elecPrice": { sourceUrl: FACT_URL, evidenceKind: "FACT", confidence: 88, sourceType: "政府公告" } },
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    // 引擎链真的把逐值 FACT 带进了 CalcResult.inputProvenance。
    expect(calc.ok && calc.inputProvenance?.["region.elecPrice"]?.evidenceKind).toBe("FACT");

    const solutionId = await persistDraft("fact", draft);
    const row = await prisma.solutionFinancial.findFirst({
      where: { solutionId },
      select: { id: true, sourceUrl: true, calcRef: true, assumptions: true, roiPct: true, irrPct: true, paybackYears: true },
    });
    expect(row).not.toBeNull();
    // 草案的行级 sourceUrl 与逐输入溯源确实落库（sourceUrl 列 + assumptions JSONB）。
    expect(row!.sourceUrl).toBe(FACT_URL);
    const a = row!.assumptions as Record<string, unknown>;
    expect(!!(a.inputProvenance as Record<string, { evidenceKind: string }>)).toBe(true);
    expect((a.inputProvenance as Record<string, { evidenceKind: string; sourceUrl?: string }>)["region.elecPrice"].sourceUrl).toBe(FACT_URL);
    // 导出时行 evidenceKind 仍诚实留 ASSUMPTION（聚合尚有其它占位入参），升级前 0/N 可追溯。
    expect(a.evidenceKind).toBe("ASSUMPTION");

    const like = [{ calcRef: row!.calcRef, assumptions: row!.assumptions }] as FinancialLike[];
    expect(isSandboxSourcedSolution(like)).toBe(true); // ★R8.3 沙盘指纹没被新增键冲掉

    const before = await evaluateSandboxSolutionProvenance([
      {
        calcRef: row!.calcRef,
        assumptions: row!.assumptions,
        sourceUrl: row!.sourceUrl,
        roiPct: row!.roiPct == null ? null : String(row!.roiPct),
        irrPct: row!.irrPct == null ? null : String(row!.irrPct),
        paybackYears: row!.paybackYears == null ? null : String(row!.paybackYears),
      },
    ] as never);
    expect(before.reproducibility.allReproducible).toBe(true); // ★可复算脊柱未破
    expect(before.traceability.traceableCount).toBe(0); // evidenceKind 仍 ASSUMPTION → 未算可追溯

    // 经 R8.5 升级写路径（拿草案带出的真实链接）把该行升 FACT。
    const up = await upgradeSolutionFinancialProvenance(row!.id, { sourceUrl: FACT_URL, confidence: 88, note: "省发改委销售电价" }, actor);
    expect(up.status).toBe("ok");

    const after = await prisma.solutionFinancial.findFirstOrThrow({
      where: { id: row!.id },
      select: { calcRef: true, assumptions: true, sourceUrl: true, roiPct: true, irrPct: true, paybackYears: true },
    });
    const afterLike = [
      {
        calcRef: after.calcRef,
        assumptions: after.assumptions,
        sourceUrl: after.sourceUrl,
        roiPct: after.roiPct == null ? null : String(after.roiPct),
        irrPct: after.irrPct == null ? null : String(after.irrPct),
        paybackYears: after.paybackYears == null ? null : String(after.paybackYears),
      },
    ] as unknown as FinancialLike[];
    const pAfter = await evaluateSandboxSolutionProvenance(afterLike);
    expect(pAfter.traceability.traceableCount).toBe(1);
    expect(pAfter.traceability.fullyTraceable).toBe(true); // 本草案仅 1 条财务
    expect(pAfter.reproducibility.allReproducible).toBe(true); // ★升级没动 Decimal/源值
    expect(isSandboxSourcedSolution(afterLike)).toBe(true); // ★来源识别仍在（solutionCalcRef 被合并保留）
  });

  it("②接入机制不是编造来源的后门：脏链接（ftp）在解析层即降级 → 草案无 sourceUrl、落库 sourceUrl 仍 null", async () => {
    const { calc, draft } = buildDraftWithRegionSources({
      region: {
        values: { "region.elecPrice": 0.55 },
        sources: { "region.elecPrice": { sourceUrl: "ftp://not-http/x", evidenceKind: "FACT", confidence: 99 } },
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    // 解析层闸门：FACT 声称因缺合法链接被降级为 ASSUMPTION。
    expect(calc.ok && calc.inputProvenance?.["region.elecPrice"]?.evidenceKind).toBe("ASSUMPTION");
    expect(calc.ok && calc.inputProvenance?.["region.elecPrice"]?.sourceUrl).toBeUndefined();
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.financials[0].sourceUrl).toBeUndefined();
    expect((draft.financials[0].assumptions as Record<string, unknown>).inputProvenance).toBeUndefined();

    const solutionId = await persistDraft("dirty", draft);
    const row = await prisma.solutionFinancial.findFirst({ where: { solutionId }, select: { sourceUrl: true, assumptions: true } });
    expect(row!.sourceUrl).toBeNull(); // 绝不把脏来源写进可追溯列
    expect((row!.assumptions as Record<string, unknown>).inputProvenance).toBeUndefined();
  });
});
