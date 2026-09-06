import { describe, it, expect } from "vitest";
import type { ResolvedParameter } from "@/server/parameter-engine";
import { runSandboxModelBaseline } from "@/server/sandbox-model";
import {
  DEMO_MODEL_VERSION,
  DEMO_OPERATING_DAYS,
  DEMO_HEADLINE_SPECS,
  defaultDemoState,
  fleetChargePerTruckDaily,
  fleetAnnualChargeEnergy,
  demoUserValues,
  classifyParameterOrigin,
  computeDemoScenario,
  demoBaseline,
  serializeDemoLayers,
  deserializeDemoState,
  type DemoHeadlineState,
} from "@/server/sandbox-demo";

/**
 * R8.8a 示范项目「映射层 + 来源分类器」单元黄金样本（纯函数，无 DB/网络/时钟）。
 *
 * 焊死四件事：
 *   ① 车队能耗折算算得对，且默认态逐字复现 R1.2 基线（零churn，延续 R8.7 纪律）；
 *   ② 映射层只把"用户真动过"的字段垫进既有 40 参数引擎（未动的保留地区/系统默认，供如实分类）；
 *   ③ classifyParameterOrigin 四类来源真值表（用户输入/系统默认/计算值/外部数据 + 政策子类 + 已核实标记）；
 *   ④ §4/§10 命脉：改一个核心参数 → 底层网关变 → 经济结果变 → 图表数据变 → 报告结论变，
 *      且全曝光滑杆区间内网关值永不被引擎裁剪（联动可预测）。
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

/** 造一条引擎解析结果（供分类器真值表；默认给一条"全默认占位假设"的合规行）。 */
function mkRp(p: Partial<ResolvedParameter> & { key: string }): ResolvedParameter {
  return {
    key: p.key,
    group: p.group ?? "project",
    exposure: p.exposure ?? "basic",
    kind: p.kind ?? "numeric",
    unit: p.unit,
    value: p.value ?? 0,
    origin: p.origin ?? "default",
    source: p.source ?? "【占位假设·待核实】",
    confidence: p.confidence ?? 40,
    evidenceKind: p.evidenceKind ?? "ASSUMPTION",
    ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
    ...(p.sourceType ? { sourceType: p.sourceType } : {}),
    ...(p.asOf ? { asOf: p.asOf } : {}),
    editable: p.editable ?? true,
    overridden: p.overridden ?? false,
    clamped: p.clamped ?? false,
    notes: p.notes ?? [],
  };
}

