import { describe, it, expect } from "vitest";
import type { BenchmarkRef } from "@app/kernel/engine/types";
import {
  toSourceRows,
  isUsableHttpUrl,
  formatValueText,
  formatValidWindow,
  formatConfidence,
  formatRegion,
} from "@/components/decision/benchmark-source-model";

/**
 * P2「来源下钻」的**纯模型**单测（无 DOM——面板本身是展示壳，规则全在这）。
 * 钉死的都是"别骗用户"的诚实不变量：脏 URL 不给链接、UNKNOWN 不显示成 0、
 * 0 与 null 分得清、已核实排在前但假设照样在列、同一快照排序确定。
 */

function mk(over: Partial<BenchmarkRef> & { key: string }): BenchmarkRef {
  return {
    label: over.key,
    unit: "",
    value: 1,
    valueClass: "BENCHMARK",
    source: "内部工程经验值",
    evidenceKind: "ASSUMPTION",
    confidence: 40,
    ...over,
  } as BenchmarkRef;
}

describe("isUsableHttpUrl · 诚实闸门（宁可不给链接，不给可疑链接）", () => {
  it("http/https 合法链接（含前后空白会被吃掉）通过", () => {
    expect(isUsableHttpUrl("https://gov.cn/doc")).toBe(true);
    expect(isUsableHttpUrl("http://a.com/x")).toBe(true);
    expect(isUsableHttpUrl("  https://trim.me/p  ")).toBe(true);
  });
  it("非 http(s) 协议一律拒：javascript: / ftp: / data:", () => {
    expect(isUsableHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isUsableHttpUrl("ftp://x/y")).toBe(false);
    expect(isUsableHttpUrl("data:text/html,<script>")).toBe(false);
    expect(isUsableHttpUrl("//protocol-relative.com")).toBe(false);
  });
  it("内部含空白（疑似被截断/拼接污染）→ 拒；空串/null/undefined → 拒", () => {
    expect(isUsableHttpUrl("https://a.com/有 空格")).toBe(false);
    expect(isUsableHttpUrl("http://a b")).toBe(false);
    expect(isUsableHttpUrl("")).toBe(false);
    expect(isUsableHttpUrl(null)).toBe(false);
    expect(isUsableHttpUrl(undefined)).toBe(false);
  });
});

describe("formatValueText · 0 与 null 与 UNKNOWN 各是各的", () => {
  it("正常数值：整数不补零，小数最多 4 位", () => {
    expect(formatValueText(mk({ key: "k", value: 0.3695 }))).toBe("0.3695");
    expect(formatValueText(mk({ key: "k", value: 55 }))).toBe("55");
  });
  it("0 是有效取值，原样显示成 '0'（绝不塌成'未核实'）", () => {
    expect(formatValueText(mk({ key: "k", value: 0 }))).toBe("0");
  });
  it("null + UNKNOWN → '未核实'；null 但非 UNKNOWN → '—'", () => {
    expect(formatValueText(mk({ key: "k", value: null, valueClass: "UNKNOWN" }))).toBe("未核实");
    expect(formatValueText(mk({ key: "k", value: null, valueClass: "BENCHMARK" }))).toBe("—");
  });
  it("有 textValue（口径型）→ 显示口径文本", () => {
    expect(formatValueText(mk({ key: "k", value: null, textValue: "尖峰8h/平段10h/谷段6h" }))).toBe("尖峰8h/平段10h/谷段6h");
  });
});

describe("formatValidWindow / formatConfidence / formatRegion", () => {
  it("生效区间四态", () => {
    expect(formatValidWindow("2026-05-01", "2030-12-31")).toBe("2026-05-01 ~ 2030-12-31");
    expect(formatValidWindow("2026-05-01", null)).toBe("2026-05-01 起");
    expect(formatValidWindow(null, "2030-12-31")).toBe("…至 2030-12-31");
    expect(formatValidWindow(null, null)).toBe("—");
  });
  it("置信度取整加百分号；非数字回 '—'", () => {
    expect(formatConfidence(95)).toBe("95%");
    expect(formatConfidence(39.6)).toBe("40%");
    expect(formatConfidence(NaN)).toBe("—");
    expect(formatConfidence(undefined)).toBe("—");
  });
  it("通用/全国/全球都归'通用'，已知地区给中文名，未知地区原样（不臆造地名）", () => {
    expect(formatRegion("")).toBe("通用");
    expect(formatRegion("national")).toBe("通用");
    expect(formatRegion("global")).toBe("通用");
    expect(formatRegion(undefined)).toBe("通用");
    expect(formatRegion("shanxi")).toBe("山西");
    expect(formatRegion("innermongolia")).toBe("innermongolia");
  });
});

