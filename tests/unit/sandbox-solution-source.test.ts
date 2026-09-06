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
 *   - ★反漂移端到端：attach 到 **R8.1 真实草案**财务后，R8.3 `isSandboxSourcedSolution` 仍 true、
 *     R8.4 `verifyReproducibility` 仍可复算（源值未被覆盖）→ 证「挂来源关联」绝不破坏既有溯源脊柱。
 *   - describe：无来源 null；仅情景 / 仅项目 / 二者都有各出对应句。
 *   - 确定性（同输入两次深相等）。
 */
import { describe, it, expect } from "vitest";
import {
  SANDBOX_SOLUTION_SOURCE_VERSION,
  SANDBOX_SOURCE_FIELD,
  SANDBOX_SOURCE_KIND,
  normalizeSandboxSource,
  attachSandboxSource,
  readSandboxSourceFromFinancials,
  describeSandboxSource,
  type SandboxSourceRef,
  type SourceFinancialLike,
} from "@/lib/sandbox-solution-source";
import { SANDBOX_SOLUTION_VERSION, buildSandboxSolutionDraft } from "@/lib/sandbox-solution";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import { runSandboxModelBaseline } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import { isSandboxSourcedSolution } from "@/lib/sandbox-solution-lineage";
import { verifyReproducibility } from "@/lib/sandbox-solution-provenance";

// 合法 cuid 形状（c + 小写字母数字，20–32 长）；造两个可区分的 id。
const SCEN = "c" + "s1enario0aaaa1bbbb2cccc3".slice(0, 24); // 长度合规、含数字小写字母
const PROJ = "c" + "p1roject0dddd4eeee5ffff6".slice(0, 24);

function draftFinancials() {
  const calc = runSandboxModelBaseline();
  const resolved = resolveSandbox({});
  const tech = calc.ok ? computeTechModel(resolved.numeric) : null;
  const tornado = computeTornado({});
  const vm = buildSandboxViewModel({ calc, tech: tech && tech.ok ? tech.firstYear : null, tornado, discountRate: 0.08 });
  const draft = buildSandboxSolutionDraft({ calc, vm, regionName: "山西" });
  if (!draft.ok) throw new Error("测试前置：真实引擎链应产出成功草案");
  return draft.financials;
}

describe("sandbox-solution-source · 版本与常量（R8.6）", () => {
  it("版本语义化 + 字段 / kind 常量稳定", () => {
    expect(SANDBOX_SOLUTION_SOURCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SANDBOX_SOURCE_FIELD).toBe("sandboxSource");
    expect(SANDBOX_SOURCE_KIND).toBe("sandbox-scenario");
  });
});

describe("normalizeSandboxSource · 形状归一（R8.6）", () => {
  it("两 id 齐 → 归出 ref（带 kind + sourceVersion）", () => {
    const ref = normalizeSandboxSource({ scenarioId: SCEN, projectId: PROJ });
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe(SANDBOX_SOURCE_KIND);
    expect(ref!.scenarioId).toBe(SCEN);
    expect(ref!.projectId).toBe(PROJ);
    expect(ref!.sourceVersion).toBe(SANDBOX_SOLUTION_SOURCE_VERSION);
  });

  it("仅一个 id → 另一键省略（不塞空串 / null）", () => {
    const only = normalizeSandboxSource({ scenarioId: SCEN })!;
    expect(only.scenarioId).toBe(SCEN);
    expect("projectId" in only).toBe(false);
    const onlyP = normalizeSandboxSource({ projectId: PROJ })!;
    expect("scenarioId" in onlyP).toBe(false);
  });

  it("非串 / 脏串 / 空 / 越界 → null（绝不虚构指针）", () => {
    expect(normalizeSandboxSource(null)).toBeNull();
    expect(normalizeSandboxSource(undefined)).toBeNull();
    expect(normalizeSandboxSource({})).toBeNull();
    expect(normalizeSandboxSource({ scenarioId: null, projectId: undefined })).toBeNull();
    expect(normalizeSandboxSource({ scenarioId: "not-a-cuid" })).toBeNull();
    expect(normalizeSandboxSource({ scenarioId: "c短" })).toBeNull(); // 非 [a-z0-9]
    expect(normalizeSandboxSource({ scenarioId: "  " })).toBeNull();
  });

  it("带空白的合法 id → trim 后接受", () => {
    const ref = normalizeSandboxSource({ scenarioId: `  ${SCEN}  ` })!;
    expect(ref.scenarioId).toBe(SCEN);
  });
});

describe("attachSandboxSource · 不可变合并 + 不破坏脊柱（R8.6 ★核心）", () => {
  it("★追加 sandboxSource 同时保住既有溯源键，且不改入参对象", () => {
    const fin: SourceFinancialLike[] = [
      { assumptions: { solutionCalcRef: `sandbox-solution@${SANDBOX_SOLUTION_VERSION}`, roiRatio: 4.0, npv: 100 } },
    ];
    const snapshot = JSON.stringify(fin);
    const out = attachSandboxSource(fin, { scenarioId: SCEN, projectId: PROJ });
    // 新数组、非同一引用；入参原样未被就地修改。
    expect(out).not.toBe(fin);
    expect(JSON.stringify(fin)).toBe(snapshot);
    const a = out[0].assumptions as Record<string, unknown>;
    expect(a.solutionCalcRef).toBe(`sandbox-solution@${SANDBOX_SOLUTION_VERSION}`);
    expect(a.roiRatio).toBe(4.0);
    expect(a.npv).toBe(100);
    expect(a[SANDBOX_SOURCE_FIELD]).toMatchObject({ scenarioId: SCEN, projectId: PROJ });
  });

  it("无有效来源 → 原样返回、绝不新增键", () => {
    const fin: SourceFinancialLike[] = [{ assumptions: { solutionCalcRef: "sandbox-solution@1.0.0" } }];
    const same = attachSandboxSource(fin, null);
    expect(same[0].assumptions).not.toHaveProperty(SANDBOX_SOURCE_FIELD);
    // 脏 id 也不污染。
    const dirty = attachSandboxSource(fin, { scenarioId: "nope" });
    expect((dirty[0].assumptions as Record<string, unknown>)[SANDBOX_SOURCE_FIELD]).toBeUndefined();
  });

  it("财务无 assumptions / assumptions 非对象 → 新建 { sandboxSource }", () => {
    const out = attachSandboxSource([{ }, { assumptions: "garbage" } as unknown as SourceFinancialLike], { scenarioId: SCEN });
    for (const f of out) {
      expect((f.assumptions as Record<string, unknown>)[SANDBOX_SOURCE_FIELD]).toMatchObject({ scenarioId: SCEN });
    }
  });
});

