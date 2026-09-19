/**
 * 沙盘「已保存情景 ↔ 产业方案」来源关联指针纯函数黄金样本（中途重构 R8.6 · 商业闭环「反查关联」）。
 *
 * 关键锁定（§8 单一真源 / §12 可追溯 / §16 不破坏既有脊柱 / §20 诚实 / §13 版本 / 反漂移）：
 *   - 版本语义化；键名 / kind 常量守护（写读共享，防拼写漂移）。
 *   - normalize：只保留合法 cuid，两 id 皆缺 / 皆脏 → null（不落空指针）。
 *   - attach：★不可变合并——追加 sandboxSource 同时**逐一保住** R8.3/R8.4 赖以工作的既有溯源键
 *     （solutionCalcRef / roiRatio / irrFraction / discountedPaybackYears / engineVersions …）；
 *     无有效来源 → 原样返回（同一引用），绝不虚构。
 *   - read：首条命中 + 脏值降 null + 库里 sourceVersion 优先（保留「哪版写的」审计真相）。
 *   - ★反漂移端到端：attach 到 **R8.1 真实草案**财务后，R8.3 `isModelSourcedSolution` 仍 true、
 *     R8.4 `verifyReproducibility` 仍可复算（源值未被覆盖）→ 证「挂来源关联」绝不破坏既有溯源脊柱。
 *   - describe：无来源 null；仅情景 / 仅项目 / 二者都有各出对应句。
 *   - 确定性（同输入两次深相等）。
 */
import { describe, it, expect } from "vitest";
import {
  SOLUTION_SOURCE_VERSION,
  SOLUTION_SOURCE_FIELD,
  SOLUTION_SOURCE_KIND,
  normalizeSolutionSource,
  attachSolutionSource,
  readSolutionSourceFromFinancials,
  describeSolutionSource,
  type SolutionSourceRef,
  type SourceFinancialLike,
} from "@app/kernel/lib/solution-source";
import { SOLUTION_VERSION, buildSolutionDraft } from "@app/kernel/lib/solution-draft";
import { buildDecisionViewModel } from "@app/kernel/lib/decision-view";
import { runProjectModelBaseline } from "@app/kernel/server/project-model";
import { resolveProjectParams } from "@app/kernel/server/project-params";
import { computeTechModel } from "@app/kernel/server/tech";
import { computeTornado } from "@app/kernel/server/sensitivity";
import { isModelSourcedSolution } from "@app/kernel/lib/solution-lineage";
import { verifyReproducibility } from "@app/kernel/lib/solution-provenance";

// 合法 cuid 形状（c + 小写字母数字，20–32 长）；造两个可区分的 id。
const SCEN = "c" + "s1enario0aaaa1bbbb2cccc3".slice(0, 24); // 长度合规、含数字小写字母
const PROJ = "c" + "p1roject0dddd4eeee5ffff6".slice(0, 24);

function draftFinancials() {
  const calc = runProjectModelBaseline();
  const resolved = resolveProjectParams({});
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({});
  const vm = buildDecisionViewModel({ calc, tech: tech && tech.ok ? tech.firstYear : null, tornado, discountRate: 0.08 });
  const draft = buildSolutionDraft({ calc, vm, regionName: "山西" });
  if (!draft.ok) throw new Error("测试前置：真实引擎链应产出成功草案");
  return draft.financials;
}

describe("solution-source · 版本与常量（R8.6）", () => {
  it("版本语义化 + 字段 / kind 常量稳定", () => {
    expect(SOLUTION_SOURCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SOLUTION_SOURCE_FIELD).toBe("sandboxSource");
    expect(SOLUTION_SOURCE_KIND).toBe("sandbox-scenario");
  });
});

