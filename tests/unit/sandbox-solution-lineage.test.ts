/**
 * 沙盘「来源方案」溯源识别纯函数黄金样本（中途重构 R8.3 · 商业闭环第三块：详情页诚实声明的数据支撑）。
 *
 * 关键锁定（§8 单一真源 / §13 版本 / §16/§20 诚实 / 反漂移）：
 *   - 版本语义化；来源判据 = 财务 `assumptions.solutionCalcRef` 前缀匹配（确凿指纹，非启发式）。
 *   - 非沙盘（空数组 / 人工录入 / assumptions 非对象 / 无 solutionCalcRef）→ `describeSandboxLineage` 恒 null、
 *     `isSandboxSourcedSolution` 恒 false（详情页据此绝不给普通方案乱挂沙盘声明）。
 *   - 命中 → 逐字段**原样读出**（engineVersions/regionName/profileName/evidenceKind/engineCalcRef），不重算。
 *   - npvNonPositive：npv<0 → true；npv 为正 → false；npv 缺失/非有限 → 保守 false（不臆断为负）。
 *   - ★反漂移端到端：喂 **R8.1 真实草案**（真引擎链产出）的 financials → 必被本层识别，且 `draftVersion`
 *     逐字 === `SANDBOX_SOLUTION_VERSION`（把「草案写的指纹前缀」与「本层读的指纹前缀」两套口径钉死一致）。
 *   - 确定性（同输入两次深相等）。
 */
import { describe, it, expect } from "vitest";
import {
  describeSandboxLineage,
  isSandboxSourcedSolution,
  SANDBOX_SOLUTION_LINEAGE_VERSION,
  SANDBOX_SOLUTION_ORIGIN_PREFIX,
  type LineageFinancialLike,
} from "@/lib/sandbox-solution-lineage";
import { SANDBOX_SOLUTION_VERSION } from "@/lib/sandbox-solution";
import { buildSandboxSolutionDraft } from "@/lib/sandbox-solution";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { runSandboxModelBaseline } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";

function sandboxAssumptions(extra: Record<string, unknown> = {}) {
  return {
    solutionCalcRef: `${SANDBOX_SOLUTION_ORIGIN_PREFIX}${SANDBOX_SOLUTION_VERSION}`,
    engineVersions: { model: "1.0.0", tech: "1.0.0", finance: "1.0.0", params: "1.1.0" },
    regionName: "山西",
    profileName: null,
    evidenceKind: "ASSUMPTION",
    npv: 4277409,
    ...extra,
  };
}

describe("sandbox-solution-lineage · 版本与来源判据（R8.3）", () => {
  it("版本语义化 + 前缀常量以 sandbox-solution@ 起头", () => {
    expect(SANDBOX_SOLUTION_LINEAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SANDBOX_SOLUTION_ORIGIN_PREFIX).toBe("sandbox-solution@");
  });

  it("空财务数组 → 非沙盘（null / false）", () => {
    expect(describeSandboxLineage([])).toBeNull();
    expect(isSandboxSourcedSolution([])).toBe(false);
  });

  it("人工录入方案（assumptions 为 null / 非对象 / 缺 solutionCalcRef）→ 恒非沙盘", () => {
    const manual: LineageFinancialLike[] = [
      { calcRef: null, assumptions: null },
      { calcRef: "model@1.0.0", assumptions: "not-an-object" },
      { calcRef: "model@1.0.0", assumptions: { npv: 100, evidenceKind: "FACT" } }, // 无沙盘指纹
      { calcRef: "model@1.0.0", assumptions: { solutionCalcRef: "solution-generation@2.0.0" } }, // 别的来源前缀
    ];
    expect(isSandboxSourcedSolution(manual)).toBe(false);
    for (const f of manual) {
      expect(describeSandboxLineage([f])).toBeNull();
    }
  });
});

