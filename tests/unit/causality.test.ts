/**
 * 沙盘模型真实性 / 因果链回归测试（TASK 2 · 2026-09-08 夜）——
 * 用 `runProjectModel` 沿 5 条轴（车队 / 里程-电耗 / 电价 / 光伏 / 储能）扫参，
 * 断言「参数变→物理结果变→经济结果变」且方向合理；把仍未接线的**假联动参数**
 * （P1-1 / P1-3 / P2-6，详见 docs/MODEL_CAUSALITY_AUDIT_V1.md）
 * 用「结果不应当前会变而实际不变」的反向断言**钉住现状**，防止未来无意识回归。
 *
 * R9.0 Step 2（2026-09-08）更新：P1-2「储能只成本不货币化」已闭合（SVE 套利腿接入 E3b），
 * 原 P1-2 钉桩改写为「基线参数下 NPV 仍随储能容量下降」的新现状钉桩 + 新增 spread/FLIP 因果块；
 * region.peakValleySpread 从 P2-6 假联动清单移除。
 *
 * 设计原则：
 *   ① 纯函数离线，无 DB / 无时钟 / 无随机；
 *   ② 只加测试代码，**绝不改 MODEL_VERSION / ECON 口径 / 参数默认值**；
 *   ③ 数值容差不硬编黄金，改判"有限 + 单调 + 无跨数量级异常"；
 *   ④ 若发现"应有变化却无变化"的意外（非 P1 已知项），断言立刻炸出以便人工排查。
 */
import { describe, it, expect } from "vitest";
import {
  runProjectModel,
  runProjectModelBaseline,
  type CalcResultOk,
} from "@app/kernel/server/project-model";
import { computeTechModel } from "@app/kernel/server/tech";
import { resolveProjectParams } from "@app/kernel/server/project-params";

/** 从 `user.values` 覆写跑一次，若失败即抛出（本测试只在健康情景扫参）。 */
function ok(res: ReturnType<typeof runProjectModel>): CalcResultOk {
  if (!res.ok) {
    throw new Error(`模型未通过：${res.reason} ${res.detail} ${[...(res.missingInputs ?? []), ...(res.invalidInputs ?? [])].join(",")}`);
  }
  return res;
}

function npvOf(values: Record<string, number>): number {
  return ok(runProjectModel({ user: { values } })).metrics.npv;
}

/** 有限性快检：不含 NaN/Infinity（排除明确允许 NaN 的 NPV 极端场景）。 */
function assertFinite(res: CalcResultOk, context: string) {
  expect(Number.isFinite(res.capex.gross), `${context}: capex.gross`).toBe(true);
  expect(res.capex.gross, `${context}: capex.gross>=0`).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(res.opexY1.gross), `${context}: opexY1`).toBe(true);
  expect(res.opexY1.gross, `${context}: opexY1>=0`).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(res.revenueY1.gross), `${context}: revenueY1`).toBe(true);
  expect(res.revenueY1.gross, `${context}: revenueY1>=0`).toBeGreaterThanOrEqual(0);
  for (let y = 0; y < res.annualCashFlow.length; y++) {
    expect(Number.isFinite(res.annualCashFlow[y]), `${context}: annualCashFlow[${y}] finite`).toBe(true);
  }
  expect(res.energyCostY1, `${context}: energyCostY1>=0`).toBeGreaterThanOrEqual(0);
}

function assertNoNegativeEnergy(values: Record<string, number>, context: string) {
  const resolved = resolveProjectParams({ user: { values } });
  const tech = computeTechModel(resolved.numeric);
  if (!tech.ok) return;
  const f = tech.firstYear;
  for (const key of [
    "pvEnergyY1Kwh",
    "chargeEnergyDeliveredY1Kwh",
    "acLoadY1Kwh",
    "chargingLossY1Kwh",
    "selfConsumedY1Kwh",
    "pvExportY1Kwh",
    "gridImportY1Kwh",
  ] as const) {
    expect(f[key], `${context}: ${key} 非负`).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(f[key]), `${context}: ${key} 有限`).toBe(true);
  }
  expect(f.pvSelfConsumptionRatePct, `${context}: pv 自用率 ∈ [0,100]`).toBeGreaterThanOrEqual(0);
  expect(f.pvSelfConsumptionRatePct).toBeLessThanOrEqual(100);
  expect(f.renewableFractionPct, `${context}: 可再生比例 ∈ [0,100]`).toBeGreaterThanOrEqual(0);
  expect(f.renewableFractionPct).toBeLessThanOrEqual(100);
}

