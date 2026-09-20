import { describe, it, expect } from "vitest";

/**
 * R6 · M13 偏差分析**纯函数**单测（离线、零 prisma、零网络）。
 *
 * 守的是一旦破就极隐蔽、且直接决定"偏差结论可不可信"的纪律（§8–§20）：
 *   · null ≠ 0（没测绝不显示成 -100%）；预测为 0 → 百分比不可算但绝对偏差仍报；
 *   · 口径/单位不一致一律 NOT_COMPARABLE，绝不跨口径硬比；
 *   · §20 反"平均到 0 就没事"：+20%/−20% 会暴露 meanAbsPct + cancelsOut，且**不**生成自动改参候选；
 *   · 影响只做同量纲换算（钱=FACT、电量×预测隐含单价=ASSUMPTION），绝不复制 NPV/折现；
 *   · 候选只在方向一致 + 样本够 + 超阈值时产出；跨项目聚合给加权/不加权两套且标 systemic。
 *
 * 这些都不经数据库，因此与黄金基线无关；冻结的 ENGINE_VERSION/BENCHMARK_VERSION 在末尾反证未动。
 */

import { runCalculation } from "@app/kernel/engine/engine";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import { ENGINE_VERSION } from "@app/kernel/engine/engine";
import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import type { CalculationResult } from "@app/kernel/engine/types";
import {
  buildForecastSnapshot,
  computeDeviation,
  analyzeForecastVsActual,
  deriveImpacts,
  detectCalibrationCandidates,
  aggregateCrossProjectBias,
  DEVIATION_METRICS,
  CALIBRATION_STATUSES,
  DEFAULT_DETECT_CONFIG,
  METRICLESS_ACTUAL_FIELDS,
} from "@app/kernel/engine/deviation";
import type { ActualLike, ForecastSnapshot } from "@app/kernel/engine/deviation";

/* ─────────────── 构造工具 ─────────────── */

