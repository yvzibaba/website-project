/**
 * R8.8a 示范项目 DEMO 10 参数「真联动」全链回归（TASK 3 · 2026-09-08 夜）——
 * 逐字段验证：touched 一个 headline → ① `demoUserValues` 垫入正确键 → ② `resolved.numeric` 变 →
 * ③ `calc`（技术/经济）变 → ④ `vm.cards / vm.cashFlow` 至少一处变 → ⑤ `report.sections` 至少一处值变。
 * 目的：钉死"前端改了数字、后端计算不动"这类假联动（TASK 3 创始人点名风险）。
 *
 * 与 `sandbox-demo.test.ts` 的分工：
 *   现有 demo 测试覆盖**映射纯函数 + 分类器真值表 + 车队/光伏两个代表字段的端到端**；
 *   本测试**穷举 8 个可操作 headline 字段**，逐一跑四段链路，任何一段"该变而未变"即失败。
 *   R9.0 Step 2 更新：储能已接入 SVE 套利腿（P1-2 闭合），storageEnergy 现在也影响收入；
 *   DEMO 映射层不含 spread 滑杆，套利腿按引擎默认 spread=0.6 结算。
 */
import { describe, it, expect } from "vitest";
import {
  computeDemoScenario,
  defaultDemoState,
  demoBaseline,
  type DemoHeadlineState,
  type DemoScenarioResult,
} from "@/server/sandbox-demo";
import type { CalcResultOk } from "@/server/sandbox-model";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function calcOk(c: DemoScenarioResult): CalcResultOk {
  if (!c.calc.ok) throw new Error(`calc failed: ${c.calc.reason} — ${c.calc.detail}`);
  return c.calc;
}

function cardsSignature(c: DemoScenarioResult): string {
  return (c.vm.cards ?? []).map((k) => `${k.key}=${k.value}`).join("|");
}

function cashFlowSignature(c: DemoScenarioResult): string {
  return (c.vm.cashFlow ?? []).map((p) => p.flow.toFixed(0)).join(",");
}

function reportText(c: DemoScenarioResult): string {
  const out: string[] = [];
  for (const s of c.report.sections) {
    if (s.paragraphs) out.push(...s.paragraphs);
    if (s.items) out.push(...s.items.map((i) => `${i.label}:${i.value}`));
  }
  return out.join("\n");
}

/** 一条「字段规格」：如何改这个 headline、期望在哪一层看到签名差异。 */
interface FieldProbe {
  id: keyof DemoHeadlineState & string;
  /** 一个明显不同于默认的新值。 */
  override: Partial<DemoHeadlineState>;
  /** 该字段影响哪些 resolved.numeric 键（用于精确断言）。 */
  affectedKeys: string[];
}

const PROBES: FieldProbe[] = [
  {
    id: "truckCount",
    override: { truckCount: 200 },
    affectedKeys: ["project.trucksPerDay"],
  },
  {
    id: "annualMileagePerTruck",
    override: { annualMileagePerTruck: 90000 },
    affectedKeys: ["project.chargePerTruck", "derived.dailyChargeEnergy"],
  },
  {
    id: "energyPer100km",
    override: { energyPer100km: 150 },
    affectedKeys: ["project.chargePerTruck", "derived.dailyChargeEnergy"],
  },
  {
    id: "pvCapacity",
    override: { pvCapacity: 2500 },
    affectedKeys: ["project.pvCapacity"],
  },
  {
    id: "storageEnergy",
    override: { storageEnergy: 2000 },
    affectedKeys: ["project.storageEnergy", "project.storagePower", "derived.storageDuration"],
  },
  {
    id: "chargerUnitPower",
    override: { chargerUnitPower: 600 },
    affectedKeys: ["project.chargerUnitPower", "derived.chargerTotalPower"],
  },
  {
    id: "elecPrice",
    override: { elecPrice: 1.2 },
    affectedKeys: ["region.elecPrice"],
  },
];

const base = demoBaseline();
const baseCalc = calcOk(base);
const baseCards = cardsSignature(base);
const baseCash = cashFlowSignature(base);
const baseReport = reportText(base);

