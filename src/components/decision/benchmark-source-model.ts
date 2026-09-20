/**
 * P2「数字点开看来源」的**纯展示模型**（无任何 React / 框架依赖，便于离线单测钉死诚实规则）。
 *
 * 输入是引擎随 `CalculationResult` 一起送达浏览器的 `benchmarkSnapshot`（键 → `BenchmarkRef`），
 * 也就是**本次这个情景、这个地区实际引用到的那批基准**（不是"当下库里的版本"）。
 * 用它而不是重新查库，是因为：① 更准确——快照就是算出这些数用的那批值；② 更简单——少一次网络/DB 往返与鉴权。
 *
 * 本模块只做**归一化 + 排序 + 诚实闸门**，绝不改动任何数值，也不引入第二个来源真源。
 */

import type { BenchmarkRef } from "@app/kernel/engine/types";
import { isUsableHttpUrl } from "@/lib/url-safety";

// 从共享模块 re-export：V2 决策面板与 V1 沙盘两档都用同一个闸门，避免"这里的规则"漂移。
export { isUsableHttpUrl } from "@/lib/url-safety";

/** 一行"数据来源"下钻记录（已经翻成人话、判定好可点性，交给组件直接渲染）。 */
export interface BenchmarkSourceRow {
  key: string;
  /** 参数名（原样 label）。 */
  label: string;
  /** 取值文本：数值 / 口径文本 / "未核实"（UNKNOWN 绝不显示成 0）。 */
  valueText: string;
  unit: string;
  /** 认识论标签原文（FACT / ASSUMPTION / INFERENCE / PREDICTION），交给 EvidenceBadge 翻译。 */
  evidenceKind: string;
  /** 置信度百分比文本（"95%"），非数字时为 "—"。 */
  confidenceText: string;
  /** 生效区间（"2026-05-01 ~ 2030-12-31" / "…起" / "—")。 */
  validWindow: string;
  /** 地区（"通用" / "山西" / 原始 id）。 */
  regionText: string;
  /** 来源描述（人可读）。 */
  source: string;
  /** 口径说明（可空）。 */
  note: string | null;
  /**
   * **可点的原文链接**：仅当 `sourceUrl` 通过 `@/lib/url-safety.isUsableHttpUrl` 的诚实闸门时才非 null。
   * 脏 URL（javascript:/ftp:/data:/带空白/控制字符）一律置 null —— 宁可不给链接，也不给可疑链接。
   */
  url: string | null;
}

/** 数值→取值文本。UNKNOWN / null 一律 "未核实"（绝不拿 0 冒充"算出来是 0"）；有 textValue 走口径文本。 */
export function formatValueText(e: Pick<BenchmarkRef, "value" | "textValue" | "valueClass">): string {
  // valueClass === "UNKNOWN" 时引擎约定 value 必为 null；双保险仍按"未核实"显示。
  if (e.value == null || !Number.isFinite(e.value)) {
    if (e.textValue) return e.textValue;
    return e.valueClass === "UNKNOWN" ? "未核实" : "—";
  }
  // 0 是有效取值，原样保留（区分于 null）。小数位：整数不补零，否则最多 4 位。
  return Number.isInteger(e.value) ? String(e.value) : e.value.toFixed(4);
}

/** 生效区间文本：两端都有→"A ~ B"；只有起→"A 起"；只有止→"…至 B"；都无→"—"。 */
export function formatValidWindow(from?: string | null, to?: string | null): string {
  const a = from && from.trim() ? from.trim() : null;
  const b = to && to.trim() ? to.trim() : null;
  if (a && b) return `${a} ~ ${b}`;
  if (a) return `${a} 起`;
  if (b) return `…至 ${b}`;
  return "—";
}

/** 置信度文本：0..100 的数字取整加百分号；非数字回 "—"。 */
export function formatConfidence(c: number | null | undefined): string {
  if (typeof c !== "number" || !Number.isFinite(c)) return "—";
  return `${Math.round(c)}%`;
}

/** 地区文本：通用/全国/全球归"通用"，已知地区给中文名，其余原样显示 id（不臆造中文地名）。 */
const REGION_LABEL: Record<string, string> = {
  shanxi: "山西",
};
export function formatRegion(regionId?: string | null): string {
  const id = (regionId ?? "").trim();
  if (id === "" || id === "national" || id === "global") return "通用";
  return REGION_LABEL[id] ?? id;
}

/**
 * 证据等级排序权重：已核实的事实排最前，假设其次，再推演/预测，未知最后。
 * 这样用户第一眼看到的是"有出处、可点开核对"的数，占位假设沉到下面但**照样在列**（不藏）。
 */
const EVIDENCE_ORDER: Record<string, number> = {
  FACT: 0,
  ASSUMPTION: 1,
  INFERENCE: 2,
  PREDICTION: 3,
};
function evidenceWeight(kind: string): number {
  return EVIDENCE_ORDER[kind] ?? 4;
}

/**
 * 把快照转成按可信度排序的下钻行。
 * - 同证据等级内按置信度**降序**；再按参数名升序，保证输出确定性（同一快照 → 同一顺序）。
 * - 空/未定义快照 → 空数组（组件据此显示"未引用带来源的基准"）。
 */
export function toSourceRows(snapshot: Record<string, BenchmarkRef> | null | undefined): BenchmarkSourceRow[] {
  if (!snapshot) return [];
  const rows: BenchmarkSourceRow[] = [];
  for (const [key, b] of Object.entries(snapshot)) {
    if (!b || typeof b !== "object") continue;
    rows.push({
      key,
      label: b.label ?? key,
      valueText: formatValueText(b),
      unit: b.unit ?? "",
      evidenceKind: b.evidenceKind ?? "UNKNOWN",
      confidenceText: formatConfidence(b.confidence),
      validWindow: formatValidWindow(b.validFrom, b.validTo),
      regionText: formatRegion(b.regionId),
      source: b.source && b.source.trim() ? b.source.trim() : "未注明来源",
      note: b.note && b.note.trim() ? b.note.trim() : null,
      url: isUsableHttpUrl(b.sourceUrl) ? b.sourceUrl!.trim() : null,
    });
  }
  rows.sort((x, y) => {
    const w = evidenceWeight(x.evidenceKind) - evidenceWeight(y.evidenceKind);
    if (w !== 0) return w;
    const cx = rawConfidence(snapshot, x.key);
    const cy = rawConfidence(snapshot, y.key);
    if (cy !== cx) return cy - cx; // 高置信在前
    return x.label.localeCompare(y.label, "zh-CN");
  });
  return rows;
}

/** 取原始 confidence 用于排序（模型里只存了格式化文本，故回填时读回快照）。 */
function rawConfidence(snapshot: Record<string, BenchmarkRef>, key: string): number {
  const c = snapshot[key]?.confidence;
  return typeof c === "number" && Number.isFinite(c) ? c : -1;
}