/** 造一份可控的预测快照（纯测试用；结构即 ForecastSnapshot 契约）。 */
function makeForecast(over: Partial<ForecastSnapshot> = {}): ForecastSnapshot {
  return {
    identity: {
      engineVersion: "calc@2.0.0",
      modelVersion: "2.0.0",
      benchmarkVersion: "1.0.0",
      inputHash: "hash-test",
      scenarioSchemaVersion: "1.0.0",
      regionId: "sx",
      snapshotSchema: "forecast-snapshot/v1",
    },
    annual: {
      gridImportKwh: 2_000_000,
      pvGenerationKwh: 1_000_000,
      bessDischargeKwh: 200_000,
      deliveredKwh: 1_500_000,
      exportKwh: 50_000,
      gridCostYuan: 500_000,
      serviceRevenueYuan: 300_000,
      grossRevenueYuan: 360_000,
      opexYuan: 120_000,
    },
    monthly: {
      // 前 3 个月每月预测 90,000 kWh 光伏；其余月 0（无同月实测时会被判 MISSING_ACTUAL）
      pvGenerationKwh: [90_000, 90_000, 90_000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    implied: {
      costPerImportKwhYuan: 0.25, // 500000/2000000
      serviceFeePerDeliveredKwhYuan: 0.5,
    },
    comparabilityNotes: {},
    ...over,
  };
}

/** 造一条实测行：只覆盖传入字段，其余一律 null（= 没测）。 */
function makeActual(partial: Partial<ActualLike> & { periodYear: number; periodMonth: number }): ActualLike {
  return {
    gridImportKwh: null,
    pvGenerationKwh: null,
    bessDischargeKwh: null,
    deliveredKwh: null,
    exportKwh: null,
    gridCostYuan: null,
    revenueYuan: null,
    opexYuan: null,
    availabilityPct: null,
    ...partial,
  };
}

function realCalc(): CalculationResult {
  const { input } = defaultScenarioInput({
    chargingServiceFeeYuanPerKwh: 0.5,
    templateId: "pv-bess-tou",
    name: "反偏差测试情景",
  });
  const out = runCalculation(input);
  // runCalculation 成功分支直接返回 CalculationResult（其 ok:true），没有额外的 .result 包装层。
  if (!out.ok) throw new Error(`前置不成立：默认光伏+储能情景必须算通（${"detail" in out ? out.detail : "?"}）`);
  return out;
}

/* ═══════════════════ 1. buildForecastSnapshot：只读投影，不改 calc ═══════════════════ */

describe("R6 · buildForecastSnapshot（对真实 calc 的只读投影）", () => {
  it("identity 取自 calc 的版本/指纹/地区，snapshotSchema 钉死 v1", () => {
    const calc = realCalc();
    const snap = buildForecastSnapshot(calc);
    expect(snap.identity.engineVersion).toBe(calc.calcRef);
    expect(snap.identity.modelVersion).toBe(calc.engineVersion);
    expect(snap.identity.benchmarkVersion).toBe(calc.benchmarkVersion);
    expect(snap.identity.inputHash).toBe(calc.inputHash);
    expect(snap.identity.snapshotSchema).toBe("forecast-snapshot/v1");
  });

  it("年度字段与 calc 一一对应、逐月 pv 长度 12", () => {
    const calc = realCalc();
    const snap = buildForecastSnapshot(calc);
    expect(snap.annual.gridImportKwh).toBe(calc.grid.annualImportKwh);
    expect(snap.annual.pvGenerationKwh).toBe(calc.pv.annualGenerationKwh);
    expect(snap.annual.gridCostYuan).toBe(calc.grid.annualGridCostYuan);
    expect(snap.monthly.pvGenerationKwh).toHaveLength(12);
    expect(snap.monthly.pvGenerationKwh).toEqual([...calc.pv.monthlyGenerationKwh]);
  });

  it("隐含单价 = 同一次预测内的比值（购电成本 / 购电量）", () => {
    const calc = realCalc();
    const snap = buildForecastSnapshot(calc);
    if (snap.implied.costPerImportKwhYuan != null) {
      expect(snap.implied.costPerImportKwhYuan).toBeCloseTo(
        calc.grid.annualGridCostYuan / calc.grid.annualImportKwh,
        6,
      );
    }
  });

  it("非破坏性：投影前后 calc 逐字节相同（绝不回写、绝不重算）", () => {
    const calc = realCalc();
    const before = JSON.stringify(calc);
    buildForecastSnapshot(calc);
    expect(JSON.stringify(calc)).toBe(before);
  });
});

/* ═══════════════════ 2. computeDeviation：§8 唯一公式源 + 完整度闸门 ═══════════════════ */

describe("R6 · computeDeviation（状态判定与除零/null 纪律）", () => {
  const base = { metricKey: "x", label: "X", periodYear: 2026, periodMonth: 0, unit: "kWh", basis: "b" };

  it("两边同口径有值 → COMPARABLE，给出绝对 + 百分比偏差与方向", () => {
    const p = computeDeviation({ ...base, forecast: 100, actual: 120 });
    expect(p.status).toBe("COMPARABLE");
    expect(p.absoluteDeviation).toBeCloseTo(20);
    expect(p.percentageDeviation).toBeCloseTo(20);
    expect(p.direction).toBe("actual_above");
  });

  it("恰相等 → MATCH（偏差为 0，不是缺失）", () => {
    const p = computeDeviation({ ...base, forecast: 100, actual: 100 });
    expect(p.status).toBe("MATCH");
    expect(p.percentageDeviation).toBe(0);
    expect(p.direction).toBe("match");
  });

  it("实测为 null ≠ 0 → MISSING_ACTUAL，绝不给 -100%", () => {
    const p = computeDeviation({ ...base, forecast: 100, actual: null });
    expect(p.status).toBe("MISSING_ACTUAL");
    expect(p.percentageDeviation).toBeNull();
    expect(p.absoluteDeviation).toBeNull();
    expect(p.reason).toBe("not_reported");
  });

  it("预测缺失 → MISSING_FORECAST", () => {
    const p = computeDeviation({ ...base, forecast: null, actual: 50 });
    expect(p.status).toBe("MISSING_FORECAST");
    expect(p.reason).toBe("no_forecast_same_basis");
  });

  it("预测为 0 → 绝对偏差可报、百分比置 null（防除零）", () => {
    const p = computeDeviation({ ...base, forecast: 0, actual: 30 });
    expect(p.status).toBe("ZERO_FORECAST");
    expect(p.absoluteDeviation).toBeCloseTo(30);
    expect(p.percentageDeviation).toBeNull();
    expect(p.reason).toBe("zero_forecast_pct_undefined");
  });

  it("口径不一致 → NOT_COMPARABLE（绝不跨 basis 硬比）", () => {
    const p = computeDeviation({ ...base, actualBasis: "other", forecast: 100, actual: 120 });
    expect(p.status).toBe("NOT_COMPARABLE");
    expect(p.reason).toBe("basis_mismatch");
  });

  it("单位不一致 → NOT_COMPARABLE", () => {
    const p = computeDeviation({ ...base, actualUnit: "MWh", forecast: 100, actual: 120 });
    expect(p.status).toBe("NOT_COMPARABLE");
    expect(p.reason).toBe("unit_mismatch");
  });
});

/* ═══════════════════ 3. analyzeForecastVsActual：逐指标对齐 + 完整度 ═══════════════════ */

describe("R6 · analyzeForecastVsActual（年度 + 仅光伏逐月）", () => {
  it("光伏有逐月预测、其余指标无 → 非光伏月份标 MISSING_FORECAST 而非凑数", () => {
    const forecast = makeForecast();
    const actuals = [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 80_000 }),
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: 78_000 }),
      makeActual({ periodYear: 2026, periodMonth: 3, pvGenerationKwh: 82_000 }),
    ];
    const a = analyzeForecastVsActual(forecast, actuals);
    const pv = a.metrics.find((m) => m.metricKey === "pvGenerationKwh")!;
    const grid = a.metrics.find((m) => m.metricKey === "gridImportKwh")!;
    expect(pv.monthly.filter((p) => p.status === "COMPARABLE").length).toBe(3);
    // 电网侧没有同口径逐月预测 → 每月都是 MISSING_FORECAST
    expect(grid.monthly.every((p) => p.status === "MISSING_FORECAST" || p.forecast == null)).toBe(true);
  });

  it("availabilityPct（无预测侧口径）不出现在被对照指标里", () => {
    const a = analyzeForecastVsActual(makeForecast(), []);
    expect(a.metrics.map((m) => m.metricKey)).not.toContain("availabilityPct");
    expect(METRICLESS_ACTUAL_FIELDS.availabilityPct).toBeTruthy();
  });

  it("无预测快照 → forecastAvailable=false、headline 诚实说明", () => {
    const a = analyzeForecastVsActual(null, [makeActual({ periodYear: 2026, periodMonth: 0, gridCostYuan: 1 })]);
    expect(a.forecastAvailable).toBe(false);
    expect(a.anyComparable).toBe(false);
    expect(a.headline).toContain("预测");
  });

  it("同一输入两次分析逐字节相同（确定性）", () => {
    const f = makeForecast();
    const acts = [makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 80_000 })];
    expect(JSON.stringify(analyzeForecastVsActual(f, acts))).toBe(JSON.stringify(analyzeForecastVsActual(f, acts)));
  });
});