describe("toSourceRows · 归一 + 排序 + 承重不藏假设", () => {
  it("空/未定义快照 → 空数组（组件据此显示'未引用带来源的基准'）", () => {
    expect(toSourceRows({})).toEqual([]);
    expect(toSourceRows(null)).toEqual([]);
    expect(toSourceRows(undefined)).toEqual([]);
  });

  it("已核实(FACT)且有合法链接 → url 可点；假设(ASSUMPTION)无链接 → url=null 但照样在列", () => {
    const rows = toSourceRows({
      tou: mk({ key: "tou", label: "分时电价系数", evidenceKind: "FACT", confidence: 95, sourceUrl: "https://gov.cn/tou", validFrom: "2026-05-01", regionId: "shanxi" }),
      pv: mk({ key: "pv", label: "光伏单位年发电量", evidenceKind: "ASSUMPTION", confidence: 40 }),
    });
    expect(rows[0].key).toBe("tou"); // FACT 排在前
    expect(rows[0].url).toBe("https://gov.cn/tou");
    expect(rows[0].regionText).toBe("山西");
    expect(rows[0].validWindow).toBe("2026-05-01 起");
    expect(rows[0].confidenceText).toBe("95%");
    expect(rows[1].key).toBe("pv");
    expect(rows[1].url).toBeNull(); // 没链接≠没列出
  });

  it("脏链接(INTERNAL 空白/非 http)→ 即便 evidenceKind=FACT 也不给可点 url（不骗用户）", () => {
    const rows = toSourceRows({
      bad1: mk({ key: "bad1", evidenceKind: "FACT", sourceUrl: "javascript:alert(1)" }),
      bad2: mk({ key: "bad2", evidenceKind: "FACT", sourceUrl: "https://a.com/带 空格" }),
    });
    expect(rows.every((r) => r.url === null)).toBe(true);
  });

  it("同证据级内按置信度降序；未知证据级排最后", () => {
    const rows = toSourceRows({
      a: mk({ key: "a", label: "A", evidenceKind: "ASSUMPTION", confidence: 30 }),
      b: mk({ key: "b", label: "B", evidenceKind: "ASSUMPTION", confidence: 60 }),
      f: mk({ key: "f", label: "F", evidenceKind: "FACT", confidence: 50 }),
      u: mk({ key: "u", label: "U", evidenceKind: "WEIRD_KIND", confidence: 99 }),
    });
    expect(rows.map((r) => r.key)).toEqual(["f", "b", "a", "u"]);
  });

  it("同一快照两次调用顺序完全一致（确定性，不随 Object 键序抖动）", () => {
    const snap = {
      x: mk({ key: "x", label: "Xi", evidenceKind: "ASSUMPTION", confidence: 40 }),
      y: mk({ key: "y", label: "Yi", evidenceKind: "ASSUMPTION", confidence: 40 }),
      z: mk({ key: "z", label: "Zi", evidenceKind: "FACT", confidence: 90, sourceUrl: "https://z.example" }),
    };
    expect(toSourceRows(snap).map((r) => r.key)).toEqual(toSourceRows(snap).map((r) => r.key));
    expect(toSourceRows(snap)[0].key).toBe("z"); // FACT 永远先
  });

  it("source 为纯空白 → 归一为'未注明来源'；note 空白 → null", () => {
    const rows = toSourceRows({
      s: { ...mk({ key: "s" }), source: "   ", note: "   " },
    });
    expect(rows[0].source).toBe("未注明来源");
    expect(rows[0].note).toBeNull();
  });
});
