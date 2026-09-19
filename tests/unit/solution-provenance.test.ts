/**
 * 沙盘「来源方案」溯源审计与升级契约纯函数黄金样本（中途重构 R8.4 · 商业闭环第四块：可追溯数据治理脊柱）。
 *
 * 关键锁定（§7 公式可复算 / §12 来源可追溯 / §16/§20 诚实 / 反漂移）：
 *   - 版本语义化；auditRef = provenanceCalcRef()。
 *   - verifyReproducibility：把「落库 Decimal 串」与「同行 assumptions 源值经确定换算」逐一带容差比对；
 *     命中即 pass；被篡改（偏差超容差）→ 点名 issue；源值或缺落库串缺失 → 诚实 skip（不判失败）。
 *   - summarizeTraceability：可追溯 = evidenceKind==="FACT" **且** 带合法 http(s) 来源链接（两者缺一即不可追溯）；
 *     ASSUMPTION 即便贴了链接也不算 FACT；FACT 无链接也不算。
 *   - evaluateSolutionProvenance：合并两轴 + 一句话买家摘要；空数组回诚实空态（不臆断为可追溯）。
 *   - planProvenanceUpgrade：合法 http(s) 链接 + [0,100] 数值置信度 → FACT；否则保留 ASSUMPTION 并**给原因**，
 *     绝不擅自把占位假设粉饰成事实（§16/§20，本函数不落库）。
 *   - ★反漂移：喂 **R8.1 真实草案**（真引擎链产出）→ 复算必通过（写侧 toFixed 与读侧换算同一套口径）；
 *     确定性（同输入两次深相等）。
 */
import { describe, it, expect } from "vitest";
import {
  verifyReproducibility,
  summarizeTraceability,
  evaluateSolutionProvenance,
  planProvenanceUpgrade,
  isUsableSourceUrl,
  provenanceCalcRef,
  SOLUTION_PROVENANCE_VERSION,
  type FinancialLike,
} from "@app/kernel/lib/solution-provenance";
import { buildSolutionDraft } from "@app/kernel/lib/solution-draft";
import { buildDecisionViewModel } from "@app/kernel/lib/decision-view";
import { runProjectModelBaseline } from "@app/kernel/server/project-model";
import { resolveProjectParams } from "@app/kernel/server/project-params";
import { computeTechModel } from "@app/kernel/server/tech";
import { computeTornado } from "@app/kernel/server/sensitivity";

/** 一条「沙盘基线导出」形状的财务（十进制串 = 引擎源值 toFixed 后的落库形态）。 */
function sampleFinancial(over: Partial<FinancialLike> = {}): FinancialLike {
  return {
    capex: "3524500.00",
    opexAnnual: "336300.00",
    revenueAnnual: "4987500.00",
    roiPct: "400.3500",
    irrPct: "23.7553",
    paybackYears: "5.28",
    calcRef: "model@1.0.0",
    sourceUrl: null,
    assumptions: {
      roiRatio: 4.003502,
      irrFraction: 0.237553,
      discountedPaybackYears: 5.28,
      evidenceKind: "ASSUMPTION",
      regionName: "山西",
    },
    ...over,
  };
}