/* ═══════════════════ 4. §20 反抵消 ═══════════════════ */

describe("R6 · §20 反向抵消不得被均值掩盖", () => {
  it("+20% 与 −20% 的均值≈0，但 meanAbsPct 暴露真实误差且方向为 mixed", () => {
    const forecast = makeForecast({
      monthly: { pvGenerationKwh: [100_000, 100_000, ...Array(10).fill(0)] },
    });
    const actuals = [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 120_000 }), // +20%
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: 80_000 }), // −20%
    ];
    const a = analyzeForecastVsActual(forecast, actuals);
    const pv = a.metrics.find((m) => m.metricKey === "pvGenerationKwh")!;
    expect(Math.abs(pv.signedMeanPct ?? 999)).toBeLessThan(1); // 符号均值≈0
    expect(pv.meanAbsPct ?? 0).toBeGreaterThan(15); // 但绝对均值很大
    expect(pv.direction).toBe("mixed");
    expect(pv.cancelsOut).toBe(true);
    // 关键：这种"看似无偏实则抵消"的信号不得自动生成改参候选
    const cands = detectCalibrationCandidates({ projectId: "p1", analysis: a, impacts: [] });
    expect(cands.find((c) => c.metric === "pvGenerationKwh")).toBeUndefined();
  });

  it("单样本 → insufficientData=true", () => {
    const a = analyzeForecastVsActual(makeForecast(), [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 80_000 }),
    ]);
    const pv = a.metrics.find((m) => m.metricKey === "pvGenerationKwh")!;
    expect(pv.comparableCount).toBe(1);
    expect(pv.insufficientData).toBe(true);
  });
});

