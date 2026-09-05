import { describe, it, expect } from "vitest";
import { resolveSandbox } from "@/server/sandbox-params";
import { runSandboxModel } from "@/server/sandbox-model";
import { computeTornado } from "@/server/sandbox-sensitivity";
import {
  SANDBOX_REGIONS,
  SANDBOX_REGIONS_VERSION,
  SANDBOX_REGION_IDS,
  DEFAULT_REGION_ID,
  regionCalcRef,
  getRegionPack,
  listRegionOptions,
  buildSandboxLayers,
} from "@/server/sandbox-regions";

/** 固定"当前时间"（在山西现行政策窗口 2024-01-01..2099-12-31 内、在过期政策窗口之外），保证确定性。 */
const NOW_ACTIVE = new Date("2026-09-05T00:00:00.000Z");
/** 回到过期政策仍在效、现行尚未生效的年代（实证 §6 双向窗口判定）。 */
const NOW_EXPIRED_ERA = new Date("2022-06-01T00:00:00.000Z");

describe("sandbox-regions — 地区/政策参数包目录（中途重构 R5，§6）", () => {
  it("常量与版本守护", () => {
    expect(SANDBOX_REGIONS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(regionCalcRef()).toBe(`regions@${SANDBOX_REGIONS_VERSION}`);
    expect(SANDBOX_REGION_IDS).toContain(DEFAULT_REGION_ID);
    // 「全国通用」恒为首个且即默认包，保证不选地区时 = R1.2 全局默认（黄金基线不变）。
    expect(SANDBOX_REGIONS[0].id).toBe(DEFAULT_REGION_ID);
    expect(SANDBOX_REGION_IDS).toEqual(SANDBOX_REGIONS.map((p) => p.id));
  });

  it("getRegionPack：命中 / 未知回落通用（绝不裸抛）", () => {
    expect(getRegionPack("shanxi").id).toBe("shanxi");
    expect(getRegionPack("national").id).toBe("national");
    // 未知 / null / undefined 一律诚实回落到默认包，不抛异常（对齐引擎「永不裸抛」范式）。
    for (const bad of ["mars", "", null, undefined]) {
      expect(getRegionPack(bad as string | null | undefined).id).toBe(DEFAULT_REGION_ID);
    }
  });

  it("listRegionOptions：精简选项与目录一一对应", () => {
    const opts = listRegionOptions();
    expect(opts).toHaveLength(SANDBOX_REGIONS.length);
    for (const o of opts) {
      expect(typeof o.id).toBe("string");
      expect(o.name.length).toBeGreaterThan(0);
      expect(o.summary.length).toBeGreaterThan(0);
    }
  });

  it("★诚实不变式（第 20 条 / §16）：任何给出覆写值的地区/政策层都是 ASSUMPTION·低置信·带待核实标注", () => {
    for (const pack of SANDBOX_REGIONS) {
      const layers = [pack.region, ...pack.policy];
      for (const layer of layers) {
        if (Object.keys(layer.values ?? {}).length === 0) continue; // 空覆写层（如通用包）无需标注
        expect(layer.evidenceKind, `${pack.id} 层缺 evidenceKind`).toBe("ASSUMPTION");
        expect(layer.confidence ?? 0).toBeLessThanOrEqual(50);
        expect(layer.source ?? "").toMatch(/示例|待核实|占位/);
      }
    }
  });

  it("buildSandboxLayers：组合 region 垫底 + policy + user 在上 + 注入 now", () => {
    const layers = buildSandboxLayers("shanxi", { "project.trucksPerDay": 80 }, NOW_ACTIVE);
    expect(layers.region?.values["region.elecPrice"]).toBe(0.55);
    expect(layers.policy).toBe(SANDBOX_REGIONS[1].policy);
    expect(layers.user?.values).toEqual({ "project.trucksPerDay": 80 });
    expect(layers.now).toEqual(NOW_ACTIVE);
    // 通用包不覆写任何地区/政策值。
    const nat = buildSandboxLayers("national");
    expect(Object.keys(nat.region?.values ?? {})).toHaveLength(0);
    expect(nat.policy).toHaveLength(0);
    // 缺省 now 取真实当前时间（避免引擎把 2024 起生效的现行政策误判为尚未生效）。
    expect(buildSandboxLayers("shanxi").now).toBeInstanceOf(Date);
  });

  it("§6 地区默认：选山西后电价/光照来自 region 层、补贴/上网价来自在效政策层", () => {
    const r = resolveSandbox(buildSandboxLayers("shanxi", {}, NOW_ACTIVE));
    expect(r.ok).toBe(true);
    const elec = r.params["region.elecPrice"];
    expect(elec.value).toBe(0.55);
    expect(elec.origin).toBe("region");
    expect(elec.overridden).toBe(true); // 相对全局默认被地区层覆写
    expect(r.params["region.pvEquivalentHours"].value).toBe(1400);
    expect(r.params["region.pvEquivalentHours"].origin).toBe("region");
    expect(r.params["policy.constructionSubsidy"].value).toBe(10);
    expect(r.params["policy.constructionSubsidy"].origin).toBe("policy");
    expect(r.params["policy.feedInTariff"].value).toBe(0.33);
    // 通用包：全部落回 R1.2 全局默认。
    const nat = resolveSandbox(buildSandboxLayers("national", {}, NOW_ACTIVE));
    expect(nat.params["region.elecPrice"].value).toBe(0.7);
    expect(nat.params["region.elecPrice"].origin).toBe("default");
    expect(nat.params["policy.constructionSubsidy"].value).toBe(5);
  });

  it("★§6 命脉：过期政策绝不作现行默认（碳价加计落回全局默认 + 留痕）", () => {
    // 现钟（2026）：山西那条"碳价加计"政策窗口已于 2023-12-31 结束 → 被跳过、碳价回落 spec 默认 80。
    const now = resolveSandbox(buildSandboxLayers("shanxi", {}, NOW_ACTIVE));
    const carbon = now.params["policy.carbonPrice"];
    expect(carbon.value).toBe(80); // 全局默认，未被过期政策污染
    expect(carbon.origin).toBe("default");
    expect(carbon.notes.join(" ")).toContain("过期");
    // 回到 2022：该政策仍在窗口内 → 生效，碳价被政策层覆写为 120（双向证明窗口判定真实生效）。
    const back = resolveSandbox(buildSandboxLayers("shanxi", {}, NOW_EXPIRED_ERA));
    expect(back.params["policy.carbonPrice"].value).toBe(120);
    expect(back.params["policy.carbonPrice"].origin).toBe("policy");
    // 同一"回到 2022"时点，2024 起生效的现行建设补贴尚未生效 → 落回默认 5（未生效≠生效）。
    expect(back.params["policy.constructionSubsidy"].value).toBe(5);
    expect(back.params["policy.constructionSubsidy"].origin).toBe("default");
  });

  it("§6 用户区间内覆写：用户覆写盖过地区默认，且被地区限幅（透传到 user 层的 bounds）裁剪", () => {
    // 用户在选择山西后仍可在地区允许区间内改电价，用户层优先，且不再越界。
    const r = resolveSandbox(buildSandboxLayers("shanxi", { "region.elecPrice": 0.4 }, NOW_ACTIVE));
    expect(r.params["region.elecPrice"].value).toBe(0.4);
    expect(r.params["region.elecPrice"].origin).toBe("user");
    expect(r.params["region.elecPrice"].clamped).toBe(false);
    // 地区限幅透传到 user 层 bounds（§6「某省对覆写限幅更严」），故用户越界会被裁到该省上下界。
    expect(buildSandboxLayers("shanxi").user?.bounds?.["region.elecPrice"]).toEqual({ min: 0.35, max: 0.9 });
    // 越上界 → 裁到 0.9；越下界 → 裁到 0.35（诚实标 clamped，不静默放过）。
    const hi = resolveSandbox(buildSandboxLayers("shanxi", { "region.elecPrice": 5 }, NOW_ACTIVE));
    expect(hi.params["region.elecPrice"].value).toBe(0.9);
    expect(hi.params["region.elecPrice"].clamped).toBe(true);
    const lo = resolveSandbox(buildSandboxLayers("shanxi", { "region.elecPrice": 0.1 }, NOW_ACTIVE));
    expect(lo.params["region.elecPrice"].value).toBe(0.35);
    expect(lo.params["region.elecPrice"].clamped).toBe(true);
  });

  it("★§4/§6 命脉：换地区→默认参数变→经济结果即时重算（非只改页面数字）", () => {
    const nat = runSandboxModel(buildSandboxLayers("national", {}, NOW_ACTIVE));
    const sx = runSandboxModel(buildSandboxLayers("shanxi", {}, NOW_ACTIVE));
    expect(nat.ok).toBe(true);
    expect(sx.ok).toBe(true);
    if (!nat.ok || !sx.ok) return;
    expect(Number.isFinite(sx.metrics.npv)).toBe(true);
    // 山西电价更低 + 光照更好 + 补贴更高 → NPV 应显著高于通用（方向性可测，不断言精确值）。
    expect(sx.metrics.npv).toBeGreaterThan(nat.metrics.npv);
    // 同一 NPV 也是页面展示的 NPV：tornado 基线锚定到当前情景（§8 单一真源，切地区图随动）。
    expect(computeTornado({ layers: buildSandboxLayers("shanxi", {}, NOW_ACTIVE) }).baseValue).toBeCloseTo(
      sx.metrics.npv,
      2,
    );
    // 不传 layers 时 tornado 仍锚定全局基线（向后兼容既有黄金样本行为）。
    expect(computeTornado({}).baseValue).toBeCloseTo(nat.metrics.npv, 2);
  });

  it("确定性：同 (地区, 覆写, now) 两次解析深相等", () => {
    const a = resolveSandbox(buildSandboxLayers("shanxi", { "project.pvCapacity": 800 }, NOW_ACTIVE));
    const b = resolveSandbox(buildSandboxLayers("shanxi", { "project.pvCapacity": 800 }, NOW_ACTIVE));
    expect(a.numeric).toEqual(b.numeric);
  });
});