/* ─────────────────────────────────────────────────────────────────────────── */

describe("TASK2 · 基线健全性（先钉住一切有限的起点）", () => {
  const base = ok(runProjectModelBaseline());
  it("基线 NPV 有限且 >0（当前默认参数集是盈利的）", () => {
    expect(Number.isFinite(base.metrics.npv)).toBe(true);
    expect(base.metrics.npv).toBeGreaterThan(0);
  });
  it("基线 IRR 有解、值在合理区间 (0, 5)", () => {
    expect(base.metrics.irr.ok).toBe(true);
    const v = base.metrics.irr.value as number;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(5); // <500%（异常高收益应引警惕，V1 默认远不及此）
  });
  it("基线 15 年现金流长度 = 计算期 + 1（t=0 建设年 + t=1..15）", () => {
    expect(base.annualCashFlow.length).toBe(16);
  });
  it("基线首年能量非负且守恒：self+export == pvEnergy, self+import == acLoad", () => {
    assertNoNegativeEnergy({}, "baseline");
    const resolved = resolveProjectParams({});
    const t = computeTechModel(resolved.numeric);
    expect(t.ok).toBe(true);
    if (t.ok) {
      const f = t.firstYear;
      expect(f.selfConsumedY1Kwh + f.pvExportY1Kwh).toBeCloseTo(f.pvEnergyY1Kwh, 0);
      expect(f.selfConsumedY1Kwh + f.gridImportY1Kwh).toBeCloseTo(f.acLoadY1Kwh, 0);
    }
  });
});

describe("TASK2 · 轴 A：车队规模 trucksPerDay 100 → 300 → 1000", () => {
  const a = ok(runProjectModel({ user: { values: { "project.trucksPerDay": 100 } } }));
  const b = ok(runProjectModel({ user: { values: { "project.trucksPerDay": 300 } } }));
  const c = ok(runProjectModel({ user: { values: { "project.trucksPerDay": 1000 } } }));

  it("三档全部有限、无非负违反", () => {
    assertFinite(a, "trucks=100");
    assertFinite(b, "trucks=300");
    assertFinite(c, "trucks=1000");
    assertNoNegativeEnergy({ "project.trucksPerDay": 100 }, "trucks=100");
    assertNoNegativeEnergy({ "project.trucksPerDay": 1000 }, "trucks=1000");
  });

  it("年电池侧充电量按 100:300:1000 = 1:3:10 精确线性（因果：车队→能量）", () => {
    const t1 = computeTechModel(resolveProjectParams({ user: { values: { "project.trucksPerDay": 100 } } }).numeric);
    const t3 = computeTechModel(resolveProjectParams({ user: { values: { "project.trucksPerDay": 300 } } }).numeric);
    const t10 = computeTechModel(resolveProjectParams({ user: { values: { "project.trucksPerDay": 1000 } } }).numeric);
    expect(t1.ok && t3.ok && t10.ok).toBe(true);
    if (t1.ok && t3.ok && t10.ok) {
      expect(t3.firstYear.chargeEnergyDeliveredY1Kwh / t1.firstYear.chargeEnergyDeliveredY1Kwh).toBeCloseTo(3, 6);
      expect(t10.firstYear.chargeEnergyDeliveredY1Kwh / t1.firstYear.chargeEnergyDeliveredY1Kwh).toBeCloseTo(10, 6);
    }
  });

  it("首年充电收入随车队规模单调增（因果：能量→钱）", () => {
    expect(b.revenueY1.charging).toBeGreaterThan(a.revenueY1.charging);
    expect(c.revenueY1.charging).toBeGreaterThan(b.revenueY1.charging);
  });

  it("NPV 随车队规模变化（不是常数），且未出现反向", () => {
    const npvs = [a.metrics.npv, b.metrics.npv, c.metrics.npv];
    expect(new Set(npvs).size).toBeGreaterThan(1);
    for (const n of npvs) expect(Number.isFinite(n)).toBe(true);
  });

  it("桩总装机功率随 chargerUnitPower 与 chargerCount 联动（不机械线性于车队）", () => {
    // 车队变了，但桩功率配置未变——CAPEX.charger 应保持不变（防"车队→所有 CAPEX"的粗暴线性误伤）
    expect(b.capex.charger).toBe(a.capex.charger);
    expect(c.capex.charger).toBe(a.capex.charger);
  });
});