describe("sandbox-demo · 车队能耗折算（纯映射公式手算）", () => {
  it("单车日均充电量 = 电耗/100 × 年里程/运营天数（125→7万km→350天 = 250，精确）", () => {
    expect(fleetChargePerTruckDaily(125, 70000, DEMO_OPERATING_DAYS)).toBe(250);
  });

  it("车队年充电量 = 车数 × 年里程 × 电耗 /100（默认 60×7万×125 = 525万 kWh/年）", () => {
    expect(fleetAnnualChargeEnergy(defaultDemoState())).toBe(5_250_000);
  });

  it("默认态折算回既有网关值：trucksPerDay=60 × chargePerTruck=250 = 日充电 15000（= 基线）", () => {
    const s = defaultDemoState();
    const c = computeDemoScenario(s, {}, NOW);
    // 默认无 touched → 不覆写，走 R1.2 全局默认
    expect(c.userValues).toEqual({});
    expect(c.resolved.numeric["derived.dailyChargeEnergy"]).toBe(15000);
    // 年充电量与网关口径自洽（opDays 约去）
    const delivered = c.tech && c.tech.ok ? c.tech.firstYear.chargeEnergyDeliveredY1Kwh : null;
    expect(delivered).toBe(5_250_000);
    expect(c.outputs.annualChargeEnergyKwh).toBe(5_250_000);
  });

  it("版本号合规（映射层版本独立于经济内核）", () => {
    expect(DEMO_MODEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("sandbox-demo · demoUserValues：只垫'用户真动过'的字段", () => {
  it("无任何 touched → 空覆写（全走地区/系统默认）", () => {
    expect(demoUserValues(defaultDemoState(), {})).toEqual({});
  });

  it("fleet 任一被触碰 → 成对垫 trucksPerDay + chargePerTruck（另两个未动也随当前态算）", () => {
    const s: DemoHeadlineState = { ...defaultDemoState(), energyPer100km: 140 };
    const v = demoUserValues(s, { energyPer100km: true });
    expect(v["project.trucksPerDay"]).toBe(60);
    expect(v["project.chargePerTruck"]).toBeCloseTo((140 / 100) * (70000 / 350), 6);
  });

  it("储能容量被触碰 → 联动垫 storagePower = 容量/2（保持储能参与）", () => {
    const s: DemoHeadlineState = { ...defaultDemoState(), storageEnergy: 2000 };
    const v = demoUserValues(s, { storageEnergy: true });
    expect(v["project.storageEnergy"]).toBe(2000);
    expect(v["project.storagePower"]).toBe(1000);
  });

  it("储能容量归零 → 功率也 0（诚实降级无储能场景）", () => {
    const v = demoUserValues({ ...defaultDemoState(), storageEnergy: 0 }, { storageEnergy: true });
    expect(v["project.storagePower"]).toBe(0);
  });

  it("购电价格被触碰 → 垫 region.elecPrice；未触碰 → 不垫（保留地区/系统默认）", () => {
    expect(demoUserValues({ ...defaultDemoState(), elecPrice: 1.1 }, { elecPrice: true })["region.elecPrice"]).toBe(1.1);
    expect("region.elecPrice" in demoUserValues({ ...defaultDemoState(), elecPrice: 1.1 }, {})).toBe(false);
  });
});

describe("sandbox-demo · classifyParameterOrigin 四类真值表（不改引擎枚举）", () => {
  it("origin=default 且未改 → 系统默认", () => {
    expect(classifyParameterOrigin(mkRp({ key: "project.pvCapacity", value: 500, origin: "default" })).category).toBe("SYSTEM_DEFAULT");
  });

  it("origin=user 但本次未真正改动（程序垫入默认）→ 仍判系统默认（不虚标用户输入）", () => {
    const info = classifyParameterOrigin(mkRp({ key: "project.trucksPerDay", value: 60, origin: "user" }), { touched: false });
    expect(info.category).toBe("SYSTEM_DEFAULT");
    expect(info.userModified).toBe(false);
  });

  it("touched=true → 用户输入", () => {
    const info = classifyParameterOrigin(mkRp({ key: "project.pvCapacity", value: 800, origin: "user" }), { touched: true });
    expect(info.category).toBe("USER_INPUT");
    expect(info.userModified).toBe(true);
  });

  it("origin=derived → 计算值", () => {
    expect(classifyParameterOrigin(mkRp({ key: "derived.dailyChargeEnergy", value: 15000, origin: "derived" })).category).toBe("CALCULATED");
  });

  it("origin=region → 外部数据 / 地区；带合法 http(s) FACT 才标已核实", () => {
    const info = classifyParameterOrigin(
      mkRp({ key: "region.elecPrice", value: 0.55, origin: "region", evidenceKind: "FACT", sourceUrl: "https://example.gov/price", asOf: "2024-06" }),
    );
    expect(info.category).toBe("EXTERNAL_DATA");
    expect(info.externalKind).toBe("地区");
    expect(info.verified).toBe(true);
    expect(info.asOf).toBe("2024-06");
  });

  it("origin=policy → 外部数据 / 政策", () => {
    const info = classifyParameterOrigin(mkRp({ key: "policy.feedInTariff", value: 0.33, origin: "policy" }));
    expect(info.category).toBe("EXTERNAL_DATA");
    expect(info.externalKind).toBe("政策");
  });

  it("FACT 却无 http(s) 链接 → verified=false（§20 无来源不当事实）", () => {
    const info = classifyParameterOrigin(mkRp({ key: "region.elecPrice", value: 0.55, origin: "region", evidenceKind: "FACT" }));
    expect(info.verified).toBe(false);
  });

  it("解析缺省（undefined）→ 诚实回落系统默认、不抛", () => {
    expect(() => classifyParameterOrigin(undefined)).not.toThrow();
    expect(classifyParameterOrigin(undefined).category).toBe("SYSTEM_DEFAULT");
  });

  it("传入 label 覆盖展示名（镜像字段显示车队口径而非引擎网关键）", () => {
    const info = classifyParameterOrigin(mkRp({ key: "project.chargePerTruck", value: 250 }), { label: "车辆百公里电耗" });
    expect(info.label).toBe("车辆百公里电耗");
  });
});

describe("sandbox-demo · §4 命脉：改一个核心参数 → 网关/经济/图表/报告全链变", () => {
  const base = demoBaseline();

  function npvOf(c: ReturnType<typeof computeDemoScenario>): number {
    return c.calc.ok ? c.calc.metrics.npv : NaN;
  }
  function chargingRevOf(c: ReturnType<typeof computeDemoScenario>): number {
    return c.calc.ok ? c.calc.revenueY1.charging : NaN;
  }
  function execText(c: ReturnType<typeof computeDemoScenario>): string {
    return (c.report.sections.find((s) => s.key === "exec")?.paragraphs ?? []).join("\n");
  }

  it("增加车队规模 → 年充电量↑ → 充电收入↑ → NPV 变化（经济结果真变）", () => {
    const more = computeDemoScenario({ ...defaultDemoState(), truckCount: 120 }, { truckCount: true }, NOW);
    expect(more.resolved.numeric["derived.dailyChargeEnergy"]).toBe(120 * 250); // 30000
    expect(chargingRevOf(more)).toBeGreaterThan(chargingRevOf(base));
    expect(npvOf(more)).not.toBe(npvOf(base));
  });

  it("提高百公里电耗 → 网关 chargePerTruck↑ → 日充电量↑（底层参数正确变化）", () => {
    const hi = computeDemoScenario({ ...defaultDemoState(), energyPer100km: 160 }, { energyPer100km: true }, NOW);
    expect(hi.resolved.numeric["project.chargePerTruck"]).toBeCloseTo((160 / 100) * (70000 / 350), 6);
    expect(hi.outputs.dailyChargeEnergyKwh).toBeGreaterThan(base.outputs.dailyChargeEnergyKwh);
  });

  it("改参数 → 视图模型指标卡与现金流曲线数据随之变（图表真变）", () => {
    const more = computeDemoScenario({ ...defaultDemoState(), truckCount: 120 }, { truckCount: true }, NOW);
    const npvCard = (c: ReturnType<typeof computeDemoScenario>) => c.vm.cards?.find((k) => k.key === "npv")?.value;
    expect(npvCard(more)).not.toBe(npvCard(base));
    // 首年现金流 flow 值不同 → 图表投影会变
    expect(more.vm.cashFlow?.[1]?.flow).not.toBe(base.vm.cashFlow?.[1]?.flow);
  });

  it("改参数 → 动态报告执行摘要文本变（含 NPV 串变），敏感性龙卷风锚定新基线", () => {
    const more = computeDemoScenario({ ...defaultDemoState(), truckCount: 120 }, { truckCount: true }, NOW);
    expect(execText(more)).not.toBe(execText(base));
    expect(more.report.sections.some((s) => s.key === "sensitivity")).toBe(true);
    // trucksPerDay 是默认龙卷风扫描项之一 → 车队改动应在龙卷风里体现
    expect(more.tornado.rows.some((r) => r.key === "project.trucksPerDay")).toBe(true);
  });

  it("报告改动清单只列被触碰的字段（用户输入透明可追溯）", () => {
    const c = computeDemoScenario(
      { ...defaultDemoState(), pvCapacity: 1200, chargerUnitPower: 480 },
      { pvCapacity: true, chargerUnitPower: true },
      NOW,
    );
    const exec = execText(c);
    expect(exec).toContain("光伏装机");
    expect(exec).toContain("充电功率");
    expect(exec).not.toContain("重卡数量");
  });
});

describe("sandbox-demo · headline 来源分类在真实情景下正确", () => {
  it("默认态(全国通用)：镜像字段均判系统默认、地区行判系统默认", () => {
    const c = demoBaseline();
    const byId = (id: string) => c.headlines.find((h) => h.spec.id === id)!.origin;
    expect(byId("pvCapacity").category).toBe("SYSTEM_DEFAULT");
    expect(byId("truckCount").category).toBe("SYSTEM_DEFAULT");
    expect(byId("region").category).toBe("SYSTEM_DEFAULT");
  });

  it("选山西但不手改电价：购电价格行判'外部数据/地区'（地区包默认，非用户输入）", () => {
    const c = computeDemoScenario({ ...defaultDemoState(), regionId: "shanxi" }, {}, NOW);
    const elec = c.headlines.find((h) => h.spec.id === "elecPrice")!.origin;
    expect(elec.category).toBe("EXTERNAL_DATA");
    expect(elec.externalKind).toBe("地区");
    expect(elec.userModified).toBe(false);
  });

  it("山西 + 手改电价 → 该行升为用户输入（覆盖地区默认）", () => {
    const c = computeDemoScenario({ ...defaultDemoState(), regionId: "shanxi", elecPrice: 0.8 }, { elecPrice: true }, NOW);
    const elec = c.headlines.find((h) => h.spec.id === "elecPrice")!.origin;
    expect(elec.category).toBe("USER_INPUT");
  });
});

describe("sandbox-demo · 全曝光滑杆区间内网关值永不被引擎裁剪（联动可预测）", () => {
  function unclampedFleet(s: DemoHeadlineState) {
    const c = computeDemoScenario(s, { truckCount: true, annualMileagePerTruck: true, energyPer100km: true }, NOW);
    expect(c.resolved.params["project.trucksPerDay"]?.clamped).toBe(false);
    expect(c.resolved.params["project.chargePerTruck"]?.clamped).toBe(false);
    return c;
  }

  it("上界（500 车 / 10万km / 160kWh）映射值落在引擎带内且不裁剪", () => {
    const c = unclampedFleet({ ...defaultDemoState(), truckCount: 500, annualMileagePerTruck: 100000, energyPer100km: 160 });
    expect(c.resolved.numeric["project.chargePerTruck"]).toBeLessThanOrEqual(600);
    expect(c.resolved.numeric["project.trucksPerDay"]).toBe(500);
  });

  it("下界（1 车 / 3万km / 80kWh）映射值落在引擎带内且不裁剪", () => {
    const c = unclampedFleet({ ...defaultDemoState(), truckCount: 1, annualMileagePerTruck: 30000, energyPer100km: 80 });
    expect(c.resolved.numeric["project.chargePerTruck"]).toBeGreaterThanOrEqual(50);
  });

  it("headline 规格区间自洽（min<max）", () => {
    for (const s of DEMO_HEADLINE_SPECS) {
      if (s.id === "region") continue;
      expect(s.min, s.id).toBeLessThan(s.max);
    }
  });
});

describe("sandbox-demo · 零churn：默认态经济结果与 R1–R7 基线逐字相等", () => {
  it("computeDemoScenario(默认, 无改动) 的 CalcResult 深等于 runSandboxModelBaseline()", () => {
    const c = demoBaseline();
    expect(c.calc).toEqual(runSandboxModelBaseline());
    // 且不因示范项目而 bump 经济内核版本
    expect(c.calc.ok && c.calc.engineVersions.model).toBe("1.0.0");
  });

  it("示范项目结论恒标需专业人工确认（诚实边界不回退）", () => {
    const calc = demoBaseline().calc;
    expect(calc.ok && calc.needsProfessionalReview).toBe(true);
  });
});

describe("sandbox-demo · 零迁移持久化（塞进 paramLayers 的 demo 块）", () => {
  it("serialize→deserialize 往返保真 state + touched", () => {
    const state: DemoHeadlineState = { ...defaultDemoState(), truckCount: 150, pvCapacity: 3000, regionId: "shanxi" };
    const touched = { truckCount: true, pvCapacity: true } as const;
    const c = computeDemoScenario(state, { ...touched }, NOW);
    const round = deserializeDemoState(serializeDemoLayers(c));
    expect(round).not.toBeNull();
    expect(round!.state.truckCount).toBe(150);
    expect(round!.state.pvCapacity).toBe(3000);
    expect(round!.state.regionId).toBe("shanxi");
    expect(round!.touched.truckCount).toBe(true);
    // demo 块作为顶层附加键挂在 layers 上，不影响 region/policy/user 结构
    expect((serializeDemoLayers(c) as { user?: unknown }).user).toBeTruthy();
  });

  it("普通 40 参数项目分层（无 demo 块）→ 反序列化诚实返回 null", () => {
    expect(deserializeDemoState({ region: { values: {} }, user: { values: { "project.pvCapacity": 999 } } })).toBeNull();
    expect(deserializeDemoState(null)).toBeNull();
  });

  it("反序列化对脏值回落默认（非有限/缺字段不炸）", () => {
    const round = deserializeDemoState({ demo: { state: { truckCount: "x", pvCapacity: 1234 } } });
    expect(round!.state.truckCount).toBe(defaultDemoState().truckCount);
    expect(round!.state.pvCapacity).toBe(1234);
  });
});
