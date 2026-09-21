/**
 * S1 · 逐时储能物理不变量契约 —— 单测（零依赖 node 环境 · mandate §二十–§二十一）。
 *
 * ## 两类测各锁什么
 *   ① **符号对齐测（本文件的心脏）**：直接**读引擎源码** `balance.ts / types.ts / bess.ts`，
 *      逐字断言本契约引用的**每一个引擎字段名**与**守恒式左右两侧算式**、**SOC 越界判据**、
 *      **功率钳位**、**浮点容差 tol=1e-6** 仍然存在且一致——落实 §二十「符号必须与 engine 真实定义
 *      一致 · 不要凭空重写」：任一处被改名/删除/改判据，本测立刻红，逼维护者回到这里同步。
 *   ② **不变量体检测**：`checkSocBounds / checkPowerBounds / assertNoArbitragePeakShavingDoubleCount`
 *      在合成 fixture（够形状即可，**不依赖黄金**）上对"界内 / 越界 / 脏输入 / 序列不同长"逐条给结论。
 *
 *   另有**反算依赖守卫**：源模块除 `import type` 外不得有任何运行时 engine import，
 *   且不得调用 `computeBess( / computeEnergyBalance( / checkEnergyBalanceInvariant( /
 *   runCalculation( / runProjectModel(` —— 守恒式**只引用不重算**（§二十一禁第二套 runtime）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  HOURLY_BESS_INVARIANTS_VERSION,
  SOC_TOLERANCE_PCT,
  MANDATE_BALANCE_SYMBOL_TO_ENGINE_FIELD,
  ENGINE_ENERGY_BALANCE_EQUATION,
  ENGINE_BALANCE_AUTHORITATIVE_CHECKER,
  checkSocBounds,
  checkPowerBounds,
  assertNoArbitragePeakShavingDoubleCount,
  auditBessInvariants,
} from "@/server/hourly-bess-invariants";
import type { BessResult } from "@app/kernel/engine/types";

/** 反算守卫 token（清单只放测试里，源码不导出，避免"自己写禁令、自己撞禁令"）。 */
const FORBIDDEN_RUNTIME_TOKENS = [
  "computeBess(",
  "computeEnergyBalance(",
  "checkEnergyBalanceInvariant(",
  "runCalculation(",
  "runProjectModel(",
] as const;

/* ─────────────────────────── 迷你 fixture（够形状即可·非黄金） ─────────────────────────── */

