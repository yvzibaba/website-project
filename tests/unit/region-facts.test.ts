/**
 * 单元测试：R8.7「地区 / 政策逐值来源编目」`region-facts`（纯函数 · 诚实基线 · 升级接缝）。
 *
 * 锁定（§16 单一真源 / §20 诚实绝不虚构来源）：
 *   - 山西地区/政策逐值来源除**唯一「条款字面直传」例外 `region.demandCharge`=0（批次1.2）**外，
 *     全为诚实 ASSUMPTION、不带 sourceUrl（未逐条核实到可点击权威原文，绝不伪FACT；例外被钉死为恰一条一键）；
 *   - 编目键须与 `regions.ts` 里山西包实际覆写的 `values` 键**一一对齐**（防目录漂移，值与来源不双写）；
 *   - `makeVerifiedFact` 是升级 FACT 的唯一入口：只有合法 http(s) 链接才产出 FACT，脏输入一律 null（宁可误拒）；
 *   - `getRegionProvenance` 对未知 id 回落通用、绝不裸抛。
 */
import { describe, it, expect } from "vitest";
import {
  REGION_FACTS_VERSION,
  regionFactsCalcRef,
  makeVerifiedFact,
  getRegionProvenance,
  getRegionClauseFacts,
  SHANXI_CLAUSE_FACTS,
  SHANXI_REGION_SOURCES,
  SHANXI_POLICY_SOURCES,
  NATIONAL_REGION_SOURCES,
} from "@app/kernel/server/region-facts";
import { getRegionPack } from "@app/kernel/server/regions";
import { PROJECT_PARAMS } from "@app/kernel/server/project-params";

const knownKeys = new Set(PROJECT_PARAMS.map((s) => s.key));
const USABLE_HTTP_URL = /^https?:\/\/\S+$/;

describe("region-facts · 版本与契约", () => {
  it("版本语义化 + calcRef 溯源串", () => {
    expect(REGION_FACTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(regionFactsCalcRef()).toBe(`region-facts@${REGION_FACTS_VERSION}`);
  });
});

describe("region-facts · §20 诚实基线（除唯一字面直传例外，全为待核实 ASSUMPTION）", () => {
  /**
   * V1.1 批次1.2 引入**唯一显式例外**：`region.demandCharge` 的 0 是「免收需量(容量)电费」条款的
   * **字面直传结果值**（免收 ⇒ 0 元/kW·月），无任何价表折算介入，故可挂 FACT；
   * 「条款≠数值」护栏对其余一切键（尤其 90% 折扣那类需官方价表才能落绝对值的条款）仍然绝对成立。
   * 本测试把例外**钉死到恰这一条、这一键**——多一条 FACT 混进来都会当场炸。
   */
  const EXCEPTION_KEY = "region.demandCharge";

  it("★例外恰一条：region.demandCharge = FACT + 可点击原文 + 字面直传注记；山西其余逐值来源全为 ASSUMPTION", () => {
    const factEntries = Object.entries(SHANXI_REGION_SOURCES).filter(([, m]) => m.evidenceKind === "FACT");
    expect(factEntries).toHaveLength(1); // 全目录唯一 FACT，钉死数量
    expect(factEntries[0][0]).toBe(EXCEPTION_KEY);
    const m = factEntries[0][1];
    expect(USABLE_HTTP_URL.test(m.sourceUrl ?? "")).toBe(true);
    expect(m.note ?? "").toMatch(/字面直传/); // 必须自证"非价表折算"，防例外被悄悄泛化
    expect(m.confidence ?? 0).toBeLessThanOrEqual(90);

    const others = [
      ...Object.entries(SHANXI_REGION_SOURCES).filter(([k]) => k !== EXCEPTION_KEY),
      ...SHANXI_POLICY_SOURCES.flatMap((mm) => (mm ? Object.entries(mm) : [])),
    ].map(([, x]) => x);
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) {
      expect(o.evidenceKind).toBe("ASSUMPTION");
      expect(o.sourceUrl).toBeUndefined();
      expect(o.note ?? "").toMatch(/待核/);
    }
  });

  it("通用包无任何逐值来源（不覆写地区/政策值）", () => {
    expect(Object.keys(NATIONAL_REGION_SOURCES)).toHaveLength(0);
    expect(getRegionProvenance("national").policy).toHaveLength(0);
  });
});

