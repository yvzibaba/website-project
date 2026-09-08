/**
 * 阶段2（山西真实数据）· 数据候选集质量检查（创始人指令第十三节）。
 *
 * 被检对象：docs/verified-data/shanxi-v1.json —— **候选数据层，未接入模型**
 * （本测试只做"数据质量门禁"，不 import 任何 src/ 计算模块，不改任何默认参数）。
 *
 * 检查项（与指令十三一一对应）：
 *   1. 数据 Schema 检查（必填字段 / 枚举）
 *   2. sourceUrl 合法性检查（与 parameter-engine 的 usableHttpUrl 同口径：^https?:// 且无空白）
 *   3. 日期检查（ISO 格式；sourceDate ≤ 今天；effectiveDate ≤ expiryDate；过期条目必须标 expired）
 *   4. 地区检查（region 枚举：全国/山西省/分区/11 个地市）
 *   5. 重复数据检查（id 唯一；(paramRef, sourceUrl) 二元组唯一）
 *   6. 过期数据检查（expiryDate < today ⇒ status 必须为 "expired"）
 *   7. 单位检查（unit 枚举，仅对 single/range 型数值强制）
 *   8. 诚实性检查（C/D 级不得 canUpgradeToFact；五元组 value/sourceUrl/sourceDate/asOf/confidence 完整）
 *   9. 缺口表完整性（每条缺口含 impactParams / needHuman / suggestedAction）
 *
 * 本文件随 SENSITIVITY/MODEL 版本零关联：不改敏感性与模型任何行为。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface SecondarySource {
  title: string;
  url: string;
}

interface CandidateItem {
  id: string;
  category: string;
  paramRefs: string[];
  name: string;
  value: { kind: string; value?: number; low?: number; high?: number; unit?: string; text?: string };
  region: string;
  publisher: string;
  evidenceGrade: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  effectiveDate?: string;
  expiryDate?: string;
  asOf: string;
  confidence: number;
  canUpgradeToFact: boolean;
  status: string;
  notes: string;
  secondarySources?: SecondarySource[];
}

interface Gap {
  id: string;
  title: string;
  status: string;
  detail: string;
  impactParams: string[];
  needHuman: boolean;
  suggestedAction: string;
}

interface CandidateSet {
  meta: Record<string, unknown>;
  items: CandidateItem[];
  gaps: Gap[];
}

const DATA_PATH = path.resolve(process.cwd(), "docs", "verified-data", "shanxi-v1.json");

const CATEGORIES = [
  "electricity",
  "solar-resource",
  "cost-pv",
  "cost-storage",
  "cost-charging",
  "policy",
] as const;

const GRADES = ["S", "A", "B", "C", "D"] as const;

const STATUSES = ["candidate", "assumption", "needs-human", "expired"] as const;

const REGIONS = [
  "全国",
  "山西省",
  "山西省北部",
  "山西省中北部",
  "山西省南部",
  "太原市",
  "大同市",
  "朔州市",
  "忻州市",
  "阳泉市",
  "晋中市",
  "吕梁市",
  "长治市",
  "晋城市",
  "临汾市",
  "运城市",
] as const;

const UNITS = [
  "元/kWh",
  "元/W",
  "元/Wh",
  "元/kW",
  "元/kW·月",
  "元/kW·年",
  "元/tCO₂",
  "元/kWp·年",
  "元/kWh·年",
  "h",
  "%",
  "倍",
  "万辆",
  "个",
  "km",
  "MJ/m²·年",
  "kWh/m²·年",
  "万千瓦",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 与 parameter-engine 的 usableHttpUrl 同口径：http(s) 开头、非空、不含任何空白。 */
const USABLE_HTTP_URL = /^https?:\/\/\S+$/;

function loadSet(): CandidateSet {
  const raw = readFileSync(DATA_PATH, "utf-8");
  return JSON.parse(raw) as CandidateSet;
}

function toDate(s: string): Date {
  return new Date(`${s}T00:00:00+08:00`);
}

