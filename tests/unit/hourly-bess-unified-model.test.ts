/**
 * S1 · 逐时储能统一模型骨架 —— 单测（零依赖 node 环境）。
 *
 * ## 它锁的是什么
 *   ① `buildUnifiedSummary` **纯投影**：把 V2 已算好的 `BessResult + GridResult` 投到"同一份 SOC 预算"
 *      的统一视图；SOC 越界 = 0 时 `socBudgetIntegrity.ok=true`，> 0 时**必须报警**、note 里含次数。
 *      套利腿 + 削峰腿**合计等于**二者相加、脏输入（NaN / null）折 0 不假装。
 *   ② `computePathAAnalyticalPeakKw`：解析口径**独立复算**，`chargerInstalledKw × Kc × φ + station非充电峰`
 *      再乘 `price × 12`；kc / φ 出 [0,1] 或负 → 相应项归零 + `inputSanitized=true`（不假装成功）。
 *   ③ `comparePathA_vs_PathB`：三项差值（kW / % / 元）+ 一句人话；`|diff|<1kW` → "几无影响"、
 *      `diff>0` → 收口"变贵"、`diff<0` → 收口"让客户少花"；Path A = 0 → `diffPctVsPathA=null` 而非 Infinity；
 *      若 `annualDemandChargeYuanFromEngine` 给了非负有限数 → 优先用它，忽略 price×kw×12。
 *   ④ **反算依赖守卫**（S1 骨架的**唯一硬约束**）：源文件不得出现任何指向 `@app/kernel/engine/...`
 *      的**运行时** import（只允许 `import type ... from "@app/kernel/engine/types"`），且不得调用
 *      `runBess(` / `runGrid(` / `runCalculation(` / `runProjectModel(` / `storageValueDelta(` /
 *      `computeDecisionSnapshot(` —— 把"不重算、不改口径"钉成**结构事实**，同 R7-A / R7-B / R8 守卫。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  HOURLY_BESS_UNIFIED_MODEL_VERSION,
  buildUnifiedSummary,
  computePathAAnalyticalPeakKw,
  comparePathA_vs_PathB,
  type PathADemandInput,
  type PathBPhysicalInput,
} from "@/server/hourly-bess-unified-model";
import type { BessResult, GridResult } from "@app/kernel/engine/types";

/** 反算依赖守卫的调用点 token（**清单只放测试里**，源码不导出，避免"自己写禁令、自己撞禁令"）。 */
const FORBIDDEN_RUNTIME_TOKENS = [
  "runBess(",
  "runGrid(",
  "runCalculation(",
  "runProjectModel(",
  "storageValueDelta(",
  "computeDecisionSnapshot(",
] as const;

/* ─────────────────────────── 迷你 fixture（够形状即可） ─────────────────────────── */

function makeBess(overrides: Partial<BessResult> = {}): BessResult {
  return {
    chargeProfileKw: [0, 100, 200, 0],
    dischargeProfileKw: [0, 0, 50, 150],
    socProfilePct: [50, 60, 80, 40],
    annualChargeKwh: 120_000,
    annualDischargeKwh: 100_000,
    equivalentCycles: 180,
    arbitrageBenefitYuan: 320_000,
    demandChargeSavingYuan: 90_000,
    finalSocPct: 50,
    socViolations: 0,
    ...overrides,
  } as BessResult;
}

function makeGrid(overrides: Partial<GridResult> = {}): GridResult {
  return {
    importProfileKwh: [10, 200, 320, 40],
    exportProfileKwh: [0, 0, 0, 0],
    priceProfileYuanPerKwh: [0.3, 0.8, 1.1, 0.6],
    curtailmentProfileKwh: [0, 0, 0, 0],
    annualImportKwh: 1_000_000,
    annualExportKwh: 0,
    annualEnergyCostYuan: 700_000,
    annualExportRevenueYuan: 0,
    annualDemandChargeYuan: 1_080_000,
    annualGridCostYuan: 1_780_000,
    weightedAveragePriceYuanPerKwh: 0.7,
    monthlyPeakImportKw: [800, 820, 900, 950, 1000, 1100, 1150, 1120, 1080, 1020, 960, 880],
    capacityConstrained: false,
    ...overrides,
  } as GridResult;
}

/* ═════════════════════════ ① 版本契约（不钉精确值，防漂） ═════════════════════════ */