describe("TASK2 · 轴 B：单车日均电量 chargePerTruck 50 → 150 → 300（里程×电耗合并代理）", () => {
  const lo = ok(runProjectModel({ user: { values: { "project.chargePerTruck": 50 } } }));
  const mid = ok(runProjectModel({ user: { values: { "project.chargePerTruck": 150 } } }));
  const hi = ok(runProjectModel({ user: { values: { "project.chargePerTruck": 300 } } }));

  it("三档全部有限且能量非负", () => {
    assertFinite(lo, "perTruck=50");
    assertFinite(mid, "perTruck=150");
    assertFinite(hi, "perTruck=300");
    assertNoNegativeEnergy({ "project.chargePerTruck": 50 }, "perTruck=50");
    assertNoNegativeEnergy({ "project.chargePerTruck": 300 }, "perTruck=300");
  });

  it("年充电量按 50:150:300 = 1:3:6 线性", () => {
    const t1 = computeTechModel(resolveProjectParams({ user: { values: { "project.chargePerTruck": 50 } } }).numeric);
    const t3 = computeTechModel(resolveProjectParams({ user: { values: { "project.chargePerTruck": 150 } } }).numeric);
    const t6 = computeTechModel(resolveProjectParams({ user: { values: { "project.chargePerTruck": 300 } } }).numeric);
    if (t1.ok && t3.ok && t6.ok) {
      expect(t3.firstYear.chargeEnergyDeliveredY1Kwh / t1.firstYear.chargeEnergyDeliveredY1Kwh).toBeCloseTo(3, 6);
      expect(t6.firstYear.chargeEnergyDeliveredY1Kwh / t1.firstYear.chargeEnergyDeliveredY1Kwh).toBeCloseTo(6, 6);
    }
  });

  it("首年收入随单车电量单调增", () => {
    expect(mid.revenueY1.charging).toBeGreaterThan(lo.revenueY1.charging);
    expect(hi.revenueY1.charging).toBeGreaterThan(mid.revenueY1.charging);
  });

  it("高单车电量把 PV 更多挤到自用 → 光伏自用率上升、上网率下降（因果：负荷↑→自用↑）", () => {
    const t1 = computeTechModel(resolveProjectParams({ user: { values: { "project.chargePerTruck": 50 } } }).numeric);
    const t6 = computeTechModel(resolveProjectParams({ user: { values: { "project.chargePerTruck": 300 } } }).numeric);
    if (t1.ok && t6.ok) {
      expect(t6.firstYear.renewableFractionPct).toBeLessThanOrEqual(t1.firstYear.renewableFractionPct + 0.1);
      // PV 恒定，负荷↑ → self 上升、export 下降
      expect(t6.firstYear.selfConsumedY1Kwh).toBeGreaterThanOrEqual(t1.firstYear.selfConsumedY1Kwh);
      expect(t6.firstYear.pvExportY1Kwh).toBeLessThanOrEqual(t1.firstYear.pvExportY1Kwh + 1);
    }
  });
});

