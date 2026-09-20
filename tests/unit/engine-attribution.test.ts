/**
 * M6 差异归因（attribution.ts）单元测试。
 *
 * 关注的不是"跑通没报错"，而是归因这件事**在数学和诚实性上对不对**：
 *  - 结构 diff 只挑参与计算的字段；
 *  - 只改一个参数时，逐参数分解应等于总变化（残差≈0，无交互可言）；
 *  - 改多个参数时，残差如实等于总变化与可归因之和的差（不摊平、不假装自洽）；
 *  - 同一对输入两次调用逐字节一致（可复现）；
 *  - 不污染调用方传入的两份输入对象；
 *  - 指标表里的 NPV 差 = 对照 − 基线（与引擎同源）。
 */
import { describe, it, expect } from "vitest";
import {
  attributeScenarioDelta,
  ATTRIBUTION_VERSION,
  type ScenarioAttribution,
} from "@app/kernel/engine/attribution";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import { runCalculation } from "@app/kernel/engine/engine";
import type { ScenarioInput } from "@app/kernel/engine/types";

const FEE = 0.45;

function base(templateId?: string): ScenarioInput {
  return defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE, templateId }).input;
}
function withPatch(src: ScenarioInput, patch: (s: ScenarioInput) => ScenarioInput): ScenarioInput {
  return patch(structuredClone(src));
}

function okAttribution(a: ScenarioInput, b: ScenarioInput, objective?: "npv" | "equityNpv" | "payback"): ScenarioAttribution {
  const out = attributeScenarioDelta(a, b, objective ? { objective } : {});
  if (!out.ok) throw new Error(`归因意外失败：${out.reason} ${out.detail}`);
  return out;
}

describe("M6 差异归因：结构 diff", () => {
  it("两份输入完全一致 → 明确说没有可归因差异，而不是硬凑一张空表", () => {
    const a = base();
    const out = attributeScenarioDelta(a, structuredClone(a));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("same_input");
  });

  it("只改不参与计算的字段（name / note）→ 视为无可归因差异", () => {
    const a = base();
    const b = withPatch(a, (s) => {
      s.name = "改了个名字而已";
      s.note = "自由备注，不进计算";
      return s;
    });
    const out = attributeScenarioDelta(a, b);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("same_input");
  });

  it("改一个参与计算的价格参数 → changedInputs 恰好命中该路径并带 from/to", () => {
    const a = base();
    const b = withPatch(a, (s) => {
      s.economics.discountRatePct = s.economics.discountRatePct + 1;
      return s;
    });
    const out = okAttribution(a, b);
    expect(out.changedInputs.map((c) => c.path)).toContain("economics.discountRatePct");
    const row = out.changedInputs.find((c) => c.path === "economics.discountRatePct")!;
    expect(Number(row.to) - Number(row.from)).toBeCloseTo(1, 6);
  });
});

describe("M6 差异归因：一阶分解与残差", () => {
  it("★ 只改单个参数时，逐参数贡献之和应等于总变化（残差≈0）—— 这是归因正确性的硬测试", () => {
    const a = base();
    const b = withPatch(a, (s) => {
      s.economics.discountRatePct = s.economics.discountRatePct + 1;
      return s;
    });
    const out = okAttribution(a, b);
    expect(out.changedInputs).toHaveLength(1);
    expect(out.rows[0].status).toBe("ok");
    expect(out.attributableDelta).toBeCloseTo(out.totalDelta, 2);
    expect(Math.abs(out.residual)).toBeLessThan(0.01);
  });

  it("改多个参数时，残差如实等于总变化减可归因之和（不摊平到某个参数上）", () => {
    const a = base("grid-only");
    const b = base("pv-bess-tou");
    const out = okAttribution(a, b);
    expect(out.changedInputs.length).toBeGreaterThan(1);
    const recomputed = out.attributableDelta + out.residual;
    expect(recomputed).toBeCloseTo(out.totalDelta, 2);
  });

  it("grid-only → 光伏储能有序充电：baseValue / targetValue 与引擎重算一致", () => {
    const a = base("grid-only");
    const b = base("pv-bess-tou");
    const out = okAttribution(a, b, "npv");
    const ca = runCalculation(a);
    const cb = runCalculation(b);
    expect(ca.ok && cb.ok).toBe(true);
    if (!ca.ok || !cb.ok) return;
    expect(out.baseValue).toBeCloseTo(ca.economics.metrics.npvYuan, 0);
    expect(out.targetValue).toBeCloseTo(cb.economics.metrics.npvYuan, 0);
    expect(out.totalDelta).toBeCloseTo(cb.economics.metrics.npvYuan - ca.economics.metrics.npvYuan, 0);
    expect(out.topDriver).not.toBeNull();
  });

  it("目标口径切到资本金 NPV，分解仍闭合", () => {
    const a = base("grid-only");
    const b = base("pv-bess-tou");
    const out = okAttribution(a, b, "equityNpv");
    expect(out.objective).toBe("equityNpv");
    expect(out.attributableDelta + out.residual).toBeCloseTo(out.totalDelta, 2);
  });
});

describe("M6 差异归因：可复现与纯度", () => {
  it("同一对输入调用两次 → 输出逐字节一致（不含耗时/时钟/随机）", () => {
    const a = base("grid-only");
    const b = base("pv-bess-tou");
    const r1 = JSON.stringify(attributeScenarioDelta(a, b));
    const r2 = JSON.stringify(attributeScenarioDelta(a, b));
    expect(r1).toBe(r2);
  });

  it("★ 不污染调用方传入的两份输入对象（纯函数）", () => {
    const a = base("grid-only");
    const b = base("pv-bess-tou");
    const aSnap = JSON.stringify(a);
    const bSnap = JSON.stringify(b);
    attributeScenarioDelta(a, b);
    expect(JSON.stringify(a)).toBe(aSnap);
    expect(JSON.stringify(b)).toBe(bSnap);
  });

  it("归因结果带版本与追溯引用，且不含 elapsedMs 之类破坏复现的字段", () => {
    const out = okAttribution(base("grid-only"), base("pv-charging"));
    expect(out.attributionRef).toBe(`attrib@${ATTRIBUTION_VERSION}`);
    expect(out.engineVersion).toBeTruthy();
    const raw = JSON.stringify(out);
    expect(raw).not.toMatch(/elapsedMs/i);
    expect(raw).not.toMatch(/"date"|generatedAt/i);
  });

  it("解释文本是程序产出、带具体数值，且诚实声明路径依赖与残差", () => {
    const out = okAttribution(base("grid-only"), base("pv-bess-tou"));
    expect(out.explanation.summary).toMatch(/NPV|回收期|万元|年/);
    const joined = out.explanation.paragraphs.join(" ");
    expect(joined).toMatch(/残差/);
    expect(joined).toMatch(/路径/);
  });
});
