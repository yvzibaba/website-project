/**
 * 沙盘「企业画像」目录黄金样本（中途重构 R7 · §14 第 7 项「企业个性化」）。
 *
 * 关键锁定：画像是**版本化纯代码目录 + 纯函数接缝**（无 DB / 无网络 / 无时钟），
 *  ① 目录自洽（validateProfileCatalog 无问题、默认=通用且为首、预设键全部命中已注册参数、诚实标签齐备）；
 *  ② 未知/空 id 诚实回落通用（绝不裸抛）；
 *  ③ ★通用画像 → 分层与 R5 `buildSandboxLayers` 逐字等价（不选画像时 R6 黄金基线绝不受影响）；
 *  ④ 优先级链 `default < region/policy < 画像预设 < 用户本次改动`（裁剪而非锁死）+ 地区限幅仍透传；
 *  ⑤ §4 命脉：换画像 → 引擎重算 → NPV 随之变化（个性化真进经济链，不止改标签）；
 *  ⑥ 诚实不变式：任何画像预设恒 ASSUMPTION·confidence≤50·来源带待核实前缀；
 *  ⑦ `isProfileDefault` 供 UI 精确区分「画像默认」与「已改」。
 */
import { describe, it, expect } from "vitest";
import { resolveSandbox } from "@/server/sandbox-params";
import { runSandboxModel } from "@/server/sandbox-model";
import { buildSandboxLayers } from "@/server/sandbox-regions";
import { SANDBOX_PARAMS } from "@/server/sandbox-params";
import {
  SANDBOX_PROFILES,
  SANDBOX_PROFILES_VERSION,
  SANDBOX_PROFILE_IDS,
  DEFAULT_PROFILE_ID,
  PROFILE_METRIC_KEYS,
  profileCalcRef,
  getEnterpriseProfile,
  listProfileOptions,
  buildProfileLayers,
  isProfileDefault,
  validateProfileCatalog,
} from "@/server/sandbox-profiles";

const NOW = new Date("2026-09-06T00:00:00.000Z");
const SPEC = new Map(SANDBOX_PARAMS.map((s) => [s.key, s] as const));