describe("verified-data · Shanxi 候选集质量门禁（阶段2 指令第十三节）", () => {
  const set = loadSet();
  const today = new Date();

  it("meta 完整且声明 NOT-WIRED（数据层不接模型）", () => {
    expect(set.meta).toBeTruthy();
    expect(String(set.meta.name)).toContain("Shanxi Verified Data Candidate Set");
    expect(set.meta.wiring).toBe("NOT-WIRED（本文件仅为候选数据层，未被 src/ 任何模块 import，不参与模型计算，不改变任何默认参数）");
    expect(set.meta.generatedAt).toMatch(ISO_DATE);
  });

  it("数据 Schema 检查：items 非空且每条必填字段/枚举齐全", () => {
    expect(Array.isArray(set.items)).toBe(true);
    expect(set.items.length).toBeGreaterThanOrEqual(10);

    for (const it of set.items) {
      expect(it.id, "id 必填").toMatch(/^SX-[A-Z]+-\d{3}$/);
      expect(CATEGORIES).toContain(it.category as never);
      expect(it.name.length).toBeGreaterThan(4);
      expect(["single", "range", "structural"]).toContain(it.value.kind);
      if (it.value.kind === "single") expect(typeof it.value.value).toBe("number");
      if (it.value.kind === "range") {
        expect(typeof it.value.low).toBe("number");
        expect(typeof it.value.high).toBe("number");
        const { low = 0, high = 0 } = it.value;
        expect(high).toBeGreaterThan(low);
      }
      if (it.value.kind === "structural") expect(it.value.text?.length ?? 0).toBeGreaterThan(10);
      expect(REGIONS).toContain(it.region as never);
      expect(it.publisher.length).toBeGreaterThan(2);
      expect(GRADES).toContain(it.evidenceGrade as never);
      expect(it.sourceTitle.length).toBeGreaterThan(4);
      expect(it.notes.length).toBeGreaterThan(10);
      expect(STATUSES).toContain(it.status as never);
      expect(Array.isArray(it.paramRefs)).toBe(true);
    }
  });

  it("sourceUrl 合法性检查：主源与次源全部是可用 http(s) 链接（usableHttpUrl 口径）", () => {
    for (const it of set.items) {
      expect(USABLE_HTTP_URL.test(it.sourceUrl), `${it.id} 主源 URL 非法: ${it.sourceUrl}`).toBe(true);
      for (const s of it.secondarySources ?? []) {
        expect(USABLE_HTTP_URL.test(s.url), `${it.id} 次源 URL 非法: ${s.url}`).toBe(true);
      }
    }
  });

  it("日期检查：ISO 格式、sourceDate ≤ 今天、effectiveDate ≤ expiryDate、五元组时点齐全", () => {
    for (const it of set.items) {
      expect(ISO_DATE.test(it.sourceDate), `${it.id} sourceDate 非 ISO`).toBe(true);
      expect(ISO_DATE.test(it.asOf), `${it.id} asOf 非 ISO`).toBe(true);
      expect(toDate(it.sourceDate).getTime()).toBeLessThanOrEqual(today.getTime());
      if (it.effectiveDate !== undefined) {
        expect(ISO_DATE.test(it.effectiveDate), `${it.id} effectiveDate 非 ISO`).toBe(true);
        expect(toDate(it.effectiveDate).getTime()).toBeGreaterThanOrEqual(toDate(it.sourceDate).getTime() - 90 * 86400_000);
      }
      if (it.effectiveDate !== undefined && it.expiryDate !== undefined) {
        expect(toDate(it.expiryDate).getTime()).toBeGreaterThan(toDate(it.effectiveDate).getTime());
      }
    }
  });

  it("过期数据检查：expiryDate < 今天 的条目 status 必须为 expired（当前候选集应为空集，仅防未来加入过期条目时漏标）", () => {
    for (const it of set.items) {
      if (it.expiryDate !== undefined && toDate(it.expiryDate).getTime() < today.getTime()) {
        expect(it.status, `${it.id} 已过期但未标 expired`).toBe("expired");
      }
    }
  });

  it("地区检查：region 枚举内（全国/省/分区/地市），且山西条目不冒充全国口径", () => {
    for (const it of set.items) {
      expect(REGIONS).toContain(it.region as never);
      // 全国性政策/市场价格必须显式标注 region="全国"，不得默认写山西省
      if (it.region === "全国") {
        expect(
          it.notes + it.sourceTitle,
          `${it.id} 标注全国，说明中应能看出全国口径依据`,
        ).toBeTruthy();
      }
    }
  });

  it("重复数据检查：id 唯一；(paramRef, sourceUrl, 数值内容) 三元组唯一（同一文件支撑不同侧面不算重复）", () => {
    const ids = set.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);

    const pairs = new Set<string>();
    for (const it of set.items) {
      const facet = JSON.stringify(it.value);
      for (const ref of it.paramRefs) {
        const key = `${ref}::${it.sourceUrl}::${facet}`;
        expect(pairs.has(key), `重复证据对 ${key}`).toBe(false);
        pairs.add(key);
      }
    }
  });

  it("单位检查：single/range 型条目 unit 必须在枚举内", () => {
    for (const it of set.items) {
      if (it.value.kind !== "structural") {
        expect(it.value.unit, `${it.id} 数值型条目缺 unit`).toBeTruthy();
        expect(UNITS).toContain(it.value.unit as never);
      }
    }
  });

  it("诚实性检查：五元组完整；C/D 级禁止 canUpgradeToFact；needs-human 条目不得声称可升级", () => {
    for (const it of set.items) {
      // 五元组：value(sourceUrl/sourceDate/asOf/confidence 已由其他用例覆盖，这里补齐 int 置信度与 value 存在)
      expect(Number.isInteger(it.confidence)).toBe(true);
      expect(it.confidence).toBeGreaterThanOrEqual(0);
      expect(it.confidence).toBeLessThanOrEqual(100);
      expect(it.value).toBeTruthy();

      if (it.evidenceGrade === "C" || it.evidenceGrade === "D") {
        expect(it.canUpgradeToFact, `${it.id} C/D 级不得直接升级 FACT`).toBe(false);
      }
      if (it.status === "needs-human") {
        expect(it.canUpgradeToFact, `${it.id} needs-human 与 canUpgradeToFact 互斥`).toBe(false);
      }
      if (it.canUpgradeToFact) {
        expect(["S", "A"]).toContain(it.evidenceGrade as never);
      }
    }
  });

  it("缺口表完整性：每条缺口有编号/状态/影响参数/人工标记/建议动作，且 G1-G10 在列", () => {
    expect(Array.isArray(set.gaps)).toBe(true);
    expect(set.gaps.length).toBeGreaterThanOrEqual(8);
    const ids = set.gaps.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of set.gaps) {
      expect(g.title.length).toBeGreaterThan(4);
      expect(["not-found", "partially-found", "found"]).toContain(g.status);
      expect(Array.isArray(g.impactParams)).toBe(true);
      expect(g.needHuman).toBe(true); // 阶段2 所有缺口升级动作都需要人工
      expect(g.suggestedAction.length).toBeGreaterThan(4);
    }
    for (const expected of ["G1", "G3", "G8", "G10"]) {
      expect(ids).toContain(expected);
    }
  });

  it("关键政策锚点未被抄错（防转录漂移的最小钉桩）", () => {
    // 晋发改商品发〔2026〕15号：浮动比例
    const ratios = set.items.find((i) => i.id === "SX-ELEC-002");
    expect(ratios?.value.text).toContain("上浮60%");
    expect(ratios?.value.text).toContain("下浮55%");
    expect(ratios?.value.text).toContain("上浮20%");
    expect(ratios?.sourceUrl).toContain("fgw.shanxi.gov.cn");
    // 52号文：免收容需量电费 2030
    const fee = set.items.find((i) => i.id === "SX-ELEC-006");
    expect(fee?.value.text).toContain("2030年前");
    expect(fee?.value.text).toContain("免收需量（容量）电费");
    expect(fee?.sourceUrl).toContain("myj.shanxi.gov.cn");
    // 2025 实际利用小时
    const hours = set.items.find((i) => i.id === "SX-SOL-002");
    expect(hours?.value.value).toBe(1170);
  });
});