function makeBess(overrides: Partial<BessResult> = {}): BessResult {
  return {
    chargeProfileKw: [0, 100, 200, 0, 0],
    dischargeProfileKw: [0, 0, 0, 150, 80],
    socProfilePct: [50, 60, 80, 55, 50],
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

const cleanCfg = { socMinPct: 10, socMaxPct: 90, energyKwh: 500, powerKw: 250 };

/* ═════════════════════════ ① 符号对齐心脏：读引擎源码钉字段 / 算式 / 判据 ═════════════════════════ */

describe("S1 · 符号对齐（§二十 不凭空重写）· 契约引用的引擎字段必须真实存在于 engine 源码", () => {
  const balanceSrc = readFileSync("kernel/src/engine/balance.ts", "utf8");
  const typesSrc = readFileSync("kernel/src/engine/types.ts", "utf8");
  const bessSrc = readFileSync("kernel/src/engine/bess.ts", "utf8");

  it("守恒式八元符号映射的目标字段全部在 balance.ts 的 checkEnergyBalanceInvariant 签名里出现", () => {
    const fields = Object.values(MANDATE_BALANCE_SYMBOL_TO_ENGINE_FIELD);
    // 至少覆盖 §二十 八个概念符号
    expect(fields).toHaveLength(8);
    for (const f of fields) {
      expect(balanceSrc, `balance.ts 缺守恒字段：${f}`).toContain(f);
    }
  });

  it("引擎守恒式左右两侧算式逐字仍在（本模块只做符号引用、不重算）", () => {
    // balance.ts: const lhs = pv + dis + imp;  const rhs = load + chg - uns + exp + cur;
    expect(balanceSrc).toContain("pv + dis + imp");
    expect(balanceSrc).toContain("load + chg - uns + exp + cur");
    expect(ENGINE_BALANCE_AUTHORITATIVE_CHECKER).toContain("checkEnergyBalanceInvariant");
    expect(balanceSrc).toContain("export function checkEnergyBalanceInvariant");
    expect(balanceSrc).toContain("BALANCE_MODEL_VERSION");
  });

  it("BessResult 真实字段名（soc/charge/discharge/violations/两腿收益）仍在 types.ts 声明", () => {
    for (const f of [
      "socProfilePct",
      "chargeProfileKw",
      "dischargeProfileKw",
      "socViolations",
      "arbitrageBenefitYuan",
      "demandChargeSavingYuan",
    ]) {
      expect(typesSrc, `types.ts 缺 BessResult 字段：${f}`).toContain(f);
    }
  });

  it("BessInput 额定功率/容量/SOC 界字段（powerKw/energyKwh/socMinPct/socMaxPct）仍在 types.ts 声明", () => {
    for (const f of ["powerKw", "energyKwh", "socMinPct", "socMaxPct"]) {
      expect(typesSrc, `types.ts 缺 BessInput 字段：${f}`).toContain(f);
    }
  });

  it("SOC 越界判据（socMin - tol / socMax + tol）与功率钳位（powerKw * DT_HOURS）仍逐字在 bess.ts", () => {
    expect(bessSrc).toContain("socMin - tol");
    expect(bessSrc).toContain("socMax + tol");
    expect(bessSrc).toContain("powerKw * DT_HOURS");
  });

  it("★ 本模块 SOC_TOLERANCE_PCT 必须等于引擎 bess.ts 的 tol=1e-6（漂移即报警）", () => {
    expect(bessSrc).toContain("const tol = 1e-6");
    expect(SOC_TOLERANCE_PCT).toBe(1e-6);
  });
});

/* ═════════════════════════ ② SOC 界 ═════════════════════════ */

describe("S1 · checkSocBounds（SOC ≥ 0 · SOC ≤ capacity · socMin%–socMax%）", () => {
  it("界内（含 clamp 生效界）→ ok=true、与引擎 socViolations=0 一致、能量形式在 [0,capacity]", () => {
    const r = checkSocBounds(makeBess(), cleanCfg);
    expect(r.ok).toBe(true);
    expect(r.effectiveMinPct).toBe(10);
    expect(r.effectiveMaxPct).toBe(90);
    expect(r.observedMinPct).toBe(50);
    expect(r.observedMaxPct).toBe(80);
    expect(r.socEnergyMinKwh).toBeGreaterThanOrEqual(0);
    expect(r.socEnergyMaxKwh).toBeLessThanOrEqual(r.capacityKwh);
    expect(r.violationCount).toBe(0);
    expect(r.agreesWithEngine).toBe(true);
    expect(r.engineSocViolations).toBe(0);
  });

  it("越上界（SOC> socMax）→ ok=false、violationCount 计数、note 含『越界』与次数", () => {
    const r = checkSocBounds(makeBess({ socProfilePct: [50, 60, 95, 91, 50], socViolations: 2 }), cleanCfg);
    expect(r.ok).toBe(false);
    expect(r.violationCount).toBe(2);
    expect(r.engineSocViolations).toBe(2);
    expect(r.agreesWithEngine).toBe(true);
    expect(r.note).toContain("越界");
    expect(r.samples.length).toBeGreaterThan(0);
    expect(r.samples[0].step).toBe(2);
  });

  it("越下界（SOC< socMin）也记违规", () => {
    const r = checkSocBounds(makeBess({ socProfilePct: [5, 60, 80, 55, 50], socViolations: 1 }), cleanCfg);
    expect(r.violationCount).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("生效界套用引擎 clamp：socMinPct 负 → 抬到 0；socMaxPct >100 → 压到 100；socMax<socMin → 抬到 socMin", () => {
    const r = checkSocBounds(makeBess({ socProfilePct: [0, 50, 100] }), { socMinPct: -10, socMaxPct: 120, energyKwh: 500 });
    expect(r.effectiveMinPct).toBe(0);
    expect(r.effectiveMaxPct).toBe(100);
    expect(r.ok).toBe(true); // 0 与 100 落在 [0,100]
  });

  it("脏 socProfilePct（null / 非数组）→ 视作空序列、observed=0、agreesWithEngine 由计数相等决定", () => {
    const r = checkSocBounds(makeBess({ socProfilePct: null as unknown as number[] }), cleanCfg);
    expect(r.effectiveMinPct).toBe(10);
    expect(r.observedMaxPct).toBe(0);
    expect(r.socEnergyMaxKwh).toBe(0);
  });

  it("本模块计数与引擎 socViolations 不一致 → agreesWithEngine=false（防御性双读报警）", () => {
    const r = checkSocBounds(makeBess({ socProfilePct: [50, 60, 80, 55, 50], socViolations: 3 }), cleanCfg);
    expect(r.violationCount).toBe(0);
    expect(r.engineSocViolations).toBe(3);
    expect(r.agreesWithEngine).toBe(false);
  });
});

/* ═════════════════════════ ③ 功率界 ═════════════════════════ */

describe("S1 · checkPowerBounds（chargePower ≤ ratedPower · dischargePower ≤ ratedPower）", () => {
  it("界内 → ok=true、max 如实、note 含额定值", () => {
    const r = checkPowerBounds(makeBess(), cleanCfg);
    expect(r.ok).toBe(true);
    expect(r.ratedPowerKw).toBe(250);
    expect(r.maxChargeKw).toBe(200);
    expect(r.maxDischargeKw).toBe(150);
    expect(r.chargeViolationCount).toBe(0);
    expect(r.dischargeViolationCount).toBe(0);
    expect(r.note).toContain("250");
  });

  it("充电超额定 → chargeViolationCount 计数、ok=false", () => {
    const r = checkPowerBounds(makeBess({ chargeProfileKw: [0, 300, 260, 0, 0] }), cleanCfg);
    expect(r.chargeViolationCount).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.maxChargeKw).toBe(300);
    expect(r.samples.some((s) => s.leg === "charge")).toBe(true);
  });

  it("放电超额定 → dischargeViolationCount 计数", () => {
    const r = checkPowerBounds(makeBess({ dischargeProfileKw: [0, 0, 0, 400, 80] }), cleanCfg);
    expect(r.dischargeViolationCount).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("额定功率脏输入（<=0 / NaN）→ rated 归 0，任何正功率判越界（保守、不假装通过）", () => {
    const r = checkPowerBounds(makeBess(), { powerKw: NaN });
    expect(r.ratedPowerKw).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.chargeViolationCount).toBeGreaterThan(0);
  });
});

/* ═════════════════════════ ④ 套利 + 削峰不能双算 ═════════════════════════ */

describe("S1 · assertNoArbitragePeakShavingDoubleCount（One Battery → One SOC → One dispatch）", () => {
  it("三序列同长 + socViolations=0 → ok=true、合计=两腿相加、same dispatch", () => {
    const g = assertNoArbitragePeakShavingDoubleCount(makeBess());
    expect(g.ok).toBe(true);
    expect(g.sharesOneChronologicalDispatch).toBe(true);
    expect(g.singleSocBudgetConsistent).toBe(true);
    expect(g.arbitrageBenefitYuan).toBe(320_000);
    expect(g.demandChargeSavingYuan).toBe(90_000);
    expect(g.totalBessBenefitYuan).toBe(410_000);
    expect(g.note).toContain("同一份 SOC");
  });

  it("序列长度不一致（非同一时间轴）→ sharesOneChronologicalDispatch=false、拒绝下'单一调度'结论", () => {
    const g = assertNoArbitragePeakShavingDoubleCount(
      makeBess({ socProfilePct: [50, 60, 80], chargeProfileKw: [0, 100], dischargeProfileKw: [0, 0, 50] }),
    );
    expect(g.sharesOneChronologicalDispatch).toBe(false);
    expect(g.ok).toBe(false);
    expect(g.note).toContain("序列长度不一致");
  });

  it("socViolations>0 → 单份预算不自洽、禁止合并讲", () => {
    const g = assertNoArbitragePeakShavingDoubleCount(makeBess({ socViolations: 2 }));
    expect(g.singleSocBudgetConsistent).toBe(false);
    expect(g.ok).toBe(false);
    expect(g.note).toContain("越界");
  });
});

/* ═════════════════════════ ⑤ 聚合体检 ═════════════════════════ */

describe("S1 · auditBessInvariants（聚合）", () => {
  it("干净输入 → allOk=true、带守恒式符号契约 + 版本号", () => {
    const a = auditBessInvariants(makeBess(), cleanCfg);
    expect(a.soc.ok).toBe(true);
    expect(a.power.ok).toBe(true);
    expect(a.doubleCount.ok).toBe(true);
    expect(a.allOk).toBe(true);
    expect(a.version).toBe(HOURLY_BESS_INVARIANTS_VERSION);
    expect(a.energyBalanceContract.equation).toBe(ENGINE_ENERGY_BALANCE_EQUATION);
    expect(a.energyBalanceContract.symbolToEngineField.Unserved).toBe("unservedProfileKw");
    expect(a.energyBalanceContract.authoritativeChecker).toContain("balance.ts");
  });

  it("任一子项越界 → allOk=false（本层体检，不宣称'引擎全对'）", () => {
    const a = auditBessInvariants(
      makeBess({ socProfilePct: [50, 60, 999, 55, 50], socViolations: 1 }),
      cleanCfg,
    );
    expect(a.allOk).toBe(false);
  });
});

/* ═════════════════════════ ⑥ 版本契约（不钉精确值·防漂） ═════════════════════════ */

describe("S1 · hourly-bess-invariants · 版本契约", () => {
  it("语义化正则 + major/minor/patch floor 单调", () => {
    expect(HOURLY_BESS_INVARIANTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = HOURLY_BESS_INVARIANTS_VERSION.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(1);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });
});

/* ═════════════════════════ ⑦ 反算依赖守卫（唯一硬约束） ═════════════════════════ */

describe("S1 · 反算依赖守卫：本模块不得重算守恒 / 不得运行时 import engine", () => {
  const src = readFileSync("src/server/hourly-bess-invariants.ts", "utf8");

  it("只允许 `import type ... from \"@app/kernel/engine/types\"`，禁止任何运行时 engine import", () => {
    const importLikeLines = src
      .split(/\r?\n/)
      .filter((l) => /^\s*(import|export)\b|require\s*\(/.test(l));
    const runtimeEngineImports = importLikeLines
      .filter((l) => /from\s+["']@app\/kernel\/engine\//.test(l))
      .filter((l) => !/^\s*import\s+type\s/.test(l));
    expect(runtimeEngineImports, `发现运行时 engine import：\n${runtimeEngineImports.join("\n")}`).toEqual([]);
  });

  it("代码行不得出现任何计算/守恒重算入口 token（只引用不重算）", () => {
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
      expect(joined, `不该出现重算入口：${token}`).not.toContain(token);
    }
  });
});