/* ═══════════════════ 5. deriveImpacts：§14 同量纲、不复制 NPV ═══════════════════ */

describe("R6 · deriveImpacts（钱=FACT，电量×隐含单价=ASSUMPTION）", () => {
  it("金额指标直接给 FACT 影响", () => {
    const forecast = makeForecast();
    const a = analyzeForecastVsActual(forecast, [
      makeActual({ periodYear: 2026, periodMonth: 0, gridCostYuan: 560_000 }), // +60000
      makeActual({ periodYear: 2026, periodMonth: 0, revenueYuan: 255_000 }), // 对 serviceRevenue −45000
    ]);
    const impacts = deriveImpacts(forecast, a);
    const cost = impacts.find((i) => i.metricKey === "gridCostYuan")!;
    expect(cost.evidenceKind).toBe("FACT");
    expect(cost.amountYuan).toBeCloseTo(60_000, 2);
  });

  it("电量指标按预测隐含单价折算并标 ASSUMPTION", () => {
    const forecast = makeForecast({
      monthly: { pvGenerationKwh: [90_000, 90_000, 90_000, ...Array(9).fill(0)] },
    });
    const a = analyzeForecastVsActual(forecast, [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 80_000 }),
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: 78_000 }),
      makeActual({ periodYear: 2026, periodMonth: 3, pvGenerationKwh: 82_000 }),
    ]);
    const impacts = deriveImpacts(forecast, a);
    const pv = impacts.find((i) => i.metricKey === "pvGenerationKwh")!;
    expect(pv.evidenceKind).toBe("ASSUMPTION");
    // 净偏差 −30000 × 0.5 = −15000
    expect(pv.amountYuan).toBeCloseTo(-15_000, 2);
    expect(pv.note).toContain("非重算 NPV");
  });

  it("隐含单价缺失（分母为 0）→ 不臆算金额、amountYuan=null", () => {
    const forecast = makeForecast({ implied: { costPerImportKwhYuan: null, serviceFeePerDeliveredKwhYuan: null } });
    const a = analyzeForecastVsActual(forecast, [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 80_000 }),
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: 78_000 }),
    ]);
    const pv = deriveImpacts(forecast, a).find((i) => i.metricKey === "pvGenerationKwh")!;
    expect(pv.amountYuan).toBeNull();
    expect(pv.note).toContain("不臆算");
  });
});

/* ═══════════════════ 6. detectCalibrationCandidates ═══════════════════ */