describe("solution-provenance · 版本与来源链接判定（R8.4）", () => {
  it("版本语义化 + auditRef 以 sandbox-solution-provenance@ 起头", () => {
    expect(SOLUTION_PROVENANCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(provenanceCalcRef()).toBe(`sandbox-solution-provenance@${SOLUTION_PROVENANCE_VERSION}`);
  });

  it("isUsableSourceUrl：http/https（含大写）为真；空/非串/含空格/伪协议为假", () => {
    expect(isUsableSourceUrl("https://grid.cn/data/shanxi-tariff")).toBe(true);
    expect(isUsableSourceUrl("http://example.com")).toBe(true);
    expect(isUsableSourceUrl("HTTPS://Example.COM/x")).toBe(true);
    expect(isUsableSourceUrl("  https://ok  ")).toBe(true); // 仅判协议，trim 交给下游
    expect(isUsableSourceUrl("example.com")).toBe(false); // 无协议
    expect(isUsableSourceUrl("javascript:alert(1)")).toBe(false); // 伪协议
    expect(isUsableSourceUrl("")).toBe(false);
    expect(isUsableSourceUrl(null)).toBe(false);
    expect(isUsableSourceUrl(undefined)).toBe(false);
    expect(isUsableSourceUrl(123)).toBe(false);
    expect(isUsableSourceUrl("https://a b")).toBe(false); // 含空格
  });
});

describe("solution-provenance · verifyReproducibility（落库串 vs 源值换算）", () => {
  it("三项全命中容差 → reproducible:true、checks 长度 3、无 issues", () => {
    const r = verifyReproducibility(sampleFinancial());
    expect(r.reproducible).toBe(true);
    expect(r.checks.map((c) => c.metric).sort()).toEqual(["irrPct", "paybackYears", "roiPct"]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("roiPct 被篡改（400.35→999.99）→ 不通过、issue 点名 roiPct", () => {
    const r = verifyReproducibility(sampleFinancial({ roiPct: "999.9900" }));
    expect(r.reproducible).toBe(false);
    expect(r.issues.some((s) => s.includes("roiPct"))).toBe(true);
    const roi = r.checks.find((c) => c.metric === "roiPct");
    expect(roi?.ok).toBe(false);
  });

  it("irrPct 被篡改 → 点名 irrPct", () => {
    const r = verifyReproducibility(sampleFinancial({ irrPct: "10.0000" }));
    expect(r.reproducible).toBe(false);
    expect(r.issues.some((s) => s.includes("irrPct"))).toBe(true);
  });

  it("paybackYears 被篡改 → 点名 paybackYears", () => {
    const r = verifyReproducibility(sampleFinancial({ paybackYears: "12.00" }));
    expect(r.reproducible).toBe(false);
    expect(r.issues.some((s) => s.includes("paybackYears"))).toBe(true);
  });

  it("源值缺失（roiRatio=null，负/算不出时草案会省略）→ roiPct 记 skipped、不误判失败", () => {
    const r = verifyReproducibility(
      sampleFinancial({ roiPct: null, assumptions: { roiRatio: null, irrFraction: 0.237553, discountedPaybackYears: 5.28, evidenceKind: "ASSUMPTION" } }),
    );
    expect(r.reproducible).toBe(true); // 无从复算 ≠ 复算失败
    expect(r.skipped).toContain("roiPct");
    expect(r.checks.some((c) => c.metric === "roiPct")).toBe(false);
  });

  it("落库串缺失（irrPct 未提供）→ irrPct 记 skipped、不误判失败", () => {
    const r = verifyReproducibility(sampleFinancial({ irrPct: undefined }));
    expect(r.reproducible).toBe(true);
    expect(r.skipped).toContain("irrPct");
  });

  it("assumptions 非对象 → 三项全 skip、不抛", () => {
    const r = verifyReproducibility({ roiPct: "1.00", irrPct: "2.00", paybackYears: "3.00", assumptions: "nope" });
    expect(r.reproducible).toBe(true);
    expect(r.checks).toHaveLength(0);
    expect(r.skipped.sort()).toEqual(["irrPct", "paybackYears", "roiPct"]);
  });

  it("末位舍入落在容差内（roiPct=400.35 对源值 400.3502）→ 通过（不容忍真值却被明显改动）", () => {
    const r = verifyReproducibility(sampleFinancial({ roiPct: "400.35" }));
    const roi = r.checks.find((c) => c.metric === "roiPct");
    expect(roi?.ok).toBe(true);
    expect(roi && roi.delta).toBeLessThanOrEqual(0.006);
  });
});

describe("solution-provenance · summarizeTraceability（FACT + 真实来源才可追溯）", () => {
  it("全 ASSUMPTION 无来源 → traceableCount 0、fullyTraceable false", () => {
    const s = summarizeTraceability([sampleFinancial(), sampleFinancial()]);
    expect(s.total).toBe(2);
    expect(s.assumptionCount).toBe(2);
    expect(s.traceableCount).toBe(0);
    expect(s.withSourceUrlCount).toBe(0);
    expect(s.fullyTraceable).toBe(false);
    expect(s.rows[0].traceable).toBe(false);
  });

  it("FACT + 合法链接 → 可追溯；混入 ASSUMPTION → fullyTraceable false", () => {
    const fact: FinancialLike = {
      sourceUrl: "https://data.cn/tariff",
      assumptions: { evidenceKind: "FACT", roiRatio: 4.0 },
    };
    const s = summarizeTraceability([fact, sampleFinancial()]);
    expect(s.traceableCount).toBe(1);
    expect(s.otherCount).toBe(1); // FACT 非 ASSUMPTION → 归 other
    expect(s.withSourceUrlCount).toBe(1);
    expect(s.fullyTraceable).toBe(false);
    expect(s.rows[0].traceable).toBe(true);
    expect(s.rows[1].traceable).toBe(false);
  });

  it("FACT 但无链接 → 不可追溯（来源不可追溯）", () => {
    const s = summarizeTraceability([{ sourceUrl: null, assumptions: { evidenceKind: "FACT" } }]);
    expect(s.traceableCount).toBe(0);
    expect(s.rows[0].hasSourceUrl).toBe(false);
    expect(s.rows[0].traceable).toBe(false);
  });

  it("ASSUMPTION 但贴了链接 → 仍不可追溯（证据等级须为 FACT）", () => {
    const s = summarizeTraceability([{ sourceUrl: "https://x.cn/y", assumptions: { evidenceKind: "ASSUMPTION" } }]);
    expect(s.withSourceUrlCount).toBe(1);
    expect(s.traceableCount).toBe(0);
    expect(s.fullyTraceable).toBe(false);
  });

  it("全部 FACT + 链接 → fullyTraceable true", () => {
    const a: FinancialLike = { sourceUrl: "https://x/1", assumptions: { evidenceKind: "FACT" } };
    const b: FinancialLike = { sourceUrl: "https://x/2", assumptions: { evidenceKind: "FACT" } };
    expect(summarizeTraceability([a, b]).fullyTraceable).toBe(true);
  });
});

describe("solution-provenance · evaluateSolutionProvenance（综合体检）", () => {
  it("空数组 → 诚实空态（count 0、buyerSummary 说明无审计对象、不臆断可追溯）", () => {
    const p = evaluateSolutionProvenance([]);
    expect(p.financialCount).toBe(0);
    expect(p.reproducibility.allReproducible).toBe(true);
    expect(p.traceability.fullyTraceable).toBe(false);
    expect(p.buyerSummary).toContain("未携带");
  });

  it("沙盘基线导出 → 可复算通过 + 0/N 可追溯 + 买家摘要含『复算』与『0/1』", () => {
    const p = evaluateSolutionProvenance([sampleFinancial()]);
    expect(p.auditRef).toBe(provenanceCalcRef());
    expect(p.financialCount).toBe(1);
    expect(p.reproducibility.allReproducible).toBe(true);
    expect(p.traceability.traceableCount).toBe(0);
    expect(p.buyerSummary).toContain("复算");
    expect(p.buyerSummary).toContain("0/1");
  });

  it("存在复算异常 → allReproducible false、issues 非空、摘要点名异常", () => {
    const p = evaluateSolutionProvenance([sampleFinancial({ irrPct: "99.0000" })]);
    expect(p.reproducibility.allReproducible).toBe(false);
    expect(p.reproducibility.issues.length).toBeGreaterThan(0);
    expect(p.buyerSummary).toContain("对不上");
  });
});

describe("solution-provenance · planProvenanceUpgrade（ASSUMPTION→FACT 受控闸门）", () => {
  it("合法 http(s) 链接 + [0,100] 数值置信度 → willUpgrade true、目标 FACT、规范化 sourceUrl/confidence", () => {
    const plan = planProvenanceUpgrade(sampleFinancial(), { sourceUrl: "  https://data.cn/tariff  ", confidence: 85, note: "电网公示价" });
    expect(plan.willUpgrade).toBe(true);
    expect(plan.targetEvidenceKind).toBe("FACT");
    expect(plan.sourceUrl).toBe("https://data.cn/tariff");
    expect(plan.confidence).toBe(85);
    expect(plan.reason).toBeNull();
  });

  it("缺来源链接 → 拒绝、保留 ASSUMPTION、给原因，绝不静默", () => {
    const plan = planProvenanceUpgrade(sampleFinancial(), { confidence: 90 });
    expect(plan.willUpgrade).toBe(false);
    expect(plan.targetEvidenceKind).toBe("ASSUMPTION");
    expect(plan.sourceUrl).toBeNull();
    expect(plan.reason).toContain("来源链接");
  });

  it("有链接但缺数值置信度 → 拒绝", () => {
    const plan = planProvenanceUpgrade(sampleFinancial(), { sourceUrl: "https://data.cn/x" });
    expect(plan.willUpgrade).toBe(false);
    expect(plan.sourceUrl).toBe("https://data.cn/x");
    expect(plan.confidence).toBeNull();
    expect(plan.reason).toContain("置信度");
  });

  it("置信度越界（150 / -1）→ 拒绝并点名越界", () => {
    for (const conf of [150, -1]) {
      const plan = planProvenanceUpgrade(sampleFinancial(), { sourceUrl: "https://data.cn/x", confidence: conf });
      expect(plan.willUpgrade).toBe(false);
      expect(plan.reason).toContain("越界");
    }
  });

  it("链接为伪协议（javascript:）→ 拒绝（无出处不升级为事实）", () => {
    const plan = planProvenanceUpgrade(sampleFinancial(), { sourceUrl: "javascript:alert(1)", confidence: 99 });
    expect(plan.willUpgrade).toBe(false);
    expect(plan.sourceUrl).toBeNull();
  });
});

describe("solution-provenance · ★反漂移 + 确定性", () => {
  it("喂 R8.1 真实草案（真引擎链）→ 复算必通过（写侧 toFixed ↔ 读侧换算同一口径）", () => {
    const calc = runProjectModelBaseline();
    const resolved = resolveProjectParams();
    const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
    const vm = buildDecisionViewModel({
      calc,
      tech: tech && tech.ok ? tech.firstYear : null,
      tornado: calc.ok ? computeTornado() : null,
      discountRate: (resolved.numeric["finance.discountRate"] ?? 8) / 100,
    });
    const d = buildSolutionDraft({ calc, vm, regionName: "山西", projectName: "反漂移站" });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const p = evaluateSolutionProvenance(d.financials as FinancialLike[]);
    expect(p.financialCount).toBe(1);
    expect(p.reproducibility.allReproducible).toBe(true);
    // 草案未附来源链接 → 0 可追溯（诚实：全新导出仍是占位假设）
    expect(p.traceability.traceableCount).toBe(0);
  });

  it("确定性：同输入两次体检深相等", () => {
    const fins = [sampleFinancial()];
    expect(evaluateSolutionProvenance(fins)).toEqual(evaluateSolutionProvenance(fins));
    expect(verifyReproducibility(sampleFinancial())).toEqual(verifyReproducibility(sampleFinancial()));
  });
});
