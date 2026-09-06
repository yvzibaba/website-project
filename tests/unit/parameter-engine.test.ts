import { describe, it, expect } from "vitest";
import {
  PARAM_ENGINE_VERSION,
  PARAM_GROUPS,
  EXPOSURE_TIERS,
  VALUE_ORIGINS,
  ParameterSpecSchema,
  ParameterSetSchema,
  ResolvedParameterSchema,
  resolveParameters,
  getValue,
  filterByExposure,
  collectNotes,
  collectInputProvenance,
  factInputs,
  type ParameterSpec,
  type ResolveLayers,
  type ValueSourceMeta,
} from "@/server/parameter-engine";

/**
 * 单元测试：参数引擎内核（重构 R1.1 · 纯函数 · 黄金样本）。
 *
 * 为什么锁黄金样本（§4 命脉 / §7 程序计算 / §16 事实与假设）：参数解析是整座决策沙盘的地基——
 *   "改参数→重算→全链路变"的可靠与否，全看这里的分层覆盖 / 裁剪 / 政策过期 / 派生求值是否**逐条可复算**。
 *   任何改优先级/裁剪/过期语义都须显式改这里的期望值并升 PARAM_ENGINE_VERSION，防无声回归。
 */

/** 造一个合法 numeric 参数定义（可覆写字段）。 */
function spec(over: Partial<ParameterSpec> & { key: string }): ParameterSpec {
  return {
    label: over.key,
    kind: "numeric",
    group: "project",
    exposure: "basic",
    defaultValue: 100,
    editable: true,
    source: "全局默认",
    confidence: 50,
    evidenceKind: "ASSUMPTION",
    derived: false,
    ...over,
  } as ParameterSpec;
}