describe("R6 · detectCalibrationCandidates（只认方向一致 + 样本够 + 超阈值）", () => {
  it("光伏连续低于预测 → 生成 over_forecast 候选，dedupeKey/样本数/方向齐备", () => {
    const forecast = makeForecast({
      monthly: { pvGenerationKwh: [90_000, 90_000, 90_000, ...Array(9).fill(0)] },
    });
    const a = analyzeForecastVsActual(forecast, [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 80_000 }),
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: 78_000 }),
      makeActual({ periodYear: 2026, periodMonth: 3, pvGenerationKwh: 82_000 }),
    ]);
    const impacts = deriveImpacts(forecast, a);
    const cands = detectCalibrationCandidates({ projectId: "p1", analysis: a, impacts });
    const pv = cands.find((c) => c.metric === "pvGenerationKwh");
    expect(pv).toBeTruthy();
    expect(pv!.direction).toBe("over_forecast");
    expect(pv!.sampleCount).toBeGreaterThanOrEqual(2);
    expect(pv!.dedupeKey).toContain("pvGenerationKwh");
    expect(pv!.parameter).toBe("pv.specificYieldKwhPerKwp");
    expect(pv!.suggestion).toBeTruthy();
  });

  it("偏差未超阈值 → 不产出候选", () => {
    const forecast = makeForecast({ monthly: { pvGenerationKwh: [100_000, 100_000, ...Array(10).fill(0)] } });
    const a = analyzeForecastVsActual(forecast, [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 101_000 }),
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: 100_500 }),
    ]);
    const cands = detectCalibrationCandidates({ projectId: "p1", analysis: a, impacts: [] });
    expect(cands.find((c) => c.metric === "pvGenerationKwh")).toBeUndefined();
  });

  it("config 可抬高阈值 → 连刚才的候选也被过滤", () => {
    const forecast = makeForecast({ monthly: { pvGenerationKwh: [90_000, 90_000, 90_000, ...Array(9).fill(0)] } });
    const a = analyzeForecastVsActual(forecast, [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: 80_000 }),
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: 78_000 }),
      makeActual({ periodYear: 2026, periodMonth: 3, pvGenerationKwh: 82_000 }),
    ]);
    const cands = detectCalibrationCandidates({
      projectId: "p1",
      analysis: a,
      impacts: [],
      config: { biasThresholdPct: 50 },
    });
    expect(cands.find((c) => c.metric === "pvGenerationKwh")).toBeUndefined();
  });
});

/* ═══════════════════ 7. aggregateCrossProjectBias（§19/§20） ═══════════════════ */

describe("R6 · aggregateCrossProjectBias", () => {
  it("两项目同向 → systemic=true，加权/不加权两套均值都给", () => {
    const r = aggregateCrossProjectBias({
      metric: "pvGenerationKwh",
      basis: "pv-ac-generation",
      regionId: "sx",
      biases: [
        { projectId: "a", regionId: "sx", signedMeanPct: -10, sampleCount: 3 },
        { projectId: "b", regionId: "sx", signedMeanPct: -20, sampleCount: 6 },
      ],
    });
    expect(r.projectCount).toBe(2);
    expect(r.direction).toBe("consistent_below");
    expect(r.systemic).toBe(true);
    expect(r.unweightedMeanPct).toBeCloseTo(-15, 6);
    expect(r.weightedMeanPct).toBeCloseTo((-10 * 3 + -20 * 6) / 9, 6);
  });

  it("项目间方向相反 → mixed、不 systemic（绝不平均到 0 就宣称没事）", () => {
    const r = aggregateCrossProjectBias({
      metric: "m",
      basis: "b",
      regionId: null,
      biases: [
        { projectId: "a", regionId: null, signedMeanPct: 20, sampleCount: 5 },
        { projectId: "b", regionId: null, signedMeanPct: -20, sampleCount: 5 },
      ],
    });
    expect(r.direction).toBe("mixed");
    expect(r.systemic).toBe(false);
    expect(Math.abs(r.unweightedMeanPct)).toBeLessThan(1e-9);
  });
});

/* ═══════════════════ 8. 反证：冻结常量与目录不变 ═══════════════════ */

describe("R6 · 反证：不越界改内核与冻结常量", () => {
  it("ENGINE_VERSION 仍 2.0.0、BENCHMARK_VERSION 仍 1.0.0（R6 未惊动计算口径）", () => {
    expect(ENGINE_VERSION).toBe("2.0.0");
    expect(BENCHMARK_VERSION).toBe("1.0.0");
  });
  it("校准四态封闭枚举 + 默认检测阈值稳定", () => {
    expect([...CALIBRATION_STATUSES]).toEqual(["CANDIDATE", "UNDER_REVIEW", "ACCEPTED", "REJECTED"]);
    expect(DEFAULT_DETECT_CONFIG).toEqual({ minSamples: 2, biasThresholdPct: 5 });
  });
  it("被对照指标目录含光伏/购电/交付/储能放电/上网/购电成本/收入/运维，均带口径与单位", () => {
    expect(DEVIATION_METRICS.every((m) => m.basis && m.unit && m.actualField)).toBe(true);
    expect(DEVIATION_METRICS.map((m) => m.key)).toContain("pvGenerationKwh");
  });
});

/* ═══════════════════ 9. §33 演示链（离线纯函数段：实测→偏差→影响→候选） ═══════════════════ */