describe("region-facts · §16 单一真源（键与山西包 values 一一对齐）", () => {
  it("地区编目键 = 山西包 region.values 键集合（不多不少，防值/来源漂移）", () => {
    const pack = getRegionPack("shanxi");
    const valueKeys = Object.keys(pack.region.values).sort();
    const sourceKeys = Object.keys(SHANXI_REGION_SOURCES).sort();
    expect(sourceKeys).toEqual(valueKeys);
  });

  it("政策编目数组与山西包 policy 层按序对齐，且每条 policies 键 ⊆ 该层 values 键", () => {
    const pack = getRegionPack("shanxi");
    expect(SHANXI_POLICY_SOURCES.length).toBe(pack.policy.length);
    pack.policy.forEach((layer, i) => {
      const srcMap = SHANXI_POLICY_SOURCES[i] ?? {};
      for (const k of Object.keys(srcMap)) {
        expect(layer.values).toHaveProperty(k); // 编目只给已在此层覆写的键挂来源
      }
    });
  });

  it("每条编目键都是 PROJECT_PARAMS 已注册键（绝不含孤儿键）", () => {
    for (const k of Object.keys(SHANXI_REGION_SOURCES)) expect(knownKeys.has(k)).toBe(true);
    for (const m of SHANXI_POLICY_SOURCES) for (const k of Object.keys(m ?? {})) expect(knownKeys.has(k)).toBe(true);
  });
});

describe("region-facts · makeVerifiedFact 升级接缝（只有真链接才升 FACT）", () => {
  it("合法 https → FACT + 落地 url/type/asOf + 默认置信 85", () => {
    const m = makeVerifiedFact("https://fgw.shanxi.gov.cn/price", { sourceType: "政府公告", asOf: "2024-06" });
    expect(m).not.toBeNull();
    expect(m!.evidenceKind).toBe("FACT");
    expect(m!.sourceUrl).toBe("https://fgw.shanxi.gov.cn/price");
    expect(m!.sourceType).toBe("政府公告");
    expect(m!.asOf).toBe("2024-06");
    expect(m!.confidence).toBe(85);
  });

  it("http 亦合法；置信度取整并夹进 [0,100]", () => {
    const m = makeVerifiedFact("http://a.gov/x", { confidence: 200 });
    expect(m!.sourceUrl).toBe("http://a.gov/x");
    expect(m!.confidence).toBe(100);
    const m2 = makeVerifiedFact("https://a.gov/x", { confidence: -5 });
    expect(m2!.confidence).toBe(0);
  });

  it("脏输入（非 http(s) / 含空格 / 空串 / 相对路径 / 非字符串）一律 null，绝不产出伪 FACT", () => {
    expect(makeVerifiedFact("ftp://x/y")).toBeNull();
    expect(makeVerifiedFact("https://a.gov/x space")).toBeNull();
    expect(makeVerifiedFact("   ")).toBeNull();
    expect(makeVerifiedFact("/relative/path")).toBeNull();
    expect(makeVerifiedFact(null as unknown as string)).toBeNull();
  });
});

describe("region-facts · getRegionProvenance（未知回落通用 · 永不裸抛）", () => {
  it("shanxi 给两套映射；未知 id 回落通用（空 region、空 policy）", () => {
    expect(Object.keys(getRegionProvenance("shanxi").region ?? {})).toContain("region.elecPrice");
    const unknown = getRegionProvenance("no-such-province");
    expect(Object.keys(unknown.region ?? {})).toHaveLength(0);
    expect(unknown.policy ?? []).toHaveLength(0);
  });
});

