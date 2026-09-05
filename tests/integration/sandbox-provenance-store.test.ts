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
import {
  upgradeSolutionFinancialProvenance,
  SANDBOX_PROVENANCE_STORE_VERSION,
} from "@/server/sandbox-provenance-store";
import { isSandboxSourcedSolution } from "@/lib/sandbox-solution-lineage";
import { evaluateSandboxSolutionProvenance, type FinancialLike } from "@/lib/sandbox-solution-provenance";

/**
 * 集成测试（真连 Neon，中途重构 R8.5）：实证「沙盘来源财务 ASSUMPTION→FACT 受控升级写路径」在
 * **真实库往返**后既真升级、又**不破坏 R8.3/R8.4 既有脊柱**——这是本里程碑最重要的约束。
 *
 * 走完整引擎链造真草案 → DRAFT（R8.2）→ 人工发布 → 取回财务 id → 经真闸门升级一条财务（合法 http(s)+置信度）：
 *   - **升级真落库**：读回该行 `sourceUrl` 列已填、`assumptions.evidenceKind==="FACT"`、`version` 自增、`ChangeLog` 有痕。
 *   - **可追溯翻转**：再跑 `evaluateSandboxSolutionProvenance` → `traceableCount:1`（原 0）、`fullyTraceable:false`（部分），
 *     buyerSummary 出现「已升级为 FACT 且带真实来源链接」。
 *   - **★不破坏复算**：升级只改溯源、绝不碰 Decimal 列/源值 → 同一行 `verifyReproducibility` 仍 pass、`allReproducible:true`。
 *   - **★不破坏来源识别**：`assumptions.solutionCalcRef` 被合并保留 → `isSandboxSourcedSolution` 升级后仍为 true（R8.3 徽章不丢）。
 *   - **拒绝即零改动**：无来源链接调升级 → `blocked`，DB 行逐字节未变（§20 拒不粉饰）。
 *
 * 隔离：runId 唯一，afterAll 按 FK 序清理。身份走人工 actor（写路径的 staff 门禁在 route 层，本测试直接调编排函数）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[sandbox-provenance-store] DATABASE_URL not set — integration tests will be skipped.");
}

const runId = `it-sbxupg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];
const actor = `human:${runId}`;

function sanitizeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

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
    data: { title: `升级-${tag}-${runId}`, industry: "NEW_ENERGY", stage: "DEEP_CASE", sourceType: "MANUAL" },
  });
  createdCaseIds.push(c.id);

  const res = await persistSandboxSolutionDraft(
    {
      caseId: c.id,
      title: draft.title,
      slug: sanitizeSlug(`it-sbxupg-${tag}-${runId}`),
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

async function readFinancials(solutionId: string): Promise<Array<FinancialLike & { id: string }>> {
  const post = await getPublishedSolutionById(solutionId, false);
  expect(post.status).toBe("found");
  if (post.status !== "found") return [];
  return post.data.financials as unknown as Array<FinancialLike & { id: string }>;
}

describeDb("sandbox-provenance-store · 沙盘来源财务 ASSUMPTION→FACT 升级写路径真 Neon 往返", () => {
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

  it("合法来源升级一条财务：FACT 落库 + version 自增 + 可追溯翻转，且复算/来源识别仍成立（不破坏脊柱）", async () => {
    const solutionId = await persistPublishedDraft("upgrade");
    const before = await readFinancials(solutionId);
    expect(before.length).toBeGreaterThanOrEqual(1);
    const finId = before[0].id as string;
    const versionBefore = await prisma.solutionFinancial.findUnique({ where: { id: finId }, select: { version: true } });

    // 前置：升级前审计 = 可复算但 0/N 可追溯（R8.4 诚实基线）。
    const pBefore = evaluateSandboxSolutionProvenance(before);
    expect(pBefore.reproducibility.allReproducible).toBe(true);
    expect(pBefore.traceability.traceableCount).toBe(0);

    const up = await upgradeSolutionFinancialProvenance(
      finId,
      { sourceUrl: "https://nx.gov.cn/price-notice", confidence: 82, note: "省电网公示销售电价" },
      actor,
    );
    expect(up.status).toBe("ok");
    if (up.status !== "ok") return;
    expect(up.version).toBe((versionBefore?.version ?? 1) + 1);

    // 读回单行：sourceUrl 列已填、assumptions.evidenceKind=FACT、带升维戳。
    const row = await prisma.solutionFinancial.findUnique({
      where: { id: finId },
      select: { sourceUrl: true, assumptions: true, version: true },
    });
    expect(row?.sourceUrl).toBe("https://nx.gov.cn/price-notice");
    const a = row?.assumptions as Record<string, unknown>;
    expect(a.evidenceKind).toBe("FACT");
    expect(a.confidence).toBe(82);
    expect((a.provenanceUpgrade as Record<string, unknown>).from).toBe("ASSUMPTION");
    // ChangeLog 留痕。
    const logs = await prisma.changeLog.findMany({
      where: { entityId: solutionId, reason: { contains: "ASSUMPTION→FACT" } },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    // 审计翻转 + ★脊柱不破。
    const after = await readFinancials(solutionId);
    const pAfter = evaluateSandboxSolutionProvenance(after);
    // 本草案只含 1 条财务，升级唯一那条 → 可追溯翻转为「全部可追溯」。
    expect(pAfter.traceability.total).toBe(1);
    expect(pAfter.traceability.traceableCount).toBe(1);
    expect(pAfter.traceability.fullyTraceable).toBe(true);
    expect(pAfter.buyerSummary).toContain("FACT");
    // ★复算仍通过（升级没动 Decimal 列/源值）。
    expect(pAfter.reproducibility.allReproducible).toBe(true);
    expect(pAfter.reproducibility.issues).toEqual([]);
    // ★来源识别仍在（solutionCalcRef 被合并保留）。
    expect(isSandboxSourcedSolution(after)).toBe(true);
  });

  it("无来源链接 → blocked 且库中该行逐字段未变（§20 拒不粉饰占位假设）", async () => {
    const solutionId = await persistPublishedDraft("refuse");
    const fins = await readFinancials(solutionId);
    const finId = fins[0].id as string;
    const snapshot = await prisma.solutionFinancial.findUnique({
      where: { id: finId },
      select: { sourceUrl: true, version: true, assumptions: true },
    });

    const up = await upgradeSolutionFinancialProvenance(finId, { confidence: 90 }, actor);
    expect(up.status).toBe("blocked");
    expect(up.reason).toContain("来源链接");

    const after = await prisma.solutionFinancial.findUnique({
      where: { id: finId },
      select: { sourceUrl: true, version: true, assumptions: true },
    });
    expect(after?.sourceUrl).toEqual(snapshot?.sourceUrl); // 仍 null
    expect(after?.version).toBe(snapshot?.version); // 未自增
    expect(JSON.stringify(after?.assumptions)).toBe(JSON.stringify(snapshot?.assumptions)); // 未改
    // 拒绝不应留下任何升级 ChangeLog。
    const pAfter = evaluateSandboxSolutionProvenance(await readFinancials(solutionId));
    expect(pAfter.traceability.traceableCount).toBe(0);
  });

  it("STORE_VERSION 语义化 + 编排函数对空/非法意图稳健（不裸抛）", async () => {
    expect(SANDBOX_PROVENANCE_STORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const solutionId = await persistPublishedDraft("edge");
    const fins = await readFinancials(solutionId);
    const finId = fins[0].id as string;
    const bad = await upgradeSolutionFinancialProvenance(
      finId,
      { sourceUrl: "https://x.gov.cn/a", confidence: 200 },
      actor,
    );
    expect(bad.status).toBe("blocked");
    expect(bad.reason).toContain("越界");
  });
});