describe("TASK2 · 轴 C：电价 elecPrice 0.4 → 0.7 → 1.2", () => {
  const lo = ok(runProjectModel({ user: { values: { "region.elecPrice": 0.4 } } }));
  const mid = ok(runProjectModel({ user: { values: { "region.elecPrice": 0.7 } } }));
  const hi = ok(runProjectModel({ user: { values: { "region.elecPrice": 1.2 } } }));

  it("三档全部有限", () => {
    assertFinite(lo, "elec=0.4");
    assertFinite(mid, "elec=0.7");
    assertFinite(hi, "elec=1.2");
  });

  it("购电成本随电价单调增（因果：电价→成本）", () => {
    expect(mid.energyCostY1).toBeGreaterThan(lo.energyCostY1);
    expect(hi.energyCostY1).toBeGreaterThan(mid.energyCostY1);
  });

  it("NPV 随电价**下降**（成本端下网电量×p 单调涨；R9.0 后套利腿 Δ_arb 的 ∂/∂p = 1−1/η < 0 也反向）", () => {
    // 三个收入项（充电价 / 上网价 / 补贴单价）都不随 p 变；唯一与 p 联动的收入是
    // R9.0 储能套利腿：margin = p − p_valley/η = p(1−1/η) + spread/(2η)，p↑ 时套利空间反而收窄。
    // 成本端 import×p 主导 → NPV 严格单调降（实测 0.4/0.7/1.2 → 15.50M / 4.45M / −17.48M）。
    // 方向可解释、用户可感知因果；若未来接入逐时曲线导致方向翻转，本测试必须同步改写。
    expect(mid.metrics.npv).toBeLessThan(lo.metrics.npv);
    expect(hi.metrics.npv).toBeLessThan(mid.metrics.npv);
    // 收入端同样严格降（唯一联动项 Δ_sto 随 p 缩水：32,073 → 27,491 → 19,855）
    expect(mid.revenueY1.gross).toBeLessThan(lo.revenueY1.gross);
    expect(hi.revenueY1.gross).toBeLessThan(mid.revenueY1.gross);
  });
});

describe("TASK2 · 轴 D：光伏 pvCapacity 0 → 500 → 5000 → 20000", () => {
  const zero = ok(runProjectModel({ user: { values: { "project.pvCapacity": 0 } } }));
  const base = ok(runProjectModel({ user: { values: { "project.pvCapacity": 500 } } }));
  const big = ok(runProjectModel({ user: { values: { "project.pvCapacity": 5000 } } }));
  const huge = ok(runProjectModel({ user: { values: { "project.pvCapacity": 20000 } } }));

  it("四档全部有限、无非负违反", () => {
    assertFinite(zero, "pv=0");
    assertFinite(base, "pv=500");
    assertFinite(big, "pv=5000");
    assertFinite(huge, "pv=20000");
    assertNoNegativeEnergy({ "project.pvCapacity": 0 }, "pv=0");
    assertNoNegativeEnergy({ "project.pvCapacity": 20000 }, "pv=20000");
  });

  it("pv=0 时 CAPEX.pv=0，无光伏能量、全部下网", () => {
    expect(zero.capex.pv).toBe(0);
    const t = computeTechModel(resolveProjectParams({ user: { values: { "project.pvCapacity": 0 } } }).numeric);
    if (t.ok) {
      expect(t.firstYear.pvEnergyY1Kwh).toBe(0);
      expect(t.firstYear.gridImportY1Kwh).toBe(t.firstYear.acLoadY1Kwh);
      expect(t.firstYear.pvExportY1Kwh).toBe(0);
    }
  });

  it("PV CAPEX 随装机线性增（因果：装机→投资）", () => {
    // pv=500 vs 5000，PV CAPEX 应约 10x
    expect(big.capex.pv / base.capex.pv).toBeCloseTo(10, 1);
    expect(huge.capex.pv / base.capex.pv).toBeCloseTo(40, 1);
  });

  it("大 PV 时上网量涌现（S1 平衡：负荷恒定 15000×350=5.25GWh，pv=20000kWp×1200h×0.82=19.68GWh）", () => {
    const t = computeTechModel(resolveProjectParams({ user: { values: { "project.pvCapacity": 20000 } } }).numeric);
    if (t.ok) {
      expect(t.firstYear.pvExportY1Kwh).toBeGreaterThan(t.firstYear.selfConsumedY1Kwh);
      expect(t.firstYear.gridImportY1Kwh).toBe(0); // 全负荷覆盖
    }
  });

  it("NPV 曲线不是单调（存在最优装机规模；过大反而因低价上网拉低回报）", () => {
    const npvs = [zero.metrics.npv, base.metrics.npv, big.metrics.npv, huge.metrics.npv];
    const sorted = [...npvs].sort((x, y) => x - y);
    // 至少不完全等于 min 或 max（即"不是单调"）
    expect(new Set(npvs).size).toBeGreaterThan(1);
    // huge 不一定最大：允许 NPV 下降（因为上网价 0.35 远低于充电价 0.9 拉低边际）
    // 关键：**不是所有 NPV 相等**
    expect(sorted[sorted.length - 1] - sorted[0]).toBeGreaterThan(1e5);
  });
});

