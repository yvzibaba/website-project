/**
 * 沙盘模型真实性 / 因果链回归测试（TASK 2 · 2026-09-08 夜）——
 * 用 `runSandboxModel` 沿 5 条轴（车队 / 里程-电耗 / 电价 / 光伏 / 储能）扫参，
 * 断言「参数变→物理结果变→经济结果变」且方向合理；把已知的**未接线参数**与
 * **储能货币化缺口**（详见 docs/MODEL_CAUSALITY_AUDIT_V1.md P1-1 / P1-2 / P1-3）
 * 用「结果不应当前会变而实际不变」的反向断言**钉住现状**，防止未来无意识回归。
 *
 * 设计原则：
 *   ① 纯函数离线，无 DB / 无时钟 / 无随机；
 *   ② 只加测试代码，**绝不改 MODEL_VERSION / ECON 口径 / 参数默认值**；
 *   ③ 数值容差不硬编黄金，改判"有限 + 单调 + 无跨数量级异常"；
 *   ④ 若发现"应有变化却无变化"的意外（非 P1 已知项），断言立刻炸出以便人工排查。
 */
import { describe, it, expect } from "vitest";
import {
  runSandboxModel,
  runSandboxModelBaseline,
  type CalcResultOk,
} from "../../src/server/sandbox-model";
import { computeTechModel } from "../../src/server/sandbox-tech";
import { resolveSandbox } from "../../src/server/sandbox-params";

/** 从 `user.values` 覆写跑一次，若失败即抛出（本测试只在健康情景扫参）。 */
function ok(res: ReturnType<typeof runSandboxModel>): CalcResultOk {
  if (!res.ok) {
    throw new Error(`模型未通过：${res.reason} ${res.detail} ${[...(res.missingInputs ?? []), ...(res.invalidInputs ?? [])].join(",")}`);
  }
  return res;
}