describe("normalizeSolutionSource · 形状归一（R8.6）", () => {
  it("两 id 齐 → 归出 ref（带 kind + sourceVersion）", () => {
    const ref = normalizeSolutionSource({ scenarioId: SCEN, projectId: PROJ });
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe(SOLUTION_SOURCE_KIND);
    expect(ref!.scenarioId).toBe(SCEN);
    expect(ref!.projectId).toBe(PROJ);
    expect(ref!.sourceVersion).toBe(SOLUTION_SOURCE_VERSION);
  });

  it("仅一个 id → 另一键省略（不塞空串 / null）", () => {
    const only = normalizeSolutionSource({ scenarioId: SCEN })!;
    expect(only.scenarioId).toBe(SCEN);
    expect("projectId" in only).toBe(false);
    const onlyP = normalizeSolutionSource({ projectId: PROJ })!;
    expect("scenarioId" in onlyP).toBe(false);
  });

  it("非串 / 脏串 / 空 / 越界 → null（绝不虚构指针）", () => {
    expect(normalizeSolutionSource(null)).toBeNull();
    expect(normalizeSolutionSource(undefined)).toBeNull();
    expect(normalizeSolutionSource({})).toBeNull();
    expect(normalizeSolutionSource({ scenarioId: null, projectId: undefined })).toBeNull();
    expect(normalizeSolutionSource({ scenarioId: "not-a-cuid" })).toBeNull();
    expect(normalizeSolutionSource({ scenarioId: "c短" })).toBeNull(); // 非 [a-z0-9]
    expect(normalizeSolutionSource({ scenarioId: "  " })).toBeNull();
  });

  it("带空白的合法 id → trim 后接受", () => {
    const ref = normalizeSolutionSource({ scenarioId: `  ${SCEN}  ` })!;
    expect(ref.scenarioId).toBe(SCEN);
  });
});

describe("attachSolutionSource · 不可变合并 + 不破坏脊柱（R8.6 ★核心）", () => {
  it("★追加 sandboxSource 同时保住既有溯源键，且不改入参对象", () => {
    const fin: SourceFinancialLike[] = [
      { assumptions: { solutionCalcRef: `sandbox-solution@${SOLUTION_VERSION}`, roiRatio: 4.0, npv: 100 } },
    ];
    const snapshot = JSON.stringify(fin);
    const out = attachSolutionSource(fin, { scenarioId: SCEN, projectId: PROJ });
    // 新数组、非同一引用；入参原样未被就地修改。
    expect(out).not.toBe(fin);
    expect(JSON.stringify(fin)).toBe(snapshot);
    const a = out[0].assumptions as Record<string, unknown>;
    expect(a.solutionCalcRef).toBe(`sandbox-solution@${SOLUTION_VERSION}`);
    expect(a.roiRatio).toBe(4.0);
    expect(a.npv).toBe(100);
    expect(a[SOLUTION_SOURCE_FIELD]).toMatchObject({ scenarioId: SCEN, projectId: PROJ });
  });

  it("无有效来源 → 原样返回、绝不新增键", () => {
    const fin: SourceFinancialLike[] = [{ assumptions: { solutionCalcRef: "sandbox-solution@1.0.0" } }];
    const same = attachSolutionSource(fin, null);
    expect(same[0].assumptions).not.toHaveProperty(SOLUTION_SOURCE_FIELD);
    // 脏 id 也不污染。
    const dirty = attachSolutionSource(fin, { scenarioId: "nope" });
    expect((dirty[0].assumptions as Record<string, unknown>)[SOLUTION_SOURCE_FIELD]).toBeUndefined();
  });

  it("财务无 assumptions / assumptions 非对象 → 新建 { sandboxSource }", () => {
    const out = attachSolutionSource([{ }, { assumptions: "garbage" } as unknown as SourceFinancialLike], { scenarioId: SCEN });
    for (const f of out) {
      expect((f.assumptions as Record<string, unknown>)[SOLUTION_SOURCE_FIELD]).toMatchObject({ scenarioId: SCEN });
    }
  });
});

