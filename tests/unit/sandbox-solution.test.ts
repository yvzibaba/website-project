/**
 * 沙盘「结果 → 产业方案草案」纯映射黄金样本（中途重构 R8.1 · §14 第 7 项「生成定制方案（复用 Solution 生成 + 购买闭环）」。
 *
 * 关键锁定（§7/§8/§16/§20）：
 *   - 草案财务 Decimal 串**逐字等于** `CalcResult` 原值（搬运非重算）；正文金额/百分比串**逐字取自视图模型卡片**。
 *   - 恒 `evidenceGrade="ASSUMPTION"`·`needsProfessionalReview=true`·带发布阻塞项（占位假设 / 未附 caseId / 需人工确认 / 未定价）；
 *   - 失败情景只回诚实错误、**绝不产出可售的方案正文/财务**；
 *   - 负 NPV 被点名进风险与阻塞项（不粉饰）；喂真实引擎输出端到端证 §7「程序算」与 §16「区分假设、高风险须人工确认」。
 *
 * 喂**真实引擎输出**（`runSandboxModel` + `resolveSandbox` + `computeTechModel` + `computeTornado` → `buildSandboxViewModel`）
 * 构造 vm 再产草案，与 `sandbox-report.test.ts` 同构，端到端焊死「进方案的数 = 模型算的数」。
 */
import { describe, it, expect } from "vitest";
import {
  buildSandboxSolutionDraft,
  sandboxSolutionCalcRef,
  SANDBOX_SOLUTION_VERSION,
} from "@/lib/sandbox-solution";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { runSandboxModel, runSandboxModelBaseline } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import { getEnterpriseProfile } from "@/server/sandbox-profiles";

function okDraft(calc = runSandboxModelBaseline(), overrides: Record<string, unknown> = {}) {
  const resolved = resolveSandbox();
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const vm = buildSandboxViewModel({
    calc,
    tech: tech && tech.ok ? tech.firstYear : null,
    tornado: calc.ok ? computeTornado() : null,
    discountRate: (resolved.numeric["finance.discountRate"] ?? 8) / 100,
  });
  return buildSandboxSolutionDraft({
    calc,
    vm,
    regionName: "山西",
    projectName: "晋中光储充重卡示范站",
    scenarioName: "基准情景",
    ...overrides,
  });
}

describe("sandbox-solution · 版本与契约（R8.1）", () => {
  it("版本语义化 + calcRef 溯源串", () => {
    expect(SANDBOX_SOLUTION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sandboxSolutionCalcRef()).toBe(`sandbox-solution@${SANDBOX_SOLUTION_VERSION}`);
  });

  it("成功草案：可映射 Solution 列的字段齐备 + 恒 ASSUMPTION/需人工确认 + 带发布阻塞项", () => {
    const d = okDraft();
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.title).toContain("晋中光储充重卡示范站");
    expect(d.slug).toMatch(/^[a-z0-9-]+$/);
    expect(d.summary.length).toBeGreaterThan(10);
    expect(d.evidenceGrade).toBe("ASSUMPTION");
    expect(d.needsProfessionalReview).toBe(true);
    expect(d.currency).toBe("CNY");
    expect(d.provenance.calcRef).toMatch(/^model@/);
    expect(d.publishBlockers.length).toBeGreaterThanOrEqual(3);
    // 三类固有阻塞恒在：占位假设 / caseId 外键 / 需专业人工确认
    const all = d.publishBlockers.join("\n");
    expect(all).toContain("占位假设");
    expect(all).toContain("caseId");
    expect(all).toContain("需专业人工确认");
  });
});

describe("sandbox-solution · §7 单一真源（财务=引擎原值、正文=卡片串，绝不重算）", () => {
  it("★财务 Decimal 串逐字等于 CalcResult 原值（capex/opex/revenue 搬运非重算）", () => {
    const calc = runSandboxModelBaseline();
    const d = okDraft(calc);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const f = d.financials[0];
    if (calc.ok) {
      expect(f.capex).toBe(calc.capex.net.toFixed(2));
      expect(f.opexAnnual).toBe(calc.opexY1.gross.toFixed(2));
      expect(f.revenueAnnual).toBe(calc.revenueY1.gross.toFixed(2));
      // ROI 比值 ×100 → roiPct 百分数串（仅非负入 Decimal 字段）
      if (calc.metrics.roi.ok && calc.metrics.roi.value != null && calc.metrics.roi.value >= 0) {
        expect(f.roiPct).toBe((calc.metrics.roi.value * 100).toFixed(2));
      }
      // IRR 小数 ×100 → irrPct（四位）
      if (calc.metrics.irr.ok && calc.metrics.irr.value != null && calc.metrics.irr.value >= 0) {
        expect(f.irrPct).toBe((calc.metrics.irr.value * 100).toFixed(4));
      }
      // 折现回收期非负才入字段
      if (calc.metrics.discountedPaybackYears != null && calc.metrics.discountedPaybackYears >= 0) {
        expect(f.paybackYears).toBe(calc.metrics.discountedPaybackYears.toFixed(2));
      }
      // NPV 不是 Decimal 字段（可为负）→ 落在 assumptions，逐字等于原值
      expect((f.assumptions as Record<string, unknown>).npv).toBe(calc.metrics.npv);
    }
  });

  it("★正文 ROI/回收期/成本/收入分节的数字串取自视图模型卡片（呈现层搬运）", () => {
    const calc = runSandboxModelBaseline();
    const resolved = resolveSandbox();
    const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
    const vm = buildSandboxViewModel({ calc, tech: tech && tech.ok ? tech.firstYear : null, tornado: calc.ok ? computeTornado() : null });
    const roiCard = vm.cards?.find((c) => c.key === "roi")?.value ?? "";
    const paybackCard = vm.cards?.find((c) => c.key === "payback")?.value ?? "";
    const d = buildSandboxSolutionDraft({ calc, vm, regionName: "山西" });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(String(d.body.roi)).toContain(roiCard);
    expect(String(d.body.payback)).toContain(paybackCard);
    expect(String(d.body.costModel)).toContain(vm.meta?.capexNetLabel ?? "__");
    expect(String(d.body.revenueModel)).toContain(vm.meta?.revenueY1Label ?? "__");
  });
});