describe("sandbox-solution-lineage · 命中指纹逐字段原样读出（不重算）", () => {
  it("单条沙盘财务 → 溯源画像各字段取自 assumptions 原值", () => {
    const fin: LineageFinancialLike = { calcRef: "model@1.0.0", assumptions: sandboxAssumptions() };
    expect(isSandboxSourcedSolution([fin])).toBe(true);
    const lin = describeSandboxLineage([fin]);
    expect(lin).not.toBeNull();
    expect(lin?.generatedBySandbox).toBe(true);
    expect(lin?.solutionCalcRef).toBe(`${SANDBOX_SOLUTION_ORIGIN_PREFIX}${SANDBOX_SOLUTION_VERSION}`);
    expect(lin?.draftVersion).toBe(SANDBOX_SOLUTION_VERSION);
    expect(lin?.engineCalcRef).toBe("model@1.0.0");
    expect(lin?.engineVersions).toEqual({ model: "1.0.0", tech: "1.0.0", finance: "1.0.0", params: "1.1.0" });
    expect(lin?.regionName).toBe("山西");
    expect(lin?.evidenceKind).toBe("ASSUMPTION");
  });

  it("多条财务择首条命中者为准（行为确定）", () => {
    const first: LineageFinancialLike = { calcRef: "model@1.0.0", assumptions: sandboxAssumptions({ regionName: "内蒙古" }) };
    const later: LineageFinancialLike = { calcRef: "model@1.0.0", assumptions: sandboxAssumptions({ regionName: "陕西" }) };
    const lin = describeSandboxLineage([{ calcRef: null, assumptions: null }, first, later]);
    expect(lin?.regionName).toBe("内蒙古");
  });

  it("非字符串字段诚实回 null（宁缺毋滥，不把 undefined 当事实）", () => {
    const fin: LineageFinancialLike = {
      calcRef: null,
      assumptions: {
        solutionCalcRef: `${SANDBOX_SOLUTION_ORIGIN_PREFIX}1.0.0`,
        regionName: 123, // 非字符串
        engineVersions: "nope", // 非对象
        evidenceKind: "", // 空串
      },
    };
    const lin = describeSandboxLineage([fin]);
    expect(lin).not.toBeNull();
    expect(lin?.engineCalcRef).toBeNull();
    expect(lin?.regionName).toBeNull();
    expect(lin?.profileName).toBeNull();
    expect(lin?.engineVersions).toBeNull();
    expect(lin?.evidenceKind).toBeNull();
    expect(lin?.draftVersion).toBe("1.0.0");
  });
});

describe("sandbox-solution-lineage · npvNonPositive 判定（读已落库值，保守不臆断）", () => {
  it("npv<0 → true；npv>0 → false", () => {
    expect(
      describeSandboxLineage([{ assumptions: sandboxAssumptions({ npv: -12345 }) }])?.npvNonPositive,
    ).toBe(true);
    expect(
      describeSandboxLineage([{ assumptions: sandboxAssumptions({ npv: 500 }) }])?.npvNonPositive,
    ).toBe(false);
  });

  it("npv 缺失 / null / 非有限 → 保守 false（算不出不等于为负）", () => {
    const base = `${SANDBOX_SOLUTION_ORIGIN_PREFIX}1.0.0`;
    for (const npv of [undefined, null, Number.NaN]) {
      const lin = describeSandboxLineage([{ assumptions: { solutionCalcRef: base, npv } }]);
      expect(lin?.npvNonPositive).toBe(false);
    }
  });
});

describe("sandbox-solution-lineage · ★反漂移（真引擎草案 ↔ 本层识别口径一致）", () => {
  it("喂 R8.1 真实草案的 financials → 必被识别，且 draftVersion === SANDBOX_SOLUTION_VERSION", () => {
    const calc = runSandboxModelBaseline();
    const resolved = resolveSandbox();
    const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
    const vm = buildSandboxViewModel({
      calc,
      tech: tech && tech.ok ? tech.firstYear : null,
      tornado: calc.ok ? computeTornado() : null,
      discountRate: (resolved.numeric["finance.discountRate"] ?? 8) / 100,
    });
    const d = buildSandboxSolutionDraft({ calc, vm, regionName: "山西", projectName: "反漂移站" });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // 草案落库前其财务 assumptions 就带沙盘指纹——本层应立刻识别，证明「写」与「读」同一契约。
    expect(isSandboxSourcedSolution(d.financials)).toBe(true);
    const lin = describeSandboxLineage(d.financials);
    expect(lin?.draftVersion).toBe(SANDBOX_SOLUTION_VERSION);
    expect(lin?.engineCalcRef).toMatch(/^model@/);
    expect(lin?.regionName).toBe("山西");
    expect(lin?.evidenceKind).toBe("ASSUMPTION");
    // 基线 NPV 为正（黄金值 ≈ 4.28M）→ 非为负
    expect(lin?.npvNonPositive).toBe(false);
  });

  it("确定性：同财务输入两次画像深相等", () => {
    const fin: LineageFinancialLike = { calcRef: "model@1.0.0", assumptions: sandboxAssumptions() };
    expect(describeSandboxLineage([fin])).toEqual(describeSandboxLineage([fin]));
  });
});