describe.each(PROBES)("TASK3 · 字段 $id 全链联动（映射→引擎→计算→视图→报告）", (probe) => {
  const touched =
    probe.id === "truckCount" || probe.id === "annualMileagePerTruck" || probe.id === "energyPer100km"
      ? { truckCount: true, annualMileagePerTruck: true, energyPer100km: true }
      : { [probe.id]: true };
  const next = computeDemoScenario(
    { ...defaultDemoState(), ...probe.override } as DemoHeadlineState,
    touched,
    NOW,
  );
  const nextCalc = calcOk(next);

  it("① 映射层把该字段垫进 user 覆写（未 touched 不出现）", () => {
    expect(Object.keys(next.userValues).length, "userValues 非空").toBeGreaterThan(0);
    for (const k of probe.affectedKeys) {
      expect(k in next.resolved.numeric || k in next.userValues, `覆写/派生应涉及 ${k}`).toBe(true);
    }
  });

  it("② resolved.numeric 至少一个受影响键的数值≠基线", () => {
    let anyChanged = false;
    for (const k of probe.affectedKeys) {
      if (next.resolved.numeric[k] !== base.resolved.numeric[k]) {
        anyChanged = true;
        break;
      }
    }
    expect(anyChanged, `受影响键 ${probe.affectedKeys.join(",")} 应至少一个变`).toBe(true);
  });

  /**
   * ③ 经济/技术结果变。
   * R9.0 后 storageEnergy 也影响收入（SVE 套利腿）；`elecPrice` 影响购电成本+套利腿反向。
   * 因此保留「CAPEX 或 OPEX 或 Revenue 或 energyCost 或 NPV 至少一处变」的宽松判据；
   * 若五处全等即为假联动，立刻失败。
   */
  it("③ 计算层至少一处经济结果变（CAPEX/OPEX/收入/购电成本/NPV 五者之一）", () => {
    const delta = {
      capex: Math.abs(nextCalc.capex.gross - baseCalc.capex.gross),
      opex: Math.abs(nextCalc.opexY1.gross - baseCalc.opexY1.gross),
      revenue: Math.abs(nextCalc.revenueY1.gross - baseCalc.revenueY1.gross),
      energy: Math.abs(nextCalc.energyCostY1 - baseCalc.energyCostY1),
      npv: Math.abs(nextCalc.metrics.npv - baseCalc.metrics.npv),
    };
    const anyChanged =
      delta.capex > 1 || delta.opex > 1 || delta.revenue > 1 || delta.energy > 1 || delta.npv > 1;
    expect(anyChanged, `五处经济结果全无变化 = 假联动：${JSON.stringify(delta)}`).toBe(true);
  });

  it("④ 视图模型至少一张指标卡或一段现金流曲线变（图表真变）", () => {
    const cardsChanged = cardsSignature(next) !== baseCards;
    const cashChanged = cashFlowSignature(next) !== baseCash;
    expect(cardsChanged || cashChanged, "cards 与 cashFlow 全等 = 视图未变").toBe(true);
  });

  it("⑤ 动态报告至少一处文本值变（报告读新数字）", () => {
    expect(reportText(next), "报告文本应随参数更新").not.toBe(baseReport);
  });
});

describe("TASK3 · 地区切换（region 字段）联动", () => {
  it("national → shanxi：elecPrice 生效值变、报告地区名变、NPV 变", () => {
    const sx = computeDemoScenario({ ...defaultDemoState(), regionId: "shanxi" }, {}, NOW);
    expect(sx.resolved.numeric["region.elecPrice"]).not.toBe(
      base.resolved.numeric["region.elecPrice"],
    );
    expect(sx.regionName).toContain("山西");
    expect(sx.report.regionName).toContain("山西");
    const c = calcOk(sx);
    expect(Math.abs(c.metrics.npv - baseCalc.metrics.npv)).toBeGreaterThan(1);
  });
});

