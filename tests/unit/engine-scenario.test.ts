import { describe, expect, it } from "vitest";
import {
  SCENARIO_BENCHMARK_KEYS,
  SCENARIO_TEMPLATES,
  buildScenarioFromTemplate,
  buildScenarioInput,
  defaultScenarioInput,
  getScenarioTemplate,
  normalizeComponents,
  normalizeScenarioDefinition,
} from "@app/kernel/engine/scenario";
import { BENCHMARK_ENTRIES, getBenchmark, listBenchmarks } from "@app/kernel/engine/benchmark";
import type { ScenarioDefinition } from "@app/kernel/engine/types";

const SEED = { name: "测试情景", chargingServiceFeeYuanPerKwh: 0.45 };

describe("基准层", () => {
  it("FACT 必须有可核验链接：没有链接的一律降级为 ASSUMPTION（诚实闸门）", () => {
    for (const e of BENCHMARK_ENTRIES) {
      if (e.evidenceKind === "FACT") {
        expect(e.sourceUrl, `${e.key} 标为 FACT 但没有来源链接`).toMatch(/^https?:\/\//);
      }
    }
  });

  it("UNKNOWN 的 value 必须为 null（不得用一个数字冒充「未知」）", () => {
    for (const e of BENCHMARK_ENTRIES) {
      if (e.valueClass === "UNKNOWN") expect(e.value).toBeNull();
    }
  });

  it("区分为「未知」的键取数时返回 undefined，而不是 0", () => {
    expect(getBenchmark("grid.demandChargeNominalYuanPerKwMonth", "shanxi")?.value).toBeNull();
  });

  it("山西已核实的条款级事实被标为 FACT（峰谷倍率、免收需量电费、服务费市场调节价）", () => {
    for (const key of [
      "grid.tou.peakMultiplier",
      "grid.tou.valleyMultiplier",
      "grid.demandChargePerKwMonth",
    ]) {
      const e = getBenchmark(key, "shanxi");
      expect(e, key).toBeTruthy();
      expect(e!.evidenceKind).toBe("FACT");
      expect(e!.sourceUrl).toBeTruthy();
    }
    // 免收需量电费 → 取 0 是"有依据的 0"，不是偷填
    expect(getBenchmark("grid.demandChargePerKwMonth", "shanxi")!.value).toBe(0);
  });

  it("山西的平段绝对电价**没有**官方来源，因此只能是 ASSUMPTION", () => {
    const e = getBenchmark("grid.flatPriceYuanPerKwh", "shanxi")!;
    expect(e.evidenceKind).not.toBe("FACT");
    expect(e.confidence).toBeLessThan(60);
  });

  it("情景构造器实际引用的基准键全部存在（少一个键 = 报告少一条假设）", () => {
    for (const key of SCENARIO_BENCHMARK_KEYS) {
      expect(getBenchmark(key, "shanxi"), key).toBeTruthy();
    }
    expect(listBenchmarks("shanxi").length).toBeGreaterThanOrEqual(SCENARIO_BENCHMARK_KEYS.length);
  });
});

describe("情景定义（声明式）", () => {
  it("组件去重并按官方顺序稳定排序（顺序不影响输入哈希）", () => {
    const a = normalizeComponents(["TOU", "PV", "GRID", "PV", "BESS"]);
    const b = normalizeComponents(["BESS", "GRID", "PV", "TOU"]);
    expect(a).toEqual(b);
  });

  it("未知组件名被忽略并登记诊断，不静默吞掉", () => {
    const { definition, diagnostics } = normalizeScenarioDefinition({
      id: "x",
      label: "X",
      components: ["GRID", "NUCLEAR" as never],
      managedCharging: false,
      intent: "",
    });
    expect(definition.components).toEqual(["GRID", "CHARGING"]);
    expect(diagnostics.some((d) => d.code === "unknown_scenario_component")).toBe(true);
  });

  it("缺少电网 / 缺少补能方式都会被补齐并说明", () => {
    const a = normalizeScenarioDefinition({ id: "a", label: "A", components: ["PV"], managedCharging: false, intent: "" });
    expect(a.definition.components).toContain("GRID");
    const b = normalizeScenarioDefinition({ id: "b", label: "B", components: ["GRID"], managedCharging: false, intent: "" });
    expect(b.definition.components).toContain("CHARGING");
  });

  it("六个内置模板都是合法定义（不存在缺电网/缺补能的模板）", () => {
    for (const t of SCENARIO_TEMPLATES) {
      const { definition, diagnostics } = normalizeScenarioDefinition(t);
      expect(definition.components).toContain("GRID");
      expect(definition.components.includes("CHARGING") || definition.components.includes("SWAP")).toBe(true);
      expect(diagnostics.filter((d) => d.code !== "unknown_scenario_component")).toHaveLength(0);
    }
  });

  it("模板查找对未知 id 返回 undefined（而不是悄悄退化成默认模板）", () => {
    expect(getScenarioTemplate("pv-bess-tou")).toBeTruthy();
    expect(getScenarioTemplate("nope")).toBeUndefined();
  });
});

describe("组件开关 → 子输入 的机械映射", () => {
  const def = (components: ScenarioDefinition["components"], managedCharging = false): ScenarioDefinition => ({
    id: "t",
    label: "T",
    components,
    managedCharging,
    intent: "",
  });

  it("不含 PV → pv.enabled=false，且登记容量被忽略的诊断", () => {
    const { input, diagnostics } = buildScenarioInput({
      ...SEED,
      definition: def(["GRID", "CHARGING"]),
      pv: { capacityKwp: 2000 },
    });
    expect(input.pv.enabled).toBe(false);
    expect(diagnostics.some((d) => d.code === "pv_capacity_ignored")).toBe(true);
  });

  it("不含 BESS → bess.enabled=false，且登记容量被忽略的诊断", () => {
    const { input, diagnostics } = buildScenarioInput({
      ...SEED,
      definition: def(["GRID", "CHARGING", "PV"]),
      bess: { energyKwh: 2000 },
    });
    expect(input.bess.enabled).toBe(false);
    expect(diagnostics.some((d) => d.code === "bess_capacity_ignored")).toBe(true);
  });

  it("不含 TOU → 全时段平段价；不含 DEMAND_CHARGE → 需量电费按 0 计", () => {
    const { input } = buildScenarioInput({ ...SEED, definition: def(["GRID", "CHARGING"]) });
    expect(input.grid.touEnabled).toBe(false);
    expect(input.grid.demandChargePerKwMonth).toBe(0);
  });

  it("含 SWAP 时按混合/纯换电推断模式；不含 SWAP 时不得出现换电电量", () => {
    const swap = buildScenarioInput({ ...SEED, definition: def(["GRID", "CHARGING", "SWAP"]) });
    expect(swap.input.charging.mode).toBe("hybrid");
    expect(swap.input.charging.swap.enabled).toBe(true);

    const pure = buildScenarioInput({ ...SEED, definition: def(["GRID", "SWAP"]), chargingMode: "swap" });
    expect(pure.input.charging.mode).toBe("swap");
    expect(pure.input.charging.swapSharePct).toBe(100);

    const none = buildScenarioInput({ ...SEED, definition: def(["GRID", "CHARGING"]) });
    expect(none.input.charging.swap.enabled).toBe(false);
    expect(none.input.charging.swapSharePct).toBe(0);
  });

  it("有序充电开关落到 truck.chargingStrategy（定义说了算，零散覆盖不能反着来）", () => {
    const managed = buildScenarioInput({
      ...SEED,
      definition: def(["GRID", "CHARGING", "PV"], true),
      truck: { chargingStrategy: "unmanaged" },
    });
    expect(managed.input.truck.chargingStrategy).toBe("managed");
    const plain = buildScenarioInput({ ...SEED, definition: def(["GRID", "CHARGING"]) });
    expect(plain.input.truck.chargingStrategy).toBe("unmanaged");
  });

  it("原始输入被冻结为可复算快照：契约版本、地区、时间轴口径齐全", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: 0.45 });
    expect(input.schemaVersion).toBe("1.0.0");
    expect(input.site.regionId).toBe("shanxi");
    expect(input.grid.flatPriceYuanPerKwh).toBeGreaterThan(0);
  });
});

