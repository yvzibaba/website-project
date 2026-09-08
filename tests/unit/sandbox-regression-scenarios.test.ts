/**
 * 单元测试：阶段3A「现实性回归」——Small/Medium/Large 三组标准场景（fixture 钉桩）。
 *
 * 为什么存在（阶段3A 指令七）：为未来模型回归准备**可重放的"现实性"基线**——
 *   三组标准场景（小/中/大型车队）以**固定时钟**（2026-01-01）走既有 `computeDemoScenario`
 *   纯函数链（映射层 → 40 参数引擎 → 技术 → 经济 → 敏感性），锁定：
 *     ① 参数快照（userValues，示范映射层产出的引擎覆写键值）
 *     ② 模型版本（engineVersions + calcRef）
 *     ③ 关键结果（NPV/IRR/ROI/回收期/CAPEX/OPEX/首年收入/储能价值）
 *   模型口径有意变化 → 本测试红 → 须先在 CHANGELOG 记原因与版本、再**有意重录** fixture
 *   （生成器用法见 fixture meta.reRecord），**绝不顺手改数字、绝不修改既有历史黄金样本**。
 *
 * 诚实边界：fixture 数字是「给定输入下的确定性输出」，非"正确值"的断言；输入本身仍是占位假设（§20）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeDemoScenario, type DemoHeadlineState, type DemoTouched } from "@/server/sandbox-demo";

interface ScenarioExpectation {
  id: string;
  label: string;
  state: DemoHeadlineState;
  touched: DemoTouched;
  expect: {
    vmOk: boolean;
    calcOk: boolean;
    calcRef: string;
    engineVersions: { model: string; tech: string; finance: string; params: string; storage?: string };
    userValues: Record<string, number>;
    results: {
      npv: number;
      irrOk: boolean;
      irr: number | null;
      roiOk: boolean;
      roi: number | null;
      simplePaybackYears: number | null;
      discountedPaybackYears: number | null;
      capexGross: number;
      capexNet: number;
      opexY1: number;
      revenueY1: number;
      storageValueY1: number;
    };
  };
}

interface SmlFixture {
  meta: { fixedNow: string; rounding: string };
  scenarios: ScenarioExpectation[];
}

const fixturePath = resolve(process.cwd(), "tests", "fixtures", "regression", "scenarios-sml.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as SmlFixture;

const FIXED_NOW = new Date(fixture.meta.fixedNow);

const money = (x: number) => Math.round(x * 100) / 100;
const ratio = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6;

describe("阶段3A · S/M/L 现实性回归场景（fixture 钉桩 · 固定时钟）", () => {
  it("fixture 自身形态：恰 3 组（small/medium/large）+ 固定时钟口径声明", () => {
    expect(fixture.scenarios.map((s) => s.id)).toEqual(["small", "medium", "large"]);
    expect(fixture.meta.fixedNow).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  for (const s of fixture.scenarios) {
    it(`场景「${s.id}」：${s.label} —— 版本/快照/结果与 fixture 逐位一致`, () => {
      const scn = computeDemoScenario(s.state, s.touched, FIXED_NOW);
      const calc = scn.calc;

      // ① 诚实可解：视图与引擎都算得出（红=引擎在真输入下失败，先修引擎再谈回归）。
      expect(scn.vm.ok).toBe(s.expect.vmOk);
      expect(calc.ok).toBe(s.expect.calcOk);
      if (!calc.ok) return; // 类型收窄（正常恒真）。

      // ② 模型版本 + 溯源串：任何口径变化先在这里红（有意变更 → CHANGELOG → 有意重录）。
      expect(calc.calcRef).toBe(s.expect.calcRef);
      expect(calc.engineVersions).toEqual(s.expect.engineVersions);

      // ③ 参数快照（示范映射层 → 引擎覆写键值，逐键深比对）。
      expect(scn.userValues).toEqual(s.expect.userValues);

      // ④ 关键结果（与 fixture 同一舍入口径：金额 2 位 / 比率 6 位）。
      const r = s.expect.results;
      expect(money(calc.metrics.npv)).toBe(r.npv);
      expect(calc.metrics.irr.ok).toBe(r.irrOk);
      expect(ratio(calc.metrics.irr.value)).toBe(r.irr);
      expect(calc.metrics.roi.ok).toBe(r.roiOk);
      expect(ratio(calc.metrics.roi.value)).toBe(r.roi);
      expect(ratio(calc.metrics.simplePaybackYears)).toBe(r.simplePaybackYears);
      expect(ratio(calc.metrics.discountedPaybackYears)).toBe(r.discountedPaybackYears);
      expect(money(calc.capex.gross)).toBe(r.capexGross);
      expect(money(calc.capex.net)).toBe(r.capexNet);
      expect(money(calc.opexY1.gross)).toBe(r.opexY1);
      expect(money(calc.revenueY1.gross)).toBe(r.revenueY1);
      expect(money(calc.revenueY1.storageValue)).toBe(r.storageValueY1);
    });
  }
});