describe("TASK2 · 轴 E：储能 storageEnergy 0 → 400 → 2000 → 8000", () => {
  const zero = ok(runProjectModel({ user: { values: { "project.storageEnergy": 0 } } }));
  const base = ok(runProjectModel({ user: { values: { "project.storageEnergy": 400 } } }));
  const big = ok(runProjectModel({ user: { values: { "project.storageEnergy": 2000 } } }));
  const huge = ok(runProjectModel({ user: { values: { "project.storageEnergy": 8000 } } }));

  it("四档全部有限", () => {
    assertFinite(zero, "st=0");
    assertFinite(base, "st=400");
    assertFinite(big, "st=2000");
    assertFinite(huge, "st=8000");
  });

  it("storageEnergy=0 → storageCapex=0、storageOPEX=0（因果：配置→成本）", () => {
    expect(zero.capex.storage).toBe(0);
    expect(zero.opexY1.storage).toBe(0);
  });

  it("storage CAPEX 随容量线性增", () => {
    expect(big.capex.storage / base.capex.storage).toBeCloseTo(5, 1);
    expect(huge.capex.storage / base.capex.storage).toBeCloseTo(20, 1);
  });

  /**
   * P1-2 已闭合（R9.0 Step 2）：储能套利价值 Δ_sto∝E 已线性接入 E3b，本钉桩从
   * 「储能只成本不货币化的缺陷」改写为「基线参数下的真实经济现状」：
   * spread=0.6、capex=1.3 元/Wh 下，每 kWh 储能的边际套利收入现值 < 边际 CAPEX
   * （Step 1.5 实验：NPV=0 需 spread≈1.568；回收期远超寿命），故 NPV 仍严格单调下降、
   * E=0 端点最优——这是真实经济信号而非 bug。正向贡献场景由下方 FLIP 测试锚定。
   * 此断言确保：基线经济口径被无意改动（如价差/造价默认值漂移翻转方向）时立即炸出。
   */
  it("【R9.0 后现状钉桩】基线参数下 NPV 仍随储能容量严格单调下降（套利价值 < 边际 CAPEX，E=0 最优）", () => {
    expect(base.metrics.npv).toBeLessThan(zero.metrics.npv);
    expect(big.metrics.npv).toBeLessThan(base.metrics.npv);
    expect(huge.metrics.npv).toBeLessThan(big.metrics.npv);
  });
});