describe("readSandboxSourceFromFinancials · 只读回 + 诚实降级（R8.6）", () => {
  it("无来源 / 空数组 / assumptions 非对象 → null", () => {
    expect(readSandboxSourceFromFinancials([])).toBeNull();
    expect(readSandboxSourceFromFinancials([{ assumptions: null }])).toBeNull();
    expect(readSandboxSourceFromFinancials([{ assumptions: { solutionCalcRef: "x" } }])).toBeNull();
  });

  it("命中 → 逐字段原值读出；库里 sourceVersion 优先（保留审计真相）", () => {
    const fin: SourceFinancialLike[] = [
      { assumptions: { [SANDBOX_SOURCE_FIELD]: { kind: SANDBOX_SOURCE_KIND, scenarioId: SCEN, projectId: PROJ, sourceVersion: "0.9.0" } } },
    ];
    const ref = readSandboxSourceFromFinancials(fin)!;
    expect(ref.scenarioId).toBe(SCEN);
    expect(ref.projectId).toBe(PROJ);
    expect(ref.sourceVersion).toBe("0.9.0"); // 库里版本盖过本层版本
  });

  it("多条财务 → 取首条合法；脏 sandboxSource（两 id 皆非法）跳过、不冒充", () => {
    const fin: SourceFinancialLike[] = [
      { assumptions: { [SANDBOX_SOURCE_FIELD]: { scenarioId: "bad" } } }, // 脏，跳过
      { assumptions: { [SANDBOX_SOURCE_FIELD]: { scenarioId: SCEN } } }, // 命中
    ];
    const ref = readSandboxSourceFromFinancials(fin)!;
    expect(ref.scenarioId).toBe(SCEN);
  });

  it("非串脏值 → 该字段降 null（不冒充合法 id）", () => {
    const fin: SourceFinancialLike[] = [{ assumptions: { [SANDBOX_SOURCE_FIELD]: { scenarioId: 123, projectId: PROJ } } }];
    const ref = readSandboxSourceFromFinancials(fin)!;
    expect("scenarioId" in ref).toBe(false);
    expect(ref.projectId).toBe(PROJ);
  });
});

describe("describeSandboxSource · 只读文案（R8.6）", () => {
  it("null → null；仅情景 / 仅项目 / 二者都有 各出对应句", () => {
    expect(describeSandboxSource(null)).toBeNull();
    const both = describeSandboxSource({ kind: SANDBOX_SOURCE_KIND, scenarioId: SCEN, projectId: PROJ, sourceVersion: "1.0.0" })!;
    expect(both).toContain("情景");
    expect(both).toContain("项目");
    const onlyS = describeSandboxSource({ kind: SANDBOX_SOURCE_KIND, scenarioId: SCEN, sourceVersion: "1.0.0" } as SandboxSourceRef)!;
    expect(onlyS).toContain("情景");
    expect(onlyS).not.toContain("项目");
    const onlyP = describeSandboxSource({ kind: SANDBOX_SOURCE_KIND, projectId: PROJ, sourceVersion: "1.0.0" } as SandboxSourceRef)!;
    expect(onlyP).toContain("项目");
  });
});

describe("★反漂移：挂来源关联绝不破坏 R8.3 识别 / R8.4 复算（R8.6 命脉）", () => {
  it("attach 到真实草案财务后，沙盘识别仍成立、源值仍可复算", () => {
    const fins = draftFinancials();
    // 前置：真实草案财务本就无 sandboxSource（导出时未保存 → 不挂）。
    expect(readSandboxSourceFromFinancials(fins)).toBeNull();
    const attached = attachSandboxSource(fins, { scenarioId: SCEN, projectId: PROJ });
    // R8.3：仍识别为沙盘来源（solutionCalcRef 指纹未被覆盖）。
    expect(isSandboxSourcedSolution(attached)).toBe(true);
    // R8.4：源值 roiRatio/irrFraction/discountedPaybackYears 未被破坏 → 复算仍全绿。
    const rep = verifyReproducibility(attached[0] as never);
    expect(rep.reproducible).toBe(true);
    expect(rep.issues).toEqual([]);
    // 回读指针吻合。
    const ref = readSandboxSourceFromFinancials(attached)!;
    expect(ref.scenarioId).toBe(SCEN);
    expect(ref.projectId).toBe(PROJ);
  });
});

describe("确定性（R8.6）", () => {
  it("同输入两次深相等", () => {
    const a = normalizeSandboxSource({ scenarioId: SCEN, projectId: PROJ });
    const b = normalizeSandboxSource({ scenarioId: SCEN, projectId: PROJ });
    expect(a).toEqual(b);
    const fins = draftFinancials();
    expect(attachSandboxSource(fins, { scenarioId: SCEN })).toEqual(attachSandboxSource(fins, { scenarioId: SCEN }));
  });
});