describe("sandbox-solution · §16/§20 诚实边界", () => {
  it("★失败情景只回诚实错误、绝不产出可售正文/财务", () => {
    const badCalc = runSandboxModel({ user: { values: { "project.pvCapacity": Number.NaN } } });
    const vm = buildSandboxViewModel({ calc: badCalc });
    const d = buildSandboxSolutionDraft({ calc: badCalc, vm, regionName: "山西" });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error?.reason).toBeTruthy();
    expect((d as unknown as { body?: unknown }).body).toBeUndefined();
    expect((d as unknown as { financials?: unknown }).financials).toBeUndefined();
    expect(d.publishBlockers.join("\n")).toContain("不可生成");
  });

  it("★负 NPV 被点名进风险叙述与发布阻塞项（不粉饰）", () => {
    const calcDown = runSandboxModel({ user: { values: { "project.chargingPrice": 0.5 } } });
    const d = okDraft(calcDown);
    if (!d.ok) {
      // 若该参数把引擎打成错误态也算诚实——但 0.5 应仍 ok，仅 NPV 为负
      expect(d.ok).toBe(true);
      return;
    }
    expect(calcDown.ok && calcDown.metrics.npv < 0).toBe(true);
    expect(String(d.body.riskAnalysis)).toContain("NPV 为非正");
    expect(d.publishBlockers.join("\n")).toContain("NPV 为非正");
    // 负 NPV 不塞进任何 Decimal 字段（NPV 本就非字段）
    expect((d.financials[0].assumptions as Record<string, unknown>).npv).toBeLessThan(0);
  });

  it("关键未知恒 ≥1（全部入参占位）且带解决路径与高严重度", () => {
    const d = okDraft();
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(d.unknowns[0].name).toContain("入参");
    expect(d.unknowns[0].howToResolve).toContain("真实");
    expect(d.unknowns[0].severity).toBe(90);
    expect(d.body.unknowns).toBeInstanceOf(Array);
  });

  it("★未定价 → 阻塞项点名；传入价格 → 解除该项且落 draft.price", () => {
    const dNoPrice = okDraft();
    expect(dNoPrice.ok && dNoPrice.publishBlockers.join("\n")).toContain("尚未设定对外价格");
    if (!dNoPrice.ok) return;
    expect(dNoPrice.price).toBeUndefined();

    const dPriced = okDraft(runSandboxModelBaseline(), { price: "1999.00" });
    expect(dPriced.ok).toBe(true);
    if (!dPriced.ok) return;
    expect(dPriced.price).toBe("1999.00");
    expect(dPriced.publishBlockers.join("\n")).not.toContain("尚未设定对外价格");
    // 仍固有阻塞在（占位/caseId/人工确认）——定价不解除它们
    expect(dPriced.publishBlockers.join("\n")).toContain("caseId");
  });
});

describe("sandbox-solution · R7 画像裁剪进入方案", () => {
  it("带画像 → 适用企业用画像名/摘要 + 摘要与溯源带画像版本", () => {
    const fleet = getEnterpriseProfile("fleet");
    const d = okDraft(runSandboxModelBaseline(), { profile: fleet });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(String(d.body.targetEnterprises)).toContain(fleet.name);
    expect(d.summary).toContain(fleet.name);
    expect(d.provenance.profilesVersion).toBeTruthy();
  });
});

describe("sandbox-solution · 确定性（同输入两次深相等，可复算）", () => {
  it("同 calc + 同上下文两次生成完全相等", () => {
    const calc = runSandboxModelBaseline();
    const a = okDraft(calc);
    const b = okDraft(runSandboxModelBaseline());
    expect(a).toEqual(b);
  });
});