describe("常量与契约守护", () => {
  it("PARAM_ENGINE_VERSION 是语义化版本串", () => {
    expect(PARAM_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("分组恰 5 个、暴露层级恰 3 个、来源恰 5 个（改这些=破坏性契约）", () => {
    expect(PARAM_GROUPS).toEqual(["region", "policy", "project", "technology", "finance"]);
    expect(EXPOSURE_TIERS).toEqual(["basic", "advanced", "pro"]);
    expect(VALUE_ORIGINS).toEqual(["default", "region", "policy", "user", "derived"]);
  });
  it("spec 缺省即最保守可编辑默认（editable=true / confidence=50 / evidenceKind=ASSUMPTION / derived=false）", () => {
    const p = ParameterSpecSchema.parse({
      key: "a",
      label: "甲",
      kind: "numeric",
      group: "project",
      exposure: "basic",
      defaultValue: 1,
    });
    expect(p.editable).toBe(true);
    expect(p.confidence).toBe(50);
    expect(p.evidenceKind).toBe("ASSUMPTION");
    expect(p.derived).toBe(false);
  });
});

describe("ParameterSetSchema 校验", () => {
  it("拒绝重复参数键", () => {
    const r = ParameterSetSchema.safeParse([spec({ key: "dup" }), spec({ key: "dup" })]);
    expect(r.success).toBe(false);
  });
  it("拒绝 min > max", () => {
    const r = ParameterSpecSchema.safeParse(
      spec({ key: "k", min: 10, max: 5 }),
    );
    expect(r.success).toBe(false);
  });
  it("派生参数必须声明 dependsOn", () => {
    const r = ParameterSpecSchema.safeParse(spec({ key: "d", derived: true }));
    expect(r.success).toBe(false);
    const ok = ParameterSpecSchema.safeParse(
      spec({ key: "d", derived: true, dependsOn: ["x"] }),
    );
    expect(ok.success).toBe(true);
  });
  it("confidence 越界（>100）被拒", () => {
    const r = ParameterSpecSchema.safeParse(spec({ key: "c", confidence: 101 }));
    expect(r.success).toBe(false);
  });
});

describe("resolveParameters · 非法输入不产出脏值", () => {
  it("spec 集不合法 → ok:false + issues + params 空", () => {
    const r = resolveParameters([{ key: "x" }]); // 缺大量必填
    expect(r.ok).toBe(false);
    expect(r.engineVersion).toBe(PARAM_ENGINE_VERSION);
    expect(r.params).toEqual({});
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("resolveParameters · 单层默认", () => {
  it("无任何覆写层 → 全部 origin=default、overridden=false、confidence 取 spec", () => {
    const r = resolveParameters([spec({ key: "pv.capacity", defaultValue: 1000, confidence: 40 })]);
    expect(r.ok).toBe(true);
    const p = r.params["pv.capacity"];
    expect(p.value).toBe(1000);
    expect(p.origin).toBe("default");
    expect(p.overridden).toBe(false);
    expect(p.clamped).toBe(false);
    expect(p.confidence).toBe(40);
    expect(p.evidenceKind).toBe("ASSUMPTION");
  });
  it("numeric 快照含数值参数、不含布尔/选择", () => {
    const r = resolveParameters([
      spec({ key: "n", defaultValue: 5 }),
      spec({ key: "b", kind: "boolean", defaultValue: 1 }),
      spec({ key: "s", kind: "select", defaultValue: 1 }),
    ]);
    expect(r.numeric["n"]).toBe(5);
    expect("b" in r.numeric).toBe(false);
    expect("s" in r.numeric).toBe(false);
  });
});

describe("resolveParameters · 分层优先级（user > policy > region > default）", () => {
  const specs = [spec({ key: "price", defaultValue: 1 })];
  it("region 覆盖 default", () => {
    const r = resolveParameters(specs, { region: { values: { price: 2 }, source: "山西", confidence: 60, evidenceKind: "FACT" } });
    expect(r.params["price"].value).toBe(2);
    expect(r.params["price"].origin).toBe("region");
    expect(r.params["price"].source).toBe("山西");
    expect(r.params["price"].confidence).toBe(60);
    expect(r.params["price"].evidenceKind).toBe("FACT");
  });
  it("policy 覆盖 region、user 覆盖 policy", () => {
    const layers: ResolveLayers = {
      region: { values: { price: 2 } },
      policy: [{ values: { price: 3 }, source: "补贴办法" }],
      user: { values: { price: 4 } },
    };
    const r = resolveParameters(specs, layers);
    expect(r.params["price"].value).toBe(4);
    expect(r.params["price"].origin).toBe("user");
  });
  it("多层 policy 后者覆盖前者", () => {
    const r = resolveParameters(specs, {
      policy: [{ values: { price: 3 } }, { values: { price: 5 } }],
    });
    expect(r.params["price"].value).toBe(5);
    expect(r.params["price"].origin).toBe("policy");
  });
});

describe("resolveParameters · 允许区间裁剪（§6）", () => {
  const specs = [spec({ key: "ratio", defaultValue: 0.5, min: 0, max: 1 })];
  it("用户覆写超上界 → 裁剪到 max + clamped + note", () => {
    const r = resolveParameters(specs, { user: { values: { ratio: 2 } } });
    expect(r.params["ratio"].value).toBe(1);
    expect(r.params["ratio"].clamped).toBe(true);
    expect(collectNotes(r).some((n) => n.includes("裁剪"))).toBe(true);
    expect(r.params["ratio"].origin).toBe("user");
  });
  it("用户覆写低于下界 → 裁剪到 min", () => {
    const r = resolveParameters(specs, { user: { values: { ratio: -3 } } });
    expect(r.params["ratio"].value).toBe(0);
    expect(r.params["ratio"].clamped).toBe(true);
  });
  it("层内 bounds 与 spec 取交集（更严者胜）", () => {
    const s = [spec({ key: "t", defaultValue: 10, min: 0, max: 100 })];
    const r = resolveParameters(s, { region: { values: { t: 999 }, bounds: { t: { max: 50 } } } });
    expect(r.params["t"].value).toBe(50);
    expect(r.params["t"].clamped).toBe(true);
  });
});

describe("resolveParameters · 不可编辑参数", () => {
  it("用户尝试覆写 editable=false → 忽略并留痕，origin 不被 user 抢", () => {
    const s = [spec({ key: "locked", defaultValue: 7, editable: false })];
    const r = resolveParameters(s, { user: { values: { locked: 999 } } });
    expect(r.params["locked"].value).toBe(7);
    expect(r.params["locked"].origin).toBe("default");
    expect(collectNotes(r).some((n) => n.includes("不可编辑"))).toBe(true);
  });
});

describe("resolveParameters · 政策过期不得当现行默认（§6 硬约束）", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const specs = [spec({ key: "feedIn", defaultValue: 0.3 })];
  it("过期政策被跳过 + note，回落 region", () => {
    const r = resolveParameters(
      specs,
      {
        region: { values: { feedIn: 0.35 }, source: "国网山西" },
        policy: [{ values: { feedIn: 0.5 }, source: "2023旧政", effectiveUntil: new Date("2024-12-31T00:00:00Z") }],
        now,
      },
    );
    expect(r.params["feedIn"].value).toBe(0.35);
    expect(r.params["feedIn"].origin).toBe("region");
    expect(collectNotes(r).some((n) => n.includes("已过期"))).toBe(true);
  });
  it("未生效政策（effectiveFrom 在未来）被跳过", () => {
    const r = resolveParameters(
      specs,
      { policy: [{ values: { feedIn: 0.9 }, effectiveFrom: new Date("2027-01-01T00:00:00Z") }], now },
    );
    expect(r.params["feedIn"].value).toBe(0.3);
    expect(r.params["feedIn"].origin).toBe("default");
  });
  it("在效政策正常生效", () => {
    const r = resolveParameters(
      specs,
      {
        policy: [
          {
            values: { feedIn: 0.42 },
            source: "2026新政",
            effectiveFrom: new Date("2026-01-01T00:00:00Z"),
            effectiveUntil: new Date("2026-12-31T00:00:00Z"),
          },
        ],
        now,
      },
    );
    expect(r.params["feedIn"].value).toBe(0.42);
    expect(r.params["feedIn"].origin).toBe("policy");
  });
});

describe("resolveParameters · 派生计算值（§5 计算值）", () => {
  const specs = [
    spec({ key: "cap", defaultValue: 1000 }),
    spec({ key: "unit", defaultValue: 3500 }),
    spec({ key: "capex", defaultValue: 0, derived: true, dependsOn: ["cap", "unit"] }),
  ];
  const derived = { capex: (r: Record<string, number>) => r.cap * r.unit };
  it("派生值在所有基础参数解析后求值、origin=derived", () => {
    const r = resolveParameters(specs, { derived });
    expect(r.params["capex"].value).toBe(3_500_000);
    expect(r.params["capex"].origin).toBe("derived");
    expect(r.numeric["capex"]).toBe(3_500_000);
  });
  it("改上游参数 → 派生值随之重算（证'改参数→下游变'机制成立）", () => {
    const r = resolveParameters(specs, { derived, user: { values: { cap: 2000 } } });
    expect(r.params["cap"].value).toBe(2000);
    expect(r.params["capex"].value).toBe(7_000_000);
  });
  it("派生缺依赖 → 诚实不假装、留痕、保留占位默认", () => {
    const s = [
      spec({ key: "x", defaultValue: 5 }),
      spec({ key: "y", defaultValue: 0, derived: true, dependsOn: ["nope"] }),
    ];
    const r = resolveParameters(s, { derived: { y: (res) => (res.nope ?? 0) * 2 } });
    expect(r.params["y"].origin).not.toBe("derived");
    expect(r.params["y"].value).toBe(0);
    expect(collectNotes(r).some((n) => n.includes("派生未完成") || n.includes("缺依赖"))).toBe(true);
  });
  it("派生返回非有限值 → 回落默认并留痕", () => {
    const s = [
      spec({ key: "base", defaultValue: 2 }),
      spec({ key: "bad", defaultValue: 42, derived: true, dependsOn: ["base"] }),
    ];
    const r = resolveParameters(s, { derived: { bad: () => Number.NaN } });
    expect(r.params["bad"].value).toBe(42);
    expect(r.params["bad"].origin).not.toBe("derived");
  });
  it("声明派生但注册表无函数 → 保留默认 + note", () => {
    const s = [spec({ key: "d", defaultValue: 9, derived: true, dependsOn: ["z"] })];
    const r = resolveParameters(s, {});
    expect(r.params["d"].value).toBe(9);
    expect(collectNotes(r).some((n) => n.includes("缺计算函数"))).toBe(true);
  });
});

describe("helpers & determinism", () => {
  const layers: ResolveLayers = {
    region: { values: { price: 2 } },
    derived: { total: (r) => r.price * 3 },
  };
  const specs = [
    spec({ key: "price", defaultValue: 1 }),
    spec({ key: "total", defaultValue: 0, derived: true, dependsOn: ["price"] }),
    spec({ key: "flag", defaultValue: 1, exposure: "pro" }),
  ];
  it("确定性：同输入两次深相等", () => {
    const a = resolveParameters(specs, layers);
    const b = resolveParameters(specs, layers);
    expect(a).toEqual(b);
  });
  it("getValue 取解析值", () => {
    const r = resolveParameters(specs, layers);
    expect(getValue(r, "price")).toBe(2);
    expect(getValue(r, "missing")).toBeUndefined();
  });
  it("filterByExposure 按层级筛选", () => {
    const r = resolveParameters(specs, layers);
    const pro = filterByExposure(r, "pro");
    expect(pro.map((p) => p.key)).toEqual(["flag"]);
  });
  it("ResolvedParameterSchema 校验解析产物（防结构漂移）", () => {
    const r = resolveParameters(specs, layers);
    expect(ResolvedParameterSchema.safeParse(r.params["price"]).success).toBe(true);
    expect(ResolvedParameterSchema.safeParse(r.params["total"]).success).toBe(true);
  });
});

/* ─────────────────────────── R8.7：逐值结构化溯源 + 诚实闸门 ─────────────────────────── */

describe("resolveParameters · R8.7 逐值溯源（ValueLayer.sources）", () => {
  const priceSpecs = [spec({ key: "region.elecPrice", group: "region", defaultValue: 0.7 })];

  it("★FACT + 合法 http(s) 链接 → sourceUrl/sourceType/asOf 落地 + 逐值 evidenceKind/confidence 覆盖层级", () => {
    const sources: Record<string, ValueSourceMeta> = {
      "region.elecPrice": {
        sourceUrl: "https://example.gov.cn/price",
        sourceType: "政府公告",
        asOf: "2024-06",
        evidenceKind: "FACT",
        confidence: 92,
      },
    };
    const r = resolveParameters(priceSpecs, {
      region: { values: { "region.elecPrice": 0.55 }, source: "山西", confidence: 45, evidenceKind: "ASSUMPTION", sources },
    });
    const p = r.params["region.elecPrice"];
    expect(p.origin).toBe("region");
    expect(p.sourceUrl).toBe("https://example.gov.cn/price");
    expect(p.sourceType).toBe("政府公告");
    expect(p.asOf).toBe("2024-06");
    expect(p.evidenceKind).toBe("FACT"); // 逐值 FACT 覆盖层级 ASSUMPTION
    expect(p.confidence).toBe(92); // 逐值置信覆盖层级 45
    expect(p.notes.join(" ")).not.toMatch(/降级/);
  });

  it("★诚实闸门：逐值声称 FACT 却无可核验链接 → 降为 ASSUMPTION 并留痕、不落 sourceUrl", () => {
    const sources: Record<string, ValueSourceMeta> = {
      "region.elecPrice": { evidenceKind: "FACT", confidence: 90 }, // 无 sourceUrl
    };
    const r = resolveParameters(priceSpecs, { region: { values: { "region.elecPrice": 0.55 }, sources } });
    const p = r.params["region.elecPrice"];
    expect(p.evidenceKind).toBe("ASSUMPTION");
    expect(p.sourceUrl).toBeUndefined();
    expect(p.notes.join(" ")).toContain("降级");
  });

  it("脏链接（ftp / 含空格）不作可核验来源：不记 sourceUrl，若据此称 FACT 则降级", () => {
    const r = resolveParameters(priceSpecs, {
      region: {
        values: { "region.elecPrice": 0.55 },
        sources: { "region.elecPrice": { sourceUrl: "ftp://x/y", evidenceKind: "FACT" } },
      },
    });
    const p = r.params["region.elecPrice"];
    expect(p.sourceUrl).toBeUndefined();
    expect(p.evidenceKind).toBe("ASSUMPTION");
    expect(p.notes.join(" ")).toMatch(/非 http\(s\)|降级/);
  });

  it("逐值给链接但不声明 FACT → 仍记 sourceUrl，evidenceKind 沿用层级（ASSUMPTION）不擅自升格", () => {
    const r = resolveParameters(priceSpecs, {
      region: {
        values: { "region.elecPrice": 0.55 },
        evidenceKind: "ASSUMPTION",
        sources: { "region.elecPrice": { sourceUrl: "https://a.gov/x", sourceType: "统计" } },
      },
    });
    const p = r.params["region.elecPrice"];
    expect(p.sourceUrl).toBe("https://a.gov/x");
    expect(p.evidenceKind).toBe("ASSUMPTION");
  });

  it("未命中层（被 user 覆写）的 sources 不外泄——sourceUrl 只随最终命中层", () => {
    const r = resolveParameters(priceSpecs, {
      region: {
        values: { "region.elecPrice": 0.55 },
        sources: { "region.elecPrice": { sourceUrl: "https://region.only", evidenceKind: "FACT" } },
      },
      user: { values: { "region.elecPrice": 0.6 } }, // user 覆写、无 sources
    });
    const p = r.params["region.elecPrice"];
    expect(p.origin).toBe("user");
    expect(p.sourceUrl).toBeUndefined(); // 地区层的 FACT 链接不残留
    expect(p.evidenceKind).toBe("ASSUMPTION"); // spec 默认（user 层未带 FACT）
  });

  it("collectInputProvenance 展平（仅在有链接时带 sourceUrl）；factInputs 只留 FACT+链接", () => {
    const r = resolveParameters(priceSpecs, {
      region: {
        values: { "region.elecPrice": 0.55 },
        sources: { "region.elecPrice": { sourceUrl: "https://a.gov/x", evidenceKind: "FACT", confidence: 88 } },
      },
    });
    const prov = collectInputProvenance(r);
    expect(prov["region.elecPrice"].sourceUrl).toBe("https://a.gov/x");
    expect(prov["region.elecPrice"].evidenceKind).toBe("FACT");
    expect(prov["region.elecPrice"].value).toBe(0.55);
    expect(factInputs(prov).map((f) => f.key)).toEqual(["region.elecPrice"]);

    // 无逐值来源：collect 仍产出但无 sourceUrl，factInputs 为空。
    const plain = resolveParameters(priceSpecs);
    const pp = collectInputProvenance(plain);
    expect(pp["region.elecPrice"].sourceUrl).toBeUndefined();
    expect(factInputs(pp)).toHaveLength(0);
  });

  it("非法解析（ok:false）→ collectInputProvenance 回空表（诚实「无从汇总」、不抛）", () => {
    const bad = resolveParameters([{ nope: 1 }], {});
    expect(bad.ok).toBe(false);
    expect(collectInputProvenance(bad)).toEqual({});
  });

  it("ResolvedParameterSchema 仍校验带 sourceUrl 的解析产物", () => {
    const r = resolveParameters(priceSpecs, {
      region: {
        values: { "region.elecPrice": 0.55 },
        sources: { "region.elecPrice": { sourceUrl: "https://a.gov/x", evidenceKind: "FACT" } },
      },
    });
    expect(ResolvedParameterSchema.safeParse(r.params["region.elecPrice"]).success).toBe(true);
  });
});