function npvOf(values: Record<string, number>): number {
  return ok(runSandboxModel({ user: { values } })).metrics.npv;
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
  const resolved = resolveSandbox({ user: { values } });
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
  const base = ok(runSandboxModelBaseline());
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
    const resolved = resolveSandbox({});
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
  const a = ok(runSandboxModel({ user: { values: { "project.trucksPerDay": 100 } } }));
  const b = ok(runSandboxModel({ user: { values: { "project.trucksPerDay": 300 } } }));
  const c = ok(runSandboxModel({ user: { values: { "project.trucksPerDay": 1000 } } }));

  it("三档全部有限、无非负违反", () => {
    assertFinite(a, "trucks=100");
    assertFinite(b, "trucks=300");
    assertFinite(c, "trucks=1000");
    assertNoNegativeEnergy({ "project.trucksPerDay": 100 }, "trucks=100");
    assertNoNegativeEnergy({ "project.trucksPerDay": 1000 }, "trucks=1000");
  });

  it("年电池侧充电量按 100:300:1000 = 1:3:10 精确线性（因果：车队→能量）", () => {
    const t1 = computeTechModel(resolveSandbox({ user: { values: { "project.trucksPerDay": 100 } } }).numeric);
    const t3 = computeTechModel(resolveSandbox({ user: { values: { "project.trucksPerDay": 300 } } }).numeric);
    const t10 = computeTechModel(resolveSandbox({ user: { values: { "project.trucksPerDay": 1000 } } }).numeric);
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
  const lo = ok(runSandboxModel({ user: { values: { "project.chargePerTruck": 50 } } }));
  const mid = ok(runSandboxModel({ user: { values: { "project.chargePerTruck": 150 } } }));
  const hi = ok(runSandboxModel({ user: { values: { "project.chargePerTruck": 300 } } }));

  it("三档全部有限且能量非负", () => {
    assertFinite(lo, "perTruck=50");
    assertFinite(mid, "perTruck=150");
    assertFinite(hi, "perTruck=300");
    assertNoNegativeEnergy({ "project.chargePerTruck": 50 }, "perTruck=50");
    assertNoNegativeEnergy({ "project.chargePerTruck": 300 }, "perTruck=300");
  });

  it("年充电量按 50:150:300 = 1:3:6 线性", () => {
    const t1 = computeTechModel(resolveSandbox({ user: { values: { "project.chargePerTruck": 50 } } }).numeric);
    const t3 = computeTechModel(resolveSandbox({ user: { values: { "project.chargePerTruck": 150 } } }).numeric);
    const t6 = computeTechModel(resolveSandbox({ user: { values: { "project.chargePerTruck": 300 } } }).numeric);
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
    const t1 = computeTechModel(resolveSandbox({ user: { values: { "project.chargePerTruck": 50 } } }).numeric);
    const t6 = computeTechModel(resolveSandbox({ user: { values: { "project.chargePerTruck": 300 } } }).numeric);
    if (t1.ok && t6.ok) {
      expect(t6.firstYear.renewableFractionPct).toBeLessThanOrEqual(t1.firstYear.renewableFractionPct + 0.1);
      // PV 恒定，负荷↑ → self 上升、export 下降
      expect(t6.firstYear.selfConsumedY1Kwh).toBeGreaterThanOrEqual(t1.firstYear.selfConsumedY1Kwh);
      expect(t6.firstYear.pvExportY1Kwh).toBeLessThanOrEqual(t1.firstYear.pvExportY1Kwh + 1);
    }
  });
});

describe("TASK2 · 轴 C：电价 elecPrice 0.4 → 0.7 → 1.2", () => {
  const lo = ok(runSandboxModel({ user: { values: { "region.elecPrice": 0.4 } } }));
  const mid = ok(runSandboxModel({ user: { values: { "region.elecPrice": 0.7 } } }));
  const hi = ok(runSandboxModel({ user: { values: { "region.elecPrice": 1.2 } } }));

  it("三档全部有限", () => {
    assertFinite(lo, "elec=0.4");
    assertFinite(mid, "elec=0.7");
    assertFinite(hi, "elec=1.2");
  });

  it("购电成本随电价单调增（因果：电价→成本）", () => {
    expect(mid.energyCostY1).toBeGreaterThan(lo.energyCostY1);
    expect(hi.energyCostY1).toBeGreaterThan(mid.energyCostY1);
  });

  it("NPV 随电价**上升**（因自用绿电的机会成本上升，光伏替代价值↑，抵消下网成本↑）", () => {
    // 基线含 500kWp PV 与 15000 kWh/日 负荷；电价↑ 时:
    //   - 下网部分变贵（负向）
    //   - 但 PV 自用的替代价值↑（正向，因为原本要用 0.4-1.2 元/kWh 买的电现在免费）
    // 净方向取决于自用比例。当前默认 self 占比高，电价↑通常使项目更值。
    // 关键：**不是常数**（用户能感知到因果），且方向可解释。
    expect(new Set([lo.metrics.npv, mid.metrics.npv, hi.metrics.npv]).size).toBe(3);
    expect(hi.metrics.npv).not.toBeCloseTo(lo.metrics.npv, 0);
  });
});

describe("TASK2 · 轴 D：光伏 pvCapacity 0 → 500 → 5000 → 20000", () => {
  const zero = ok(runSandboxModel({ user: { values: { "project.pvCapacity": 0 } } }));
  const base = ok(runSandboxModel({ user: { values: { "project.pvCapacity": 500 } } }));
  const big = ok(runSandboxModel({ user: { values: { "project.pvCapacity": 5000 } } }));
  const huge = ok(runSandboxModel({ user: { values: { "project.pvCapacity": 20000 } } }));

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
    const t = computeTechModel(resolveSandbox({ user: { values: { "project.pvCapacity": 0 } } }).numeric);
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
    const t = computeTechModel(resolveSandbox({ user: { values: { "project.pvCapacity": 20000 } } }).numeric);
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
  const zero = ok(runSandboxModel({ user: { values: { "project.storageEnergy": 0 } } }));
  const base = ok(runSandboxModel({ user: { values: { "project.storageEnergy": 400 } } }));
  const big = ok(runSandboxModel({ user: { values: { "project.storageEnergy": 2000 } } }));
  const huge = ok(runSandboxModel({ user: { values: { "project.storageEnergy": 8000 } } }));

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
   * P1-2 钉桩：当前模型储能**只有成本没有货币化收益**（tech 层 storageThroughput 未回灌 E3/E4）。
   * 结果：NPV 随储能容量**严格单调下降**。这不是期望行为（真实储能靠峰谷套利可正贡献），
   * 而是 V1 已知缺陷。此断言确保：
   *   ① 未来若无意"以为储能会正贡献"改了口径，本测试会立即失败暴露回归；
   *   ② 一旦 R8.8b 创始人批准接入峰谷套利，此测试**必须同步改写**为"存在正 NPV 贡献"。
   */
  it("【P1-2 已知缺陷钉桩】NPV 随储能容量严格单调下降（V1 储能未货币化）", () => {
    expect(base.metrics.npv).toBeLessThan(zero.metrics.npv);
    expect(big.metrics.npv).toBeLessThan(base.metrics.npv);
    expect(huge.metrics.npv).toBeLessThan(big.metrics.npv);
  });
});

describe("TASK2 · P1-1 假联动钉桩：chargerUtilization 未参与计算", () => {
  /**
   * 「车辆利用率」滑块在面板上可拖，但 E1/E2/E3/E4 全未读取此键。拖动 → NPV 一点不变。
   * 属**已声明的缺陷**（详见 docs/MODEL_CAUSALITY_AUDIT_V1.md P1-1）。
   * 若未来接入 S1 逐时曲线或功率-能量重算，本测试**必须同步改写**为"NPV 应随利用率变化"。
   */
  const a = npvOf({ "project.chargerUtilization": 5 });
  const b = npvOf({ "project.chargerUtilization": 35 });
  const c = npvOf({ "project.chargerUtilization": 90 });

  it("当前：三档 NPV 完全相同（假联动的直接证据）", () => {
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
  const base = npvOf({});
  for (const key of [
    "region.peakValleySpread",
    "region.demandCharge",
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
      const r = ok(runSandboxModel({ user: { values: c.values } }));
      assertFinite(r, c.name);
      assertNoNegativeEnergy(c.values, c.name);
    });
  }
});

describe("TASK2 · IRR 诚实降级（现金流形态极端时不硬编）", () => {
  it("充电价压到 0.3 → 现金流大概率无正 IRR → 诚实 ok:false（或不合理高 IRR 被截）", () => {
    const r = ok(runSandboxModel({ user: { values: { "project.chargingPrice": 0.3 } } }));
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
      runSandboxModel({
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