describe("R6 · §33 演示链（真实 calc 冻结预测 → 3 月实测 → 双向偏差 → 影响 → 候选）", () => {
  it("一条连贯链路：光伏连续偏低 + 购电成本偏高 → 双向偏差、影响量级、产出光伏改参候选", () => {
    // ① 冻结预测：对真实 runCalculation 产物做只读投影（不重算、不改 calc）
    const calc = realCalc();
    const forecast = buildForecastSnapshot(calc);
    expect(forecast.identity.engineVersion).toBe(calc.calcRef);
    expect(calc.pv.monthlyGenerationKwh.every((n) => Number.isFinite(n))).toBe(true);

    // ② 造 3 个月实测：光伏逐月**低于**预测（拿月度预测值 × 系数，保证同月同口径可比）
    const pvMonthly = forecast.monthly.pvGenerationKwh;
    const below = (i: number, k: number) => Math.round((pvMonthly[i] ?? 0) * k);
    const actuals: ActualLike[] = [
      makeActual({ periodYear: 2026, periodMonth: 1, pvGenerationKwh: below(0, 0.82) }), // 偏低 ~18%
      makeActual({ periodYear: 2026, periodMonth: 2, pvGenerationKwh: below(1, 0.8) }), // 偏低 ~20%
      makeActual({ periodYear: 2026, periodMonth: 3, pvGenerationKwh: below(2, 0.85) }), // 偏低 ~15%
      // 年度实测：购电成本**高于**预测同值（年偏差为正）——制造"双向"信号
      makeActual({
        periodYear: 2026,
        periodMonth: 0,
        gridCostYuan: Math.round((forecast.annual.gridCostYuan ?? 0) * 1.12),
      }),
    ];

    // ③ 分析：应同时出现"光伏偏低（负）"与"购电成本偏高（正）"两个方向的年度偏差
    const analysis = analyzeForecastVsActual(forecast, actuals);
    expect(analysis.forecastAvailable).toBe(true);
    expect(analysis.anyComparable).toBe(true);
    const pv = analysis.metrics.find((m) => m.metricKey === "pvGenerationKwh")!;
    const cost = analysis.metrics.find((m) => m.metricKey === "gridCostYuan")!;
    expect(pv.comparableCount).toBeGreaterThanOrEqual(3); // 3 个可比月度
    expect((pv.signedMeanPct ?? 0) < 0).toBe(true); // 光伏净偏低 → 负
    expect((cost.signedMeanPct ?? 0) > 0).toBe(true); // 购电成本偏高 → 正

    // ④ 影响：钱=FACT、电量折 ASSUMPTION，且都不重算 NPV
    const impacts = deriveImpacts(forecast, analysis);
    const costImpact = impacts.find((i) => i.metricKey === "gridCostYuan")!;
    const pvImpact = impacts.find((i) => i.metricKey === "pvGenerationKwh")!;
    expect(costImpact.evidenceKind).toBe("FACT");
    expect((costImpact.amountYuan ?? 0) > 0).toBe(true);
    expect(["ASSUMPTION", "FACT"]).toContain(pvImpact.evidenceKind);

    // ⑤ 候选：光伏连续同向偏低 + 样本够 + 超阈值 → 产出 over_forecast 改参候选（指向产能基准参数）
    const cands = detectCalibrationCandidates({ projectId: "prj-demo", analysis, impacts });
    const pvCand = cands.find((c) => c.metric === "pvGenerationKwh");
    expect(pvCand).toBeTruthy();
    expect(pvCand!.direction).toBe("over_forecast");
    expect(pvCand!.parameter).toBe("pv.specificYieldKwhPerKwp");
    expect(pvCand!.projectId).toBe("prj-demo");
    // detect 只产出"建议种子"（CandidateSeed），本身**不带 status**——默认 CANDIDATE 是持久化层落库时给的，
    // 这条刻意证明：分析层绝不预设"已被采纳"，改参永远要过人工审核门（§18/§34）。
    expect("status" in (pvCand as unknown as Record<string, unknown>)).toBe(false);
    expect(pvCand!.dedupeKey).toContain("pvGenerationKwh");
  });
});