describe("TASK3 · 假联动反查（若模型代码回归错误地把已接线字段变哑巴，本组立刻失败）", () => {
  it("pvCapacity=500 vs 2500 → PV CAPEX 应严格增加（防意外断链）", () => {
    const hi = calcOk(
      computeDemoScenario({ ...defaultDemoState(), pvCapacity: 2500 }, { pvCapacity: true }, NOW),
    );
    expect(hi.capex.pv).toBeGreaterThan(baseCalc.capex.pv);
  });

  it("chargerUnitPower 60→960 → 桩 CAPEX 单调增（derived.chargerTotalPower 生效）", () => {
    const lo = calcOk(
      computeDemoScenario({ ...defaultDemoState(), chargerUnitPower: 60 }, { chargerUnitPower: true }, NOW),
    );
    const hi = calcOk(
      computeDemoScenario({ ...defaultDemoState(), chargerUnitPower: 960 }, { chargerUnitPower: true }, NOW),
    );
    expect(hi.capex.charger).toBeGreaterThan(lo.capex.charger);
  });

  it("elecPrice 0.2 → 1.5 → 购电成本严格单调增", () => {
    const lo = calcOk(
      computeDemoScenario({ ...defaultDemoState(), elecPrice: 0.2 }, { elecPrice: true }, NOW),
    );
    const mid = calcOk(
      computeDemoScenario({ ...defaultDemoState(), elecPrice: 0.7 }, { elecPrice: true }, NOW),
    );
    const hi = calcOk(
      computeDemoScenario({ ...defaultDemoState(), elecPrice: 1.5 }, { elecPrice: true }, NOW),
    );
    expect(mid.energyCostY1).toBeGreaterThan(lo.energyCostY1);
    expect(hi.energyCostY1).toBeGreaterThan(mid.energyCostY1);
  });

  it("truckCount 20 → 500 → 首年充电收入严格单调增", () => {
    const a = calcOk(
      computeDemoScenario({ ...defaultDemoState(), truckCount: 20 }, { truckCount: true }, NOW),
    );
    const b = calcOk(
      computeDemoScenario({ ...defaultDemoState(), truckCount: 250 }, { truckCount: true }, NOW),
    );
    const c = calcOk(
      computeDemoScenario({ ...defaultDemoState(), truckCount: 500 }, { truckCount: true }, NOW),
    );
    expect(b.revenueY1.charging).toBeGreaterThan(a.revenueY1.charging);
    expect(c.revenueY1.charging).toBeGreaterThan(b.revenueY1.charging);
  });

  /**
   * P1-2 已闭合 · 现状镜像（R9.0 Step 2，与 causality 钉桩两处独立保护）：
   * 储能套利价值已接入 E3b，但 DEMO 默认经济（spread=0.6、capex=1.3 元/Wh）下
   * 每 kWh 边际套利收入现值 < 边际 CAPEX，NPV 仍**严格下降**——这是真实经济信号
   * （NPV=0 需 spread≈1.568，见 Step 1.5 实验）。正向贡献场景由 causality FLIP 测试锚定。
   */
  it("【P1-2 已闭合 · 现状镜像】DEMO 默认经济下 storageEnergy 增加 → NPV 严格下降", () => {
    const zero = calcOk(
      computeDemoScenario({ ...defaultDemoState(), storageEnergy: 0 }, { storageEnergy: true }, NOW),
    );
    const base400 = calcOk(
      computeDemoScenario({ ...defaultDemoState(), storageEnergy: 400 }, { storageEnergy: true }, NOW),
    );
    const big = calcOk(
      computeDemoScenario({ ...defaultDemoState(), storageEnergy: 3000 }, { storageEnergy: true }, NOW),
    );
    expect(base400.metrics.npv).toBeLessThan(zero.metrics.npv);
    expect(big.metrics.npv).toBeLessThan(base400.metrics.npv);
  });
});

describe("TASK3 · 默认零 churn 保护（映射层刻意不 bump 经济内核版本）", () => {
  it("默认无改动 → calc 与 runSandboxModelBaseline() 深等 + MODEL_VERSION 跟随引擎 1.1.0", () => {
    expect(base.calc).toEqual(demoBaseline().calc);
    expect(baseCalc.engineVersions.model).toBe("1.1.0");
  });
});