describe("readSolutionSourceFromFinancials · 只读回 + 诚实降级（R8.6）", () => {
  it("无来源 / 空数组 / assumptions 非对象 → null", () => {
    expect(readSolutionSourceFromFinancials([])).toBeNull();
    expect(readSolutionSourceFromFinancials([{ assumptions: null }])).toBeNull();
    expect(readSolutionSourceFromFinancials([{ assumptions: { solutionCalcRef: "x" } }])).toBeNull();
  });

  it("命中 → 逐字段原值读出；库里 sourceVersion 优先（保留审计真相）", () => {
    const fin: SourceFinancialLike[] = [
      { assumptions: { [SOLUTION_SOURCE_FIELD]: { kind: SOLUTION_SOURCE_KIND, scenarioId: SCEN, projectId: PROJ, sourceVersion: "0.9.0" } } },
    ];
    const ref = readSolutionSourceFromFinancials(fin)!;
    expect(ref.scenarioId).toBe(SCEN);
    expect(ref.projectId).toBe(PROJ);
    expect(ref.sourceVersion).toBe("0.9.0"); // 库里版本盖过本层版本
  });

  it("多条财务 → 取首条合法；脏 sandboxSource（两 id 皆非法）跳过、不冒充", () => {
    const fin: SourceFinancialLike[] = [
      { assumptions: { [SOLUTION_SOURCE_FIELD]: { scenarioId: "bad" } } }, // 脏，跳过
      { assumptions: { [SOLUTION_SOURCE_FIELD]: { scenarioId: SCEN } } }, // 命中
    ];
    const ref = readSolutionSourceFromFinancials(fin)!;
    expect(ref.scenarioId).toBe(SCEN);
  });

  it("非串脏值 → 该字段降 null（不冒充合法 id）", () => {
    const fin: SourceFinancialLike[] = [{ assumptions: { [SOLUTION_SOURCE_FIELD]: { scenarioId: 123, projectId: PROJ } } }];
    const ref = readSolutionSourceFromFinancials(fin)!;
    expect("scenarioId" in ref).toBe(false);
    expect(ref.projectId).toBe(PROJ);
  });
});

describe("describeSolutionSource · 只读文案（R8.6）", () => {
  it("null → null；仅情景 / 仅项目 / 二者都有 各出对应句", () => {
    expect(describeSolutionSource(null)).toBeNull();
    const both = describeSolutionSource({ kind: SOLUTION_SOURCE_KIND, scenarioId: SCEN, projectId: PROJ, sourceVersion: "1.0.0" })!;
    expect(both).toContain("情景");
    expect(both).toContain("项目");
    const onlyS = describeSolutionSource({ kind: SOLUTION_SOURCE_KIND, scenarioId: SCEN, sourceVersion: "1.0.0" } as SolutionSourceRef)!;
    expect(onlyS).toContain("情景");
    expect(onlyS).not.toContain("项目");
    const onlyP = describeSolutionSource({ kind: SOLUTION_SOURCE_KIND, projectId: PROJ, sourceVersion: "1.0.0" } as SolutionSourceRef)!;
    expect(onlyP).toContain("项目");
  });
});

describe("★反漂移：挂来源关联绝不破坏 R8.3 识别 / R8.4 复算（R8.6 命脉）", () => {
  it("attach 到真实草案财务后，沙盘识别仍成立、源值仍可复算", () => {
    const fins = draftFinancials();
    // 前置：真实草案财务本就无 sandboxSource（导出时未保存 → 不挂）。
    expect(readSolutionSourceFromFinancials(fins)).toBeNull();
    const attached = attachSolutionSource(fins, { scenarioId: SCEN, projectId: PROJ });
    // R8.3：仍识别为沙盘来源（solutionCalcRef 指纹未被覆盖）。
    expect(isModelSourcedSolution(attached)).toBe(true);
    // R8.4：源值 roiRatio/irrFraction/discountedPaybackYears 未被破坏 → 复算仍全绿。
    const rep = verifyReproducibility(attached[0] as never);
    expect(rep.reproducible).toBe(true);
    expect(rep.issues).toEqual([]);
    // 回读指针吻合。
    const ref = readSolutionSourceFromFinancials(attached)!;
    expect(ref.scenarioId).toBe(SCEN);
    expect(ref.projectId).toBe(PROJ);
  });
});

describe("确定性（R8.6）", () => {
  it("同输入两次深相等", () => {
    const a = normalizeSolutionSource({ scenarioId: SCEN, projectId: PROJ });
    const b = normalizeSolutionSource({ scenarioId: SCEN, projectId: PROJ });
    expect(a).toEqual(b);
    const fins = draftFinancials();
    expect(attachSolutionSource(fins, { scenarioId: SCEN })).toEqual(attachSolutionSource(fins, { scenarioId: SCEN }));
  });
});
