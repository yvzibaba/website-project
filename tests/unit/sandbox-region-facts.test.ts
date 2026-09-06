/**
 * 单元测试：R8.7「地区 / 政策逐值来源编目」`sandbox-region-facts`（纯函数 · 诚实基线 · 升级接缝）。
 *
 * 锁定（§16 单一真源 / §20 诚实绝不虚构来源）：
 *   - 现存每一条山西地区/政策来源**全为诚实 ASSUMPTION、不带 sourceUrl**（研发环境未逐条核实到可点击权威原文，绝不伪FACT）；
 *   - 编目键须与 `sandbox-regions.ts` 里山西包实际覆写的 `values` 键**一一对齐**（防目录漂移，值与来源不双写）；
 *   - `makeVerifiedFact` 是升级 FACT 的唯一入口：只有合法 http(s) 链接才产出 FACT，脏输入一律 null（宁可误拒）；
 *   - `getRegionProvenance` 对未知 id 回落通用、绝不裸抛。
 */
import { describe, it, expect } from "vitest";
import {
  SANDBOX_REGION_FACTS_VERSION,
  regionFactsCalcRef,
  makeVerifiedFact,
  getRegionProvenance,
  SHANXI_REGION_SOURCES,
  SHANXI_POLICY_SOURCES,
  NATIONAL_REGION_SOURCES,
} from "@/server/sandbox-region-facts";
import { getRegionPack } from "@/server/sandbox-regions";
import { SANDBOX_PARAMS } from "@/server/sandbox-params";

const knownKeys = new Set(SANDBOX_PARAMS.map((s) => s.key));

describe("sandbox-region-facts · 版本与契约", () => {
  it("版本语义化 + calcRef 溯源串", () => {
    expect(SANDBOX_REGION_FACTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(regionFactsCalcRef()).toBe(`region-facts@${SANDBOX_REGION_FACTS_VERSION}`);
  });
});

describe("sandbox-region-facts · §20 诚实基线（现存条目全为待核实 ASSUMPTION）", () => {
  it("★山西每一条地区/政策来源都是 ASSUMPTION、无 sourceUrl、note 带「待核」标注", () => {
    const allMetas = [
      ...Object.values(SHANXI_REGION_SOURCES),
      ...SHANXI_POLICY_SOURCES.flatMap((m) => (m ? Object.values(m) : [])),
    ];
    expect(allMetas.length).toBeGreaterThan(0);
    for (const m of allMetas) {
      expect(m.evidenceKind).toBe("ASSUMPTION");
      expect(m.sourceUrl).toBeUndefined();
      expect(m.note ?? "").toMatch(/待核/);
    }
  });

  it("通用包无任何逐值来源（不覆写地区/政策值）", () => {
    expect(Object.keys(NATIONAL_REGION_SOURCES)).toHaveLength(0);
    expect(getRegionProvenance("national").policy).toHaveLength(0);
  });
});

describe("sandbox-region-facts · §16 单一真源（键与山西包 values 一一对齐）", () => {
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

  it("每条编目键都是 SANDBOX_PARAMS 已注册键（绝不含孤儿键）", () => {
    for (const k of Object.keys(SHANXI_REGION_SOURCES)) expect(knownKeys.has(k)).toBe(true);
    for (const m of SHANXI_POLICY_SOURCES) for (const k of Object.keys(m ?? {})) expect(knownKeys.has(k)).toBe(true);
  });
});

describe("sandbox-region-facts · makeVerifiedFact 升级接缝（只有真链接才升 FACT）", () => {
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

describe("sandbox-region-facts · getRegionProvenance（未知回落通用 · 永不裸抛）", () => {
  it("shanxi 给两套映射；未知 id 回落通用（空 region、空 policy）", () => {
    expect(Object.keys(getRegionProvenance("shanxi").region ?? {})).toContain("region.elecPrice");
    const unknown = getRegionProvenance("no-such-province");
    expect(Object.keys(unknown.region ?? {})).toHaveLength(0);
    expect(unknown.policy ?? []).toHaveLength(0);
  });
});