describe("S1 · hourly-bess-unified-model · 版本契约", () => {
  it("HOURLY_BESS_UNIFIED_MODEL_VERSION 语义化正则 + floor 单调", () => {
    expect(HOURLY_BESS_UNIFIED_MODEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = HOURLY_BESS_UNIFIED_MODEL_VERSION.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(1);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });

  it("FORBIDDEN_RUNTIME_TOKENS 覆盖所有关键计算入口（缺一项即回退本测试）", () => {
    const tokens = new Set<string>(FORBIDDEN_RUNTIME_TOKENS);
    for (const must of [
      "runBess(",
      "runGrid(",
      "runCalculation(",
      "runProjectModel(",
      "storageValueDelta(",
      "computeDecisionSnapshot(",
    ]) {
      expect(tokens.has(must), `守卫清单缺：${must}`).toBe(true);
    }
  });
});

/* ═════════════════════════ ② buildUnifiedSummary · 纯投影 ═════════════════════════ */

describe("S1 · buildUnifiedSummary · 同一 SOC 预算的统一视图（纯投影）", () => {
  it("干净输入：套利腿 + 削峰腿合计 = 二者相加；sameSocBudget=true、ok=true、note 含『同源』字样", () => {
    const summary = buildUnifiedSummary(makeBess(), makeGrid());
    expect(summary.socBudgetIntegrity.ok).toBe(true);
    expect(summary.socBudgetIntegrity.sameSocBudget).toBe(true);
    expect(summary.socBudgetIntegrity.note).toContain("同源");
    expect(summary.arbitrageBenefitYuan).toBe(320_000);
    expect(summary.demandChargeSavingYuan).toBe(90_000);
    expect(summary.totalBessBenefitYuan).toBe(410_000);
    expect(summary.monthlyPeakImportKw).toHaveLength(12);
    expect(summary.annualNetPeakKw).toBe(1150);
    expect(summary.months).toBe(12);
    expect(summary.socViolations).toBe(0);
    expect(summary.equivalentCycles).toBe(180);
    expect(summary.annualChargeKwh).toBe(120_000);
    expect(summary.annualDischargeKwh).toBe(100_000);
  });

  it("SOC 越界 → integrity.ok=false，note 明确含越界次数（拒绝把两腿讲成同一预算已闭合）", () => {
    const summary = buildUnifiedSummary(makeBess({ socViolations: 3 }), makeGrid());
    expect(summary.socViolations).toBe(3);
    expect(summary.socBudgetIntegrity.ok).toBe(false);
    expect(summary.socBudgetIntegrity.sameSocBudget).toBe(true); // 结构性声明，仍是同一份
    expect(summary.socBudgetIntegrity.note).toContain("3");
    expect(summary.socBudgetIntegrity.note).toContain("越界");
  });

  it("脏输入（NaN / null / 非数组）→ 全部折 0 或空数组，不改输入、不假装成功", () => {
    const dirtyBess = {
      ...makeBess(),
      arbitrageBenefitYuan: NaN,
      demandChargeSavingYuan: Infinity,
      socProfilePct: null,
      chargeProfileKw: undefined,
      annualChargeKwh: -100,
    } as unknown as BessResult;
    const dirtyGrid = {
      ...makeGrid(),
      monthlyPeakImportKw: [NaN, 900, null as unknown as number, 1000, 800, 700, 600, 500, 400, 300, 200, 100],
      importProfileKwh: undefined,
    } as unknown as GridResult;
    const summary = buildUnifiedSummary(dirtyBess, dirtyGrid);
    expect(Number.isFinite(summary.arbitrageBenefitYuan)).toBe(true);
    expect(summary.arbitrageBenefitYuan).toBe(0);
    expect(Number.isFinite(summary.demandChargeSavingYuan)).toBe(true);
    expect(summary.demandChargeSavingYuan).toBe(0);
    expect(summary.totalBessBenefitYuan).toBe(0);
    expect(summary.socProfilePct).toEqual([]);
    expect(summary.chargeProfileKw).toEqual([]);
    expect(summary.importProfileKwh).toEqual([]);
    expect(summary.monthlyPeakImportKw.every((v) => Number.isFinite(v))).toBe(true);
    // 峰值取 1000（NaN / null 不参与）
    expect(summary.annualNetPeakKw).toBe(1000);
  });

  it("monthlyPeakImportKw 非 12 元素（如 6）→ months 如实反映、不硬凑", () => {
    const g = makeGrid({ monthlyPeakImportKw: [500, 600, 700, 800, 900, 1000] } as Partial<GridResult>);
    const summary = buildUnifiedSummary(makeBess(), g);
    expect(summary.months).toBe(6);
    expect(summary.annualNetPeakKw).toBe(1000);
  });
});

/* ═════════════════════════ ③ computePathAAnalyticalPeakKw · 解析口径复算 ═════════════════════════ */

describe("S1 · computePathAAnalyticalPeakKw · Path A 解析口径复算", () => {
  it("干净输入：1000 kW × 0.7 × 0.6 + 200 kW = 620 kW · 计费电费 = 620 × 40 × 12 = 297,600", () => {
    const out = computePathAAnalyticalPeakKw({
      chargerInstalledKw: 1000,
      kc: 0.7,
      phi: 0.6,
      stationNonChargePeakKw: 200,
      demandChargeYuanPerKwMonth: 40,
    });
    expect(out.chargingContributionKw).toBe(420);
    expect(out.billedDemandKw).toBe(620);
    expect(out.annualDemandChargeYuan).toBe(297_600);
    expect(out.inputSanitized).toBe(false);
  });

  it("kc 越界（>1）→ 归零、billed 只留站点峰、inputSanitized=true（不假装算对）", () => {
    const out = computePathAAnalyticalPeakKw({
      chargerInstalledKw: 1000,
      kc: 1.5,
      phi: 0.6,
      stationNonChargePeakKw: 200,
      demandChargeYuanPerKwMonth: 40,
    });
    expect(out.chargingContributionKw).toBe(0);
    expect(out.billedDemandKw).toBe(200);
    expect(out.inputSanitized).toBe(true);
  });

  it("φ 负值 → 归零、inputSanitized=true", () => {
    const out = computePathAAnalyticalPeakKw({
      chargerInstalledKw: 1000,
      kc: 0.7,
      phi: -0.2,
      stationNonChargePeakKw: 200,
      demandChargeYuanPerKwMonth: 40,
    });
    expect(out.chargingContributionKw).toBe(0);
    expect(out.inputSanitized).toBe(true);
  });

  it("需量电价 2030 政策 = 0（V1 侧政策字面直传）→ 年费 0、billed kW 仍如实给", () => {
    const out = computePathAAnalyticalPeakKw({
      chargerInstalledKw: 1000,
      kc: 0.7,
      phi: 0.6,
      stationNonChargePeakKw: 200,
      demandChargeYuanPerKwMonth: 0,
    });
    expect(out.billedDemandKw).toBe(620);
    expect(out.annualDemandChargeYuan).toBe(0);
    expect(out.inputSanitized).toBe(false);
  });
});

/* ═════════════════════════ ④ comparePathA_vs_PathB · 差值对照器 ═════════════════════════ */

describe("S1 · comparePathA_vs_PathB · Path A vs Path B 差值对照", () => {
  const baseA: PathADemandInput = {
    chargerInstalledKw: 1000,
    kc: 0.7,
    phi: 0.6,
    stationNonChargePeakKw: 200,
    demandChargeYuanPerKwMonth: 40,
  };

  it("A ≈ B（|diff|<1kW）→ 解读为『几无影响 · 迁移成本低』", () => {
    const b: PathBPhysicalInput = {
      monthlyPeakImportKw: Array.from({ length: 12 }, () => 620), // 全部 620
      demandChargeYuanPerKwMonth: 40,
    };
    const c = comparePathA_vs_PathB(baseA, b);
    expect(Math.abs(c.diffKw)).toBeLessThan(1);
    expect(c.interpretation).toContain("几无影响");
    expect(c.pathA.billedDemandKw).toBe(620);
    expect(c.pathB.annualBilledDemandKw).toBe(620);
  });

  it("B > A → 解读为『变贵 · 须先与客户对齐』；diffKw、diffYuan 均为正", () => {
    const b: PathBPhysicalInput = {
      monthlyPeakImportKw: [700, 720, 750, 800, 850, 900, 950, 920, 880, 800, 750, 700],
      demandChargeYuanPerKwMonth: 40,
    };
    const c = comparePathA_vs_PathB(baseA, b);
    expect(c.diffKw).toBe(330); // 950 - 620
    expect(c.diffPctVsPathA).toBeCloseTo(0.5323, 3);
    expect(c.diffYuan).toBe(158_400); // (950 - 620) × 40 × 12
    expect(c.interpretation).toContain("变贵");
    expect(c.pathB.annualDemandChargeYuan).toBe(456_000); // 950 × 40 × 12
  });

  it("B < A → 解读为『Path A 偏保守 · 让客户少花』；diffKw、diffYuan 为负", () => {
    const b: PathBPhysicalInput = {
      monthlyPeakImportKw: Array.from({ length: 12 }, () => 500),
      demandChargeYuanPerKwMonth: 40,
    };
    const c = comparePathA_vs_PathB(baseA, b);
    expect(c.diffKw).toBe(-120);
    expect(c.diffYuan).toBe(-57_600);
    expect(c.interpretation).toContain("让客户少花");
  });

  it("Path A billed=0（如 station=0 + 脏输入让 kc 归零）→ diffPctVsPathA 明确 null 而非 Infinity", () => {
    const b: PathBPhysicalInput = {
      monthlyPeakImportKw: Array.from({ length: 12 }, () => 300),
      demandChargeYuanPerKwMonth: 40,
    };
    const c = comparePathA_vs_PathB(
      { ...baseA, chargerInstalledKw: 0, stationNonChargePeakKw: 0 },
      b,
    );
    expect(c.pathA.billedDemandKw).toBe(0);
    expect(c.diffPctVsPathA).toBeNull();
    expect(Number.isFinite(c.diffYuan)).toBe(true);
  });

  it("annualDemandChargeYuanFromEngine 给了非负有限数 → 优先采用、忽略 price × peak × 12", () => {
    const b: PathBPhysicalInput = {
      monthlyPeakImportKw: Array.from({ length: 12 }, () => 900),
      demandChargeYuanPerKwMonth: 40,
      annualDemandChargeYuanFromEngine: 250_000, // 引擎实际给的值（不同于 price×max×12）
    };
    const c = comparePathA_vs_PathB(baseA, b);
    expect(c.pathB.annualDemandChargeYuan).toBe(250_000);
    // price × 900 × 12 = 432_000 会被 250_000 覆盖 → diffYuan = 250000 - 297600 = -47_600
    expect(c.diffYuan).toBe(-47_600);
  });

  it("脏 Path B 输入（非数组 monthly）→ bSanitized=true、annualBilled=0，仍给可比数字", () => {
    const b = {
      monthlyPeakImportKw: null as unknown as number[],
      demandChargeYuanPerKwMonth: 40,
    } as PathBPhysicalInput;
    const c = comparePathA_vs_PathB(baseA, b);
    expect(c.pathB.inputSanitized).toBe(true);
    expect(c.pathB.annualBilledDemandKw).toBe(0);
    expect(c.diffKw).toBe(-620);
  });
});

/* ═════════════════════════ ⑤ 反算依赖守卫（S1 唯一硬约束） ═════════════════════════ */

describe("S1 · 反算依赖守卫：本模块不得调用任何计算函数 / 不得运行时 import engine", () => {
  const src = readFileSync("src/server/hourly-bess-unified-model.ts", "utf8");

  it("只允许 `import type ... from \"@app/kernel/engine/types\"`（编译期擦除），禁止任何运行时 engine import", () => {
    // 只匹配**真正的 import 语句**（行首 `import` / `export` / `require(`），跳过注释里出现的示例串。
    const importLikeLines = src
      .split(/\r?\n/)
      .filter((l) => /^\s*(import|export)\b|require\s*\(/.test(l));
    const runtimeEngineImports = importLikeLines
      .filter((l) => /from\s+["']@app\/kernel\/engine\//.test(l))
      .filter((l) => !/^\s*import\s+type\s/.test(l));
    expect(
      runtimeEngineImports,
      `发现运行时 engine import（S1 骨架禁止）：\n${runtimeEngineImports.join("\n")}`,
    ).toEqual([]);
  });

  it("代码行不得出现任何计算入口 token（runBess / runGrid / runCalculation / runProjectModel / storageValueDelta / computeDecisionSnapshot）", () => {
    // 排除注释里的字面出现：只保留代码行（跳过 `//`、`/*`、`*`、以及 JSDoc 续行）
    const codeLines = src
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.startsWith("//"))
      .filter((l) => !l.startsWith("/*"))
      .filter((l) => !l.startsWith("*"))
      .filter((l) => !l.startsWith("*/"));
    const joined = codeLines.join("\n");
    for (const token of FORBIDDEN_RUNTIME_TOKENS) {
      expect(joined, `S1 骨架不该调用：${token}`).not.toContain(token);
    }
  });
});
