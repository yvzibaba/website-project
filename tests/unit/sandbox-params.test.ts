import { describe, it, expect } from "vitest";
import { filterByExposure } from "@app/kernel/server/parameter-engine";
import { runSandboxModel } from "@app/kernel/server/sandbox-model";
import {
  SANDBOX_PARAMS_VERSION,
  SANDBOX_PARAMS,
  SANDBOX_PARAMETER_SPECS,
  SANDBOX_DERIVED_KEYS,
  SANDBOX_DERIVED,
  resolveSandbox,
  resolveSandboxBaseline,
} from "@app/kernel/server/sandbox-params";

/**
 * 单元测试：「重卡 + 光伏 + 储能 + 充电」沙盘参数模板（R1.2）。
 *
 * 锁两类契约：
 *   ① 诚实不变式——所有默认必须是「占位假设」，绝不允许把未核实数字标成 FACT（宪法第 20 条 / §16）；
 *   ② §4 命脉在参数层成立——改上游输入 → 派生计算值必须重算（不是只改页面数字）。
 */

const SPEC_KEYS = SANDBOX_PARAMETER_SPECS.map((s) => s.key);

describe("sandbox-params · 结构与诚实不变式", () => {
  it("版本号合规", () => {
    expect(SANDBOX_PARAMS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("SANDBOX_PARAMS 已通过 ParameterSetSchema 校验（模块加载即 parse 成功）", () => {
    // 若集合有重复键 / min>max / derived 缺 dependsOn，import 时就 throw，走到这里即证合法。
    expect(SANDBOX_PARAMS.length).toBe(SANDBOX_PARAMETER_SPECS.length);
    expect(SANDBOX_PARAMS.length).toBeGreaterThan(30);
  });

  it("键全局唯一", () => {
    expect(new Set(SPEC_KEYS).size).toBe(SPEC_KEYS.length);
  });

  it("五组参数均有覆盖（region/policy/project/technology/finance）", () => {
    const groups = new Set(SANDBOX_PARAMS.map((s) => s.group));
    expect(groups).toEqual(new Set(["region", "policy", "project", "technology", "finance"]));
  });

  it("★诚实不变式：所有默认 evidenceKind 都是 ASSUMPTION、source 带【占位假设】、confidence 偏低", () => {
    for (const s of SANDBOX_PARAMS) {
      expect(s.evidenceKind, `${s.key} 须为 ASSUMPTION`).toBe("ASSUMPTION");
      expect(s.source.startsWith("【占位假设"), `${s.key} source 须标占位假设`).toBe(true);
      expect(s.confidence, `${s.key} 置信度不应虚高`).toBeLessThanOrEqual(50);
    }
  });

  it("派生参数：键集合与 spec.derived 一致、且全部只读(editable=false)带 dependsOn", () => {
    const derivedSpecs = SANDBOX_PARAMS.filter((s) => s.derived);
    expect(derivedSpecs.map((s) => s.key).sort()).toEqual([...SANDBOX_DERIVED_KEYS].sort());
    for (const s of derivedSpecs) {
      expect(s.editable).toBe(false);
      expect(s.dependsOn && s.dependsOn.length).toBeGreaterThan(0);
      expect(typeof SANDBOX_DERIVED[s.key]).toBe("function");
    }
  });

  it("每个派生 dependsOn 指向的键都真实存在于参数集（防止悬空依赖）", () => {
    const set = new Set(SPEC_KEYS);
    for (const s of SANDBOX_PARAMS.filter((x) => x.derived)) {
      for (const d of s.dependsOn ?? []) expect(set.has(d), `${s.key} 依赖缺失 ${d}`).toBe(true);
    }
  });
});

describe("resolveSandboxBaseline · 基线解析与派生真值", () => {
  const base = resolveSandboxBaseline();

  it("基线解析成功", () => {
    expect(base.ok).toBe(true);
    expect(base.issues).toEqual([]);
  });

  it("派生·日充电总量 = 车数 × 单车电量（60×250=15000）", () => {
    expect(base.numeric["derived.dailyChargeEnergy"]).toBe(15000);
    expect(base.params["derived.dailyChargeEnergy"].origin).toBe("derived");
  });

  it("派生·充电总功率 = 桩数 × 单桩功率（8×360=2880）", () => {
    expect(base.numeric["derived.chargerTotalPower"]).toBe(2880);
  });

  it("派生·储能时长 = 容量 ÷ 功率（400÷200=2）", () => {
    expect(base.numeric["derived.storageDuration"]).toBe(2);
  });

  it("numeric 快照含派生与全部数值参数、绝不含布尔开关", () => {
    expect(base.numeric["project.trucksPerDay"]).toBe(60);
    expect(base.numeric["finance.discountRate"]).toBe(8);
    expect("derived.dailyChargeEnergy" in base.numeric).toBe(true);
    expect("project.includeStorage" in base.numeric).toBe(false); // 布尔透传但不进计算快照
    expect(base.params["project.includeStorage"].value).toBe(1);
  });

  it("确定性：两次基线解析深相等", () => {
    expect(resolveSandboxBaseline()).toEqual(base);
  });
});

describe("resolveSandbox · §4 命脉：改上游参数 → 派生值重算（非只改页面数字）", () => {
  it("改桩数（8→10）→ 充电总功率重算 3600、并连带影响其它层不变", () => {
    const r = resolveSandbox({ user: { values: { "project.chargerCount": 10 } } });
    expect(r.params["project.chargerCount"].value).toBe(10);
    expect(r.params["project.chargerCount"].origin).toBe("user");
    expect(r.numeric["derived.chargerTotalPower"]).toBe(3600); // 10×360
    expect(r.numeric["derived.dailyChargeEnergy"]).toBe(15000); // 未受影响
  });

  it("改车数与单车电量 → 日充电总量重算", () => {
    const r = resolveSandbox({
      user: { values: { "project.trucksPerDay": 100, "project.chargePerTruck": 300 } },
    });
    expect(r.numeric["derived.dailyChargeEnergy"]).toBe(30000); // 100×300
  });

  it("地区层覆写电价 → origin=region、派生层照常重算", () => {
    const r = resolveSandbox({ region: { values: { "region.elecPrice": 0.95 }, source: "示例省" } });
    expect(r.params["region.elecPrice"].value).toBe(0.95);
    expect(r.params["region.elecPrice"].origin).toBe("region");
    expect(r.numeric["derived.chargerTotalPower"]).toBe(2880);
  });

  it("储能功率置 0 → 储能时长除零无定义 → 诚实回落占位默认 2 + note（绝不裸抛/绝不算成 Infinity）", () => {
    const r = resolveSandbox({ user: { values: { "project.storagePower": 0 } } });
    const p = r.params["derived.storageDuration"];
    expect(Number.isFinite(p.value as number)).toBe(true);
    expect(p.value).toBe(2); // 回落 spec.defaultValue
    expect(p.origin).not.toBe("derived");
    expect(p.notes.length).toBeGreaterThan(0);
  });

  it("派生参数不可被用户直接覆写（editable=false）→ 终值仍由注册表计算", () => {
    const r = resolveSandbox({
      user: { values: { "derived.dailyChargeEnergy": 999999 } },
    });
    // 60×250 仍算作 15000，用户试图直接改派生值被计算层覆盖。
    expect(r.numeric["derived.dailyChargeEnergy"]).toBe(15000);
  });

  it("过期政策被跳过（§6：绝不当现行默认）", () => {
    const r = resolveSandbox({
      policy: [
        {
          values: { "policy.operationSubsidy": 0.3 },
          effectiveUntil: new Date("2020-01-01"),
          source: "早已失效的补贴",
        },
      ],
      now: new Date("2026-01-01"),
    });
    const p = r.params["policy.operationSubsidy"];
    expect(p.value).toBe(0.05); // 回落 spec 默认，非 0.3
    expect(p.origin).toBe("default");
    expect(p.notes.some((n) => n.includes("过期"))).toBe(true);
  });

  it("分层曝光：basic 档只含核心滑块（不含 finance 细则）", () => {
    const basic = filterByExposure(resolveSandboxBaseline(), "basic").map((p) => p.key).sort();
    expect(basic).toContain("project.pvCapacity");
    expect(basic).toContain("region.elecPrice");
    expect(basic).not.toContain("finance.discountRate");
  });
});

/* ─────────────── V1.1 批次1.3 · 未启用（inactive）标注与全投资口径 ─────────────── */

describe("sandbox-params · V1.1 批次1.3：inactive 未启用标注（方案 §3.1d）", () => {
  /** 本批次钉死的未启用键全集——增减须显式改这里（防僵尸键悄悄回潮，也防误伤活参数）。 */
  const INACTIVE_SET = [
    "project.gridCapacity",
    "region.landRent",
    "policy.carbonPrice",
    "finance.equityRatio",
    "finance.loanRate",
    "project.chargerUtilization",
  ].sort();

  it("未启用键集合 = 恰这 6 个（多标/漏标都红）", () => {
    const keys = SANDBOX_PARAMS.filter((s) => s.inactive).map((s) => s.key).sort();
    expect(keys).toEqual(INACTIVE_SET);
  });

  it("每个未启用键都带用户可读的中文原因（诚实：收起必须解释为什么）", () => {
    for (const s of SANDBOX_PARAMS.filter((x) => x.inactive)) {
      expect(typeof s.inactiveReason, `${s.key} 须有 inactiveReason`).toBe("string");
      expect((s.inactiveReason ?? "").length, `${s.key} 原因不能为空`).toBeGreaterThan(4);
    }
  });

  it("includeStorage **不标** inactive（批次 1.4 已真接线转正·MODEL 1.4.0 真杠杆，永远是活参数）", () => {
    const spec = SANDBOX_PARAMS.find((s) => s.key === "project.includeStorage");
    expect(spec).toBeDefined();
    expect(spec!.inactive ?? false).toBe(false);
  });

  it("活参数绝不被误标：已被内核消费的键全部在用", () => {
    const LIVE = [
      "region.demandCharge", // E4 需量费价格闸门（1.2.0 起被消费）
      "project.demandKc", // E4 计费需量基准（1.3.0 起被消费）
      "policy.operationSubsidy", // 收入侧运营补贴
      "policy.feedInTariff", // 余电上网收入
      "policy.constructionSubsidy", // CAPEX 补贴
      "region.peakValleySpread", // SVE 储能价值
      "tech.pvOm", // OPEX
      "tech.storageOm", // OPEX
      "finance.discountRate", // NPV 折现
      "finance.taxRate", // 税后现金流
    ];
    for (const k of LIVE) {
      const s = SANDBOX_PARAMS.find((x) => x.key === k);
      expect(s, `键 ${k} 应存在`).toBeDefined();
      expect(s!.inactive ?? false, `活参数 ${k} 不得被标 inactive`).toBe(false);
    }
  });

  it("反向错配修正：region.demandCharge / project.demandKc exposure 升 advanced（B/C 对照组工作台可切）", () => {
    expect(SANDBOX_PARAMS.find((s) => s.key === "region.demandCharge")!.exposure).toBe("advanced");
    expect(SANDBOX_PARAMS.find((s) => s.key === "project.demandKc")!.exposure).toBe("advanced");
  });

  it("★行为反证：覆写任一 inactive 键 → NPV 逐字节不变（「未启用」= 对经济输出零影响，名副其实）", () => {
    const base = runSandboxModel({});
    expect(base.ok).toBe(true);
    if (!base.ok) return; // 上一行已红，这里只为 TS 收窄
    const probes: Record<string, number> = {
      "project.gridCapacity": 5000,
      "region.landRent": 2000,
      "policy.carbonPrice": 300,
      "finance.equityRatio": 60,
      "finance.loanRate": 9,
      "project.chargerUtilization": 80,
    };
    for (const [key, probe] of Object.entries(probes)) {
      const r = runSandboxModel({ user: { values: { [key]: probe } } });
      expect(r.ok, `${key} 覆写后仍应算得通`).toBe(true);
      if (r.ok) expect(r.metrics.npv, `inactive 键 ${key} 不应改变 NPV`).toBe(base.metrics.npv);
    }
  });
});