describe("阶段3A · 条款级 FACT 目录（SHANXI_CLAUSE_FACTS · 全部经 makeVerifiedFact 管道）", () => {
  it("恰为 5 条（阶段2 高可信优先清单），id 唯一且钉桩", () => {
    expect(SHANXI_CLAUSE_FACTS).toHaveLength(5);
    const ids = SHANXI_CLAUSE_FACTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "shanxi-tou-2026-15",
      "shanxi-tnd-4th-cycle",
      "shanxi-charging-service-2023-134",
      "shanxi-nev-truck-2026-52",
      "shanxi-pv-resource-nmic",
    ]);
  });

  it("每条 meta 均为非空 FACT：可点击 http(s) 原文 + 置信 [0,100] + asOf 时点 + sourceType（§20 诚实闸门）", () => {
    for (const f of SHANXI_CLAUSE_FACTS) {
      expect(f.meta).not.toBeNull();
      const m = f.meta!;
      expect(m.evidenceKind).toBe("FACT");
      expect(typeof m.sourceUrl).toBe("string");
      expect(USABLE_HTTP_URL.test(m.sourceUrl!)).toBe(true);
      expect(typeof m.confidence).toBe("number");
      expect(m.confidence!).toBeGreaterThanOrEqual(0);
      expect(m.confidence!).toBeLessThanOrEqual(100);
      expect(m.asOf ?? "").not.toBe("");
      expect(m.sourceType ?? "").not.toBe("");
    }
  });

  it("relatedKeys 非空且全部是 PROJECT_PARAMS 已注册键（绝不含孤儿键）", () => {
    for (const f of SHANXI_CLAUSE_FACTS) {
      expect(f.relatedKeys.length).toBeGreaterThan(0);
      for (const k of f.relatedKeys) expect(knownKeys.has(k)).toBe(true);
    }
  });

  it("DATA_CONFLICT 原样保留（3 条冲突各带 key + 非空描述；禁折算的诚实口径写明）", () => {
    const conflicts = SHANXI_CLAUSE_FACTS.filter((f) => f.dataConflict != null);
    expect(conflicts.map((f) => f.id).sort()).toEqual([
      "shanxi-pv-resource-nmic",
      "shanxi-tnd-4th-cycle",
      "shanxi-tou-2026-15",
    ]);
    for (const f of conflicts) {
      expect(knownKeys.has(f.dataConflict!.key)).toBe(true);
      expect(f.dataConflict!.description).toMatch(/DATA_CONFLICT/);
      expect(f.dataConflict!.description.length).toBeGreaterThan(20);
    }
  });

  it("getRegionClauseFacts：shanxi 返回同一目录；未知 id / 全国通用 → 空列表，永不裸抛", () => {
    expect(getRegionClauseFacts("shanxi")).toBe(SHANXI_CLAUSE_FACTS);
    expect(getRegionClauseFacts("national")).toHaveLength(0);
    expect(getRegionClauseFacts("no-such-province")).toHaveLength(0);
  });

  it("★诚实护栏：条款升 FACT 后，逐值来源仍除「字面直传」唯一例外全为 ASSUMPTION（条款≠数值，阶段3A 指令三 + 批次1.2 例外钉桩）", () => {
    const allMetas = [
      ...Object.entries(SHANXI_REGION_SOURCES),
      ...SHANXI_POLICY_SOURCES.flatMap((m) => (m ? Object.entries(m) : [])),
    ];
    const facts = allMetas.filter(([, m]) => m.evidenceKind === "FACT");
    // 例外须"恰一条、恰该键、且为条款字面直传"三条件同时成立，否则视为护栏被泛化击穿。
    expect(facts).toHaveLength(1);
    expect(facts[0][0]).toBe("region.demandCharge");
    expect(facts[0][1].note ?? "").toMatch(/字面直传/);
    for (const [k, m] of allMetas) {
      if (k === "region.demandCharge") continue;
      expect(m.evidenceKind, `${k} 越例混入非直传 FACT`).toBe("ASSUMPTION");
      expect(m.sourceUrl).toBeUndefined();
    }
    // 目录本身绝不给数值：条目结构里没有 value 字段可藏（类型级约束由编译器守，此处守运行时面）。
    for (const f of SHANXI_CLAUSE_FACTS) {
      expect(Object.keys(f)).not.toContain("value");
      expect(Object.keys(f)).not.toContain("values");
    }
  });
});