describe("sandbox-profiles — 企业画像目录（R7 · §14 第 7 项）", () => {
  it("常量与版本守护", () => {
    expect(SANDBOX_PROFILES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(profileCalcRef()).toBe(`profiles@${SANDBOX_PROFILES_VERSION}`);
    expect(SANDBOX_PROFILE_IDS).toContain(DEFAULT_PROFILE_ID);
    // 通用画像恒为首个 = 默认，保证不选画像时逐字回落到既有黄金基线。
    expect(SANDBOX_PROFILES[0].id).toBe(DEFAULT_PROFILE_ID);
    expect(SANDBOX_PROFILE_IDS).toEqual(SANDBOX_PROFILES.map((p) => p.id));
  });

  it("★目录自洽：validateProfileCatalog() 无任何问题（键注册 / 置信 / 诚实标签 / 侧重合法）", () => {
    expect(validateProfileCatalog()).toEqual([]);
  });

  it("getEnterpriseProfile：命中 / 未知回落通用（绝不裸抛）", () => {
    for (const id of SANDBOX_PROFILE_IDS) {
      expect(getEnterpriseProfile(id).id).toBe(id);
    }
    for (const bad of ["mars", "", null, undefined]) {
      expect(getEnterpriseProfile(bad as string | null | undefined).id).toBe(DEFAULT_PROFILE_ID);
    }
  });

  it("listProfileOptions：精简选项与目录一一对应，字段齐备", () => {
    const opts = listProfileOptions();
    expect(opts).toHaveLength(SANDBOX_PROFILES.length);
    for (const o of opts) {
      expect(typeof o.id).toBe("string");
      expect(o.name.length).toBeGreaterThan(0);
      expect(o.summary.length).toBeGreaterThan(0);
      expect(o.headline.length).toBeGreaterThan(0);
    }
  });

  it("★诚实不变式（第 20 条 / §16）：任何有预设值的画像都标 ASSUMPTION·低置信·带待核实标注", () => {
    for (const p of SANDBOX_PROFILES) {
      if (Object.keys(p.presetValues).length === 0) continue; // 通用画像无预设，无需标注
      expect(p.evidenceKind, `${p.id} 缺 evidenceKind`).toBe("ASSUMPTION");
      expect(p.confidence).toBeLessThanOrEqual(50);
      expect(p.source).toMatch(/示例|待核实|占位/);
    }
  });

  it("预设键全部命中已注册参数且落在其 [min,max] 内（不与单一真源漂移、不会被静默裁剪）", () => {
    for (const p of SANDBOX_PROFILES) {
      for (const [key, val] of Object.entries(p.presetValues)) {
        const spec = SPEC.get(key);
        expect(spec, `画像 ${p.id} 预设键 ${key} 未注册`).toBeTruthy();
        if (!spec) continue;
        if (spec.min != null && typeof val === "number") expect(val, `${p.id}.${key} 越下界`).toBeGreaterThanOrEqual(spec.min);
        if (spec.max != null && typeof val === "number") expect(val, `${p.id}.${key} 越上界`).toBeLessThanOrEqual(spec.max);
      }
    }
  });

  it("emphasis 的指标 key 均落在已知指标卡集合内", () => {
    for (const p of SANDBOX_PROFILES) {
      for (const k of p.emphasis.metricKeys) {
        expect((PROFILE_METRIC_KEYS as readonly string[]).includes(k)).toBe(true);
      }
    }
  });

  it("★通用画像 → 分层与 R5 buildSandboxLayers 逐字等价（不选画像=黄金基线不受影响）", () => {
    const a = buildProfileLayers(DEFAULT_PROFILE_ID, "shanxi", { "project.pvCapacity": 999 }, NOW);
    const b = buildSandboxLayers("shanxi", { "project.pvCapacity": 999 }, NOW);
    expect(a).toEqual(b);
    // 无用户改动时同样等价。
    expect(buildProfileLayers(DEFAULT_PROFILE_ID, "national", {}, NOW)).toEqual(buildSandboxLayers("national", {}, NOW));
  });

  it("§14#7 优先级：画像预设盖过全局默认（origin=user），用户本次改动又盖过画像预设", () => {
    // fleet 预设 trucksPerDay=150 → 盖过 spec 默认 60，来源记为 user（引擎无 enterprise 层，故归 user）。
    const onlyProfile = resolveSandbox(buildProfileLayers("fleet", "national", {}, NOW));
    expect(onlyProfile.ok).toBe(true);
    expect(onlyProfile.params["project.trucksPerDay"].value).toBe(150);
    expect(onlyProfile.params["project.trucksPerDay"].origin).toBe("user");
    // 用户显式把车数改到 300 → 盖过画像预设 150（裁剪而非锁死）。
    const userWins = resolveSandbox(buildProfileLayers("fleet", "national", { "project.trucksPerDay": 300 }, NOW));
    expect(userWins.params["project.trucksPerDay"].value).toBe(300);
    // 未覆写的画像键（chargingPrice）仍取画像预设。
    expect(userWins.params["project.chargingPrice"].value).toBe(0.75);
    // 画像未预设、地区也未设的键 → 落回全局默认（画像不越权填满一切）。
    expect(userWins.params["region.elecPrice"].value).toBe(0.7);
    expect(userWins.params["region.elecPrice"].origin).toBe("default");
  });

  it("§6 地区限幅仍透传到 user 层：选山西后越界电价被裁到该省上下界（画像路径不破坏地区收窄）", () => {
    const hi = resolveSandbox(buildProfileLayers("fleet", "shanxi", { "region.elecPrice": 5 }, NOW));
    expect(hi.params["region.elecPrice"].value).toBe(0.9);
    expect(hi.params["region.elecPrice"].clamped).toBe(true);
    expect(buildProfileLayers("fleet", "shanxi", {}, NOW).user?.bounds?.["region.elecPrice"]).toEqual({
      min: 0.35,
      max: 0.9,
    });
  });

  it("★§4 命脉：换画像 → 引擎重算 → NPV 真变（个性化进经济链，非只改页面文字）", () => {
    const base = runSandboxModel(buildProfileLayers(DEFAULT_PROFILE_ID, "national", {}, NOW));
    const investor = runSandboxModel(buildProfileLayers("investor", "national", {}, NOW));
    const operator = runSandboxModel(buildProfileLayers("operator", "national", {}, NOW));
    expect(base.ok && investor.ok && operator.ok).toBe(true);
    if (!base.ok || !investor.ok || !operator.ok) return;
    expect(Number.isFinite(investor.metrics.npv)).toBe(true);
    // 投资人（高折现率/短周期）与运营商（高利用率/服务费定价）画像下的 NPV 必与通用不同——方向不硬编码，只证联动。
    expect(investor.metrics.npv).not.toBe(base.metrics.npv);
    expect(operator.metrics.npv).not.toBe(base.metrics.npv);
  });

  it("确定性：同 (画像, 地区, 覆写, now) 两次解析深相等", () => {
    const a = resolveSandbox(buildProfileLayers("park", "shanxi", { "project.chargerCount": 9 }, NOW));
    const b = resolveSandbox(buildProfileLayers("park", "shanxi", { "project.chargerCount": 9 }, NOW));
    expect(a.numeric).toEqual(b.numeric);
  });

  it("isProfileDefault：画像预设且未改=真；被用户改 / 非预设键 / 通用画像=假", () => {
    expect(isProfileDefault("fleet", "project.trucksPerDay", {})).toBe(true);
    expect(isProfileDefault("fleet", "project.trucksPerDay", { "project.trucksPerDay": 999 })).toBe(false);
    expect(isProfileDefault("fleet", "region.elecPrice", {})).toBe(false); // fleet 未预设电价
    expect(isProfileDefault(DEFAULT_PROFILE_ID, "project.trucksPerDay", {})).toBe(false); // 通用无预设
  });
});