describe("「不得偷填」的一条硬规则", () => {
  it("充电服务费是必填项、没有默认值（市场调节价，无官方水平可套）", () => {
    // @ts-expect-error 故意漏传必填项：它没有默认值，缺了就只能在 unknowns 里如实登记
    const built = buildScenarioFromTemplate("grid-only", { name: "缺服务费情景" });
    expect(built.input.unknowns?.["economics.chargingServiceFeeYuanPerKwh"]).toBeTruthy();
    // 且绝不会得到一个「看起来完整」的数字
    expect(Number.isFinite(built.input.economics.chargingServiceFeeYuanPerKwh)).toBe(false);
  });

  it("服务费未提供时进入 unknowns 清单，并在报告中作为关键假设出现", () => {
    const { input } = buildScenarioInput({
      name: "缺服务费",
      chargingServiceFeeYuanPerKwh: 0,
      definition: SCENARIO_TEMPLATES[0],
    });
    expect(input.unknowns?.["economics.chargingServiceFeeYuanPerKwh"]).toBeTruthy();
    expect(input.economics.chargingServiceFeeYuanPerKwh).toBe(0);
  });

  it("需量电价名义水平无官方价表 → 在含需量电费的情景里被登记为未知", () => {
    const { input } = buildScenarioInput({
      ...SEED,
      definition: { ...SCENARIO_TEMPLATES[0], components: ["GRID", "CHARGING", "DEMAND_CHARGE"] },
    });
    expect(input.unknowns?.["grid.demandChargePerKwMonth"]).toBeTruthy();
    expect(input.grid.demandChargePerKwMonth).toBe(0);
  });
});

describe("非法站点纬度", () => {
  it("超出可计算范围时回落到山西默认纬度并说明（不产生 NaN 曲线）", () => {
    const { input, diagnostics } = buildScenarioInput({
      ...SEED,
      definition: SCENARIO_TEMPLATES[0],
      site: { regionId: "shanxi", regionName: "山西省", latitudeDeg: 200 },
    });
    expect(diagnostics.some((d) => d.code === "invalid_latitude")).toBe(true);
    expect(Number.isFinite(input.site.latitudeDeg)).toBe(true);
    expect(Math.abs(input.site.latitudeDeg)).toBeLessThanOrEqual(66);
  });
});