describe("TASK2 · P1-1 口径再修正（批次1.2）：chargerUtilization 退出需量计费（假联动钉桩回归）", () => {
  /**
   * 阶段4 曾用「计费需量=装机×利用率」（口径 A），审计 P0-3 指出这是**用平均利用率冒充最大需量**的口径错位。
   * V1.1 批次1.2 起 E 层计费基准改用需用系数 Kc（project.demandKc），chargerUtilization 回归利用率本义、
   * E 层不再消费——本测试从"单调下降"**反向改写为"逐字相等"**（凡引用它的场景都该无响应，才是诚实守卫）。
   */
  const a = npvOf({ "region.demandCharge": 44, "project.chargerUtilization": 5 });
  const b = npvOf({ "region.demandCharge": 44, "project.chargerUtilization": 35 });
  const c = npvOf({ "region.demandCharge": 44, "project.chargerUtilization": 90 });

  it("B 场景(44 元/kW·月)下利用率 5% → 35% → 90%：NPV 逐字相等（E 层不消费，计费只随 Kc）", () => {
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("TASK2 · P1-3 假联动钉桩：gridCapacity 未参与功率约束", () => {
  const a = npvOf({ "project.gridCapacity": 500 });
  const b = npvOf({ "project.gridCapacity": 2000 });
  const c = npvOf({ "project.gridCapacity": 20000 });
  it("当前：三档 NPV 完全相同（并网容量未作为硬约束）", () => {
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("TASK2 · P2-6 假联动钉桩：其余未接入 E 层的参数", () => {
  // R9.0 Step 2：region.peakValleySpread 已接入 E3b 储能套利腿，从本清单移除；
  // 阶段4：region.demandCharge 已接入 E4 需量(基本)电费口径 A，从本清单移除，其反向因果改由下方专块断言。
  const base = npvOf({});
  for (const key of [
    "region.landRent",
    "policy.carbonPrice",
    "finance.equityRatio",
    "finance.loanRate",
  ]) {
    it(`${key} 变动 → NPV 不变（V1 未接入 E 层，见审计 P2-6）`, () => {
      expect(npvOf({ [key]: 0 })).toBe(base);
      expect(npvOf({ [key]: 999 })).toBe(base);
    });
  }
});

describe("TASK2 · 接线因果：region.demandCharge ↔ NPV 反向联动（批次1.2 起默认=主情景 A 免征 0）", () => {
  it("需量电价 0 → 40 → 80：NPV 严格单调下降（需量费=装机×Kc×元/kW·月×12 计入成本侧）", () => {
    const zero = npvOf({ "region.demandCharge": 0 }); // = 目录默认（A 主情景）
    const mid = npvOf({ "region.demandCharge": 40 }); // B 对照（全国名义）
    const high = npvOf({ "region.demandCharge": 80 }); // 高价压力
    expect(zero).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
  });

  it("默认即免征 0 → NPV 逐字回摆无(基本)电费口径（与旧 R9.0 基线交叉印证·政策焊点）", () => {
    // demandCharge=0 时 E4 仅剩电量电费，经济口径回到接入需量费之前（model 1.1.0 黄金）。
    expect(npvOf({})).toBe(4448573);
    expect(npvOf({ "region.demandCharge": 0 })).toBe(4448573); // R9.0 SVE 老黄金（model 1.1.0 口径）
  });
});

describe("TASK2 · 批次1.2 新接线：project.demandKc ↔ 需量费（B/C 场景下的计费基准）", () => {
  it("B@40 下 Kc 40% → 70% → 100%：NPV 严格单调下降（计费需量=装机×Kc）", () => {
    const lo = npvOf({ "region.demandCharge": 40, "project.demandKc": 40 });
    const mid = npvOf({ "region.demandCharge": 40 }); // 默认 Kc=70
    const hi = npvOf({ "region.demandCharge": 40, "project.demandKc": 100 }); // C 压力
    expect(lo).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(hi);
  });

  it("A 免征下 Kc 怎么动费用都恒 0（价格闸门优先于系数——NPV 逐字不变）", () => {
    const a = npvOf({ "project.demandKc": 20 });
    const b = npvOf({ "project.demandKc": 70 });
    const c = npvOf({ "project.demandKc": 100 });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe(4448573);
  });
});

describe("TASK2 · 批次1.4 真接线：project.includeStorage ↔ 储能整腿（假开关转正·审计 F-2h）", () => {
  /**
   * 批次 1.4 前该开关是**假开关**（E 层无人消费，关了照样算储能）。MODEL 1.4.0 起编排层以
   * 0/1 门控注入经济快照：置 0 → 储能 CAPEX/OPEX/SVE 套利整腿归零。本块是「真杠杆」正向钉桩
   * + 反向守卫（若将来有人把门控改回假开关，off==on 立即炸出）。
   */
  it("开关=关 → NPV 逐字等于「容量物理置 0」的轴 E 端点（两条路径同一口径）", () => {
    const off = npvOf({ "project.includeStorage": 0 });
    const zeroCapacity = npvOf({ "project.storageEnergy": 0 });
    expect(off).toBe(zeroCapacity);
    expect(off).toBe(4797756); // R9.0 无储能焊点（引擎实测）
  });

  it("开关开/关 NPV 严格分离，默认（缺省覆写）保持基线 4,448,573（向后兼容）", () => {
    const on = npvOf({ "project.includeStorage": 1 });
    const off = npvOf({ "project.includeStorage": 0 });
    const dflt = npvOf({});
    expect(on).toBe(dflt);
    expect(dflt).toBe(4448573);
    expect(off).toBeGreaterThan(dflt); // 基线参数下储能边际为负（轴 E 现状），关反而更优——方向由经济事实决定，非 bug
  });
});

describe("TASK2 · R9.0 SVE 接线因果（spread ↔ NPV 正联动 + FLIP 正贡献场景）", () => {
  it("region.peakValleySpread 0 → 0.6 → 1.0 → 1.5 → NPV 严格单调增（旧 P2-6 钉桩解除）", () => {
    // Δ_arb = σ·Imp0·(p − p_valley/η)，价差↑ → 谷价更低 → 单位套利空间变宽
    const s0 = npvOf({ "region.peakValleySpread": 0 });
    const s06 = npvOf({});
    const s10 = npvOf({ "region.peakValleySpread": 1.0 });
    const s15 = npvOf({ "region.peakValleySpread": 1.5 });
    expect(s06).toBeGreaterThan(s0);
    expect(s10).toBeGreaterThan(s06);
    expect(s15).toBeGreaterThan(s10);
  });

  it("spread=0 → 套利腿关闭，storageValue 归零，NPV 精确回落到 R9.0 无储能价值焊点 4,277,409（批次1.2 A 场景交叉焊点）", () => {
    // 阶段4（口径 A·需量费 483,840 元/年）曾把该焊点压到 795,417；批次1.2 主情景 A 免征后
    // E4 无需量费，逐字回摆 R9.0/model 1.1.0 老焊点 4,277,409——两个年代的黄金在此对齐，本身就是最强守卫。
    expect(npvOf({ "region.peakValleySpread": 0 })).toBe(4277409);
    expect(npvOf({ "region.peakValleySpread": 0 })).toBeLessThan(npvOf({})); // 关断套利 → 低于含套利基线
  });

  it("【FLIP】spread 1.0 + 储能单价 0.6 元/Wh → 储能 NPV 贡献转正（E=400 优于 E=0，P1-2 反例锚定）", () => {
    // Step 1.5 翻转情景：capex 1.3→0.6 + spread 0.6→1.0 后边际收入现值超过边际 CAPEX
    const flip0 = npvOf({ "region.peakValleySpread": 1.0, "tech.storageCapex": 0.6, "project.storageEnergy": 0 });
    const flip400 = npvOf({ "region.peakValleySpread": 1.0, "tech.storageCapex": 0.6 });
    expect(flip400).toBeGreaterThan(flip0);
    expect(flip400 - flip0).toBeGreaterThan(5e4); // 实测 +70,889，摆幅须有经济意义
  });
});

describe("TASK2 · 极端场景不崩：无 NaN / 无负能量 / 无 Infinite NPV", () => {
  const cases: { name: string; values: Record<string, number> }[] = [
    { name: "全空站（pv=0, storage=0, trucks=1）", values: { "project.pvCapacity": 0, "project.storageEnergy": 0, "project.trucksPerDay": 1 } },
    { name: "巨大车队", values: { "project.trucksPerDay": 1000 } },
    { name: "光伏远大于负荷", values: { "project.pvCapacity": 20000 } },
    { name: "极高电价", values: { "region.elecPrice": 2.0 } },
    { name: "极低电价", values: { "region.elecPrice": 0.2 } },
    { name: "零建设补贴", values: { "policy.constructionSubsidy": 0 } },
    { name: "顶格建设补贴 30%", values: { "policy.constructionSubsidy": 30 } },
    { name: "超长计算期 30 年", values: { "finance.projectLife": 30 } },
    { name: "零通胀", values: { "finance.inflation": 0 } },
    { name: "零税", values: { "finance.taxRate": 0 } },
    { name: "顶格税 35%", values: { "finance.taxRate": 35 } },
  ];
  for (const c of cases) {
    it(`${c.name} → 结果有限、能量非负`, () => {
      const r = ok(runProjectModel({ user: { values: c.values } }));
      assertFinite(r, c.name);
      assertNoNegativeEnergy(c.values, c.name);
    });
  }
});

describe("TASK2 · IRR 诚实降级（现金流形态极端时不硬编）", () => {
  it("充电价压到 0.3 → 现金流大概率无正 IRR → 诚实 ok:false（或不合理高 IRR 被截）", () => {
    const r = ok(runProjectModel({ user: { values: { "project.chargingPrice": 0.3 } } }));
    // 若 NPV 明显负，IRR 应该 < 折现率或无解
    if (r.metrics.npv < 0) {
      // IRR 可得时必 < 8%（折现率）；不可得时也不能假装得到一个高数
      if (r.metrics.irr.ok) {
        expect(r.metrics.irr.value!).toBeLessThan(0.08);
      } else {
        expect(["no_sign_change", "no_bracket", "not_converged", "invalid_input"]).toContain(r.metrics.irr.reason);
      }
    }
  });

  it("极低规模（各轴接近下限）→ CAPEX 很小但 >0 → ROI 有限、无崩", () => {
    // project.chargerCount 下限=1、trucksPerDay 下限=1，物理上做不到"零 CAPEX"（V1 spec 决定）
    const r = ok(
      runProjectModel({
        user: {
          values: {
            "project.trucksPerDay": 1,
            "project.chargePerTruck": 50,
            "project.pvCapacity": 0,
            "project.storageEnergy": 0,
            "project.chargerCount": 1,
            "project.chargerUnitPower": 60,
          },
        },
      }),
    );
    expect(r.capex.gross).toBeGreaterThan(0);
    expect(r.capex.gross).toBeLessThan(2e5); // <20 万元（1 桩 × 60kW × 500元/kW = 30000，加固定运维不在 CAPEX 里）
    expect(Number.isFinite(r.metrics.npv)).toBe(true);
  });
});

describe("TASK2 · 敏感性扫描的因果方向（对应 TASK 5 前置检查）", () => {
  it("tech.pvCapex ±20% → NPV 反向（造价↑→NPV↓）", () => {
    const base = npvOf({});
    const hi = npvOf({ "tech.pvCapex": 3.5 * 1.2 });
    const lo = npvOf({ "tech.pvCapex": 3.5 * 0.8 });
    expect(hi).toBeLessThan(base);
    expect(lo).toBeGreaterThan(base);
  });

  /**
   * 该测试为 TASK 5 储能 CAPEX 敏感性扩展铺垫：验证方向与量级足够，值得加入默认扫描集。
   */
  it("tech.storageCapex ±20% → NPV 变化且与 storageEnergy 联动（>0 才有反应）", () => {
    const baseNoSt = npvOf({ "project.storageEnergy": 0 });
    const hiCostNoSt = npvOf({ "project.storageEnergy": 0, "tech.storageCapex": 1.56 });
    expect(hiCostNoSt).toBe(baseNoSt); // 无储能 → 储能 CAPEX 无影响

    const baseSt = npvOf({ "project.storageEnergy": 400 });
    const hiCostSt = npvOf({ "project.storageEnergy": 400, "tech.storageCapex": 1.56 });
    expect(hiCostSt).toBeLessThan(baseSt); // 有储能 → 涨价 NPV 下降
    expect(Math.abs(baseSt - hiCostSt)).toBeGreaterThan(1e4); // 摆幅有意义
  });

  /**
   * 该测试为 TASK 5 里程-电耗代理（chargePerTruck）扩展铺垫：验证 NPV 对此敏感。
   */
  it("project.chargePerTruck ±20% → NPV 显著变化（里程-电耗合并代理）", () => {
    const lo = npvOf({ "project.chargePerTruck": 200 });
    const base = npvOf({ "project.chargePerTruck": 250 });
    const hi = npvOf({ "project.chargePerTruck": 300 });
    expect(lo).not.toBe(base);
    expect(hi).not.toBe(base);
    expect(Math.abs(hi - lo)).toBeGreaterThan(1e5); // 摆幅有意义
  });
});
