/**
 * 区域参数快照导出 —— `npm run params:export`
 *
 * ## 为什么需要这个脚本（文档 ai-rules/02-PAYLOAD.md §4 第 1 步）
 *
 * 当前区域参数**硬编码在 TypeScript 源码里**（`kernel/src/server/sandbox-regions.ts` 的
 * `values` + `sandbox-region-facts.ts` 的逐值溯源）。要把它迁进数据库（Payload）之前，
 * 必须先有一份**机器可读、可留档、可 diff 的完整快照**——否则迁移就成了「一边读代码一边改库」，
 * 既无法复核，也无法回滚。
 *
 * 本脚本只做一件事：**把内核此刻真实生效的参数与溯源原样倒出来**。
 *
 * ## 三条硬约束（违背即视为数据事故）
 *
 * 1. **绝不修正任何值或置信度。** 迁移期「顺手把 confidence 从 45 调高」是宪法 §20 明令禁止的。
 *    本脚本只读不判，`confidence<=50` 与 `ASSUMPTION` 原样保留。
 * 2. **绝不虚构来源。** 缺 `sourceUrl` 就写 `null`，不猜、不补。
 * 3. **输出必须可复算。** 同一份代码跑两次，除 `generatedAt` 外逐字节相同。
 *
 * ## 输出
 *
 *   docs/verified-data/kernel-region-params.snapshot.json
 *
 * 用途：① 迁移到 Payload 的导入源；② 迁移前后做逐位对比的基准；③ 「占位参数还剩多少」的可数化证据。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  SANDBOX_REGIONS,
  SANDBOX_REGIONS_VERSION,
  regionCalcRef,
  type SandboxRegionPack,
} from "@app/kernel/server/sandbox-regions";
import {
  SANDBOX_REGION_FACTS_VERSION,
  regionFactsCalcRef,
  SHANXI_CLAUSE_FACTS,
} from "@app/kernel/server/sandbox-region-facts";
import type { ValueLayer } from "@app/kernel/server/parameter-engine";
import { SANDBOX_PARAMS, SANDBOX_PARAMS_VERSION } from "@app/kernel/server/sandbox-params";

/** 快照自身的 schema 版本（字段增减须升版记因）。 */
const SNAPSHOT_SCHEMA_VERSION = "1.0.0";

const OUT_PATH = path.resolve(
  process.cwd(),
  "docs/verified-data/kernel-region-params.snapshot.json",
);

function isoOrNull(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

interface ParamEntry {
  regionId: string;
  layer: "region" | "policy";
  layerIndex: number;
  key: string;
  domain: string;
  value: number | boolean | string;
  valueType: "number" | "boolean" | "string";
  evidenceKind: string;
  confidence: number | null;
  sourceUrl: string | null;
  sourceType: string | null;
  asOf: string | null;
  note: string | null;
  layerSource: string | null;
  bounds: { min?: number; max?: number } | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  /** 是否仍为占位（非 FACT 或置信度 ≤50）。用于度量「还欠多少功课」。 */
  isPlaceholder: boolean;
}

function collect(
  pack: SandboxRegionPack,
  layer: ValueLayer,
  kind: "region" | "policy",
  layerIndex: number,
): ParamEntry[] {
  return Object.entries(layer.values).map(([key, value]) => {
    const meta = layer.sources?.[key];
    const evidenceKind = meta?.evidenceKind ?? layer.evidenceKind ?? "ASSUMPTION";
    const confidence = meta?.confidence ?? layer.confidence ?? null;
    const dots = key.indexOf(".");
    return {
      regionId: pack.id,
      layer: kind,
      layerIndex,
      key,
      domain: dots > 0 ? key.slice(0, dots) : "(root)",
      value,
      valueType:
        typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
      evidenceKind,
      confidence,
      sourceUrl: meta?.sourceUrl ?? null,
      sourceType: meta?.sourceType ?? null,
      asOf: meta?.asOf ?? null,
      note: meta?.note ?? null,
      layerSource: layer.source ?? null,
      bounds: layer.bounds?.[key] ?? null,
      effectiveFrom: isoOrNull(layer.effectiveFrom),
      effectiveUntil: isoOrNull(layer.effectiveUntil),
      isPlaceholder: evidenceKind !== "FACT" || (confidence ?? 0) <= 50,
    };
  });
}

const packs = SANDBOX_REGIONS.map((pack) => {
  const entries: ParamEntry[] = [
    ...collect(pack, pack.region, "region", 0),
    ...pack.policy.flatMap((layer, i) => collect(pack, layer, "policy", i)),
  ];
  return {
    id: pack.id,
    name: pack.name,
    summary: pack.summary,
    note: pack.note,
    regionLayerCount: 1,
    policyLayerCount: pack.policy.length,
    entries,
  };
});

const all = packs.flatMap((p) => p.entries);

/* ── 统计（供报告与「债还剩多少」的度量） ── */
const byEvidenceKind: Record<string, number> = {};
const byRegion: Record<string, number> = {};
const byDomain: Record<string, number> = {};
const placeholderByRegion: Record<string, number> = {};
let factCount = 0;
let placeholderCount = 0;

for (const e of all) {
  byEvidenceKind[e.evidenceKind] = (byEvidenceKind[e.evidenceKind] ?? 0) + 1;
  byRegion[e.regionId] = (byRegion[e.regionId] ?? 0) + 1;
  byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1;
  if (e.evidenceKind === "FACT") factCount++;
  if (e.isPlaceholder) {
    placeholderCount++;
    placeholderByRegion[e.regionId] = (placeholderByRegion[e.regionId] ?? 0) + 1;
  }
}

/* ── 参数总目录统计 ──
   注意区分两个不同的分母，混淆会导致严重误判：
   · `catalog` = 参数**目录**规模（声明了哪些可调参数，含派生键与未启用键）
   · `stats.*Entries` = 地区包**实际覆写**的条目数
   一个省要「做功课」，做的是**目录**里那些参数在该省的取值，不是只做已被覆写的 9 条。 */
const catalog = {
  version: SANDBOX_PARAMS_VERSION,
  total: SANDBOX_PARAMS.length,
  byGroup: {} as Record<string, number>,
  byExposure: {} as Record<string, number>,
  byEvidenceKind: {} as Record<string, number>,
  derivedCount: 0,
  inactiveCount: 0,
  notEditableCount: 0,
  lowConfidenceCount: 0,
};
for (const p of SANDBOX_PARAMS) {
  const g = String(p.group);
  const e = String(p.exposure);
  catalog.byGroup[g] = (catalog.byGroup[g] ?? 0) + 1;
  catalog.byExposure[e] = (catalog.byExposure[e] ?? 0) + 1;
  const k = String(p.evidenceKind);
  catalog.byEvidenceKind[k] = (catalog.byEvidenceKind[k] ?? 0) + 1;
  if (p.derived) catalog.derivedCount++;
  if (p.inactive) catalog.inactiveCount++;
  if (!p.editable) catalog.notEditableCount++;
  if (p.confidence <= 50) catalog.lowConfidenceCount++;
}

const snapshot = {
  meta: {
    name: "Kernel Region Params Snapshot（内核区域参数快照）",
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/export-region-params.ts",
    /** 本快照倒出的是「内核此刻真实生效的默认层」，不是候选数据层（后者见 shanxi-v1.json）。 */
    purpose:
      "① 迁移到 Payload 的导入源；② 迁移前后逐位对比的基准；③ 占位参数规模的可数化证据。",
    /** 源文件版本号。迁移后若内核行为变化，这些版本号必须一同变化，否则说明漏改了。 */
    sourceVersions: {
      SANDBOX_PARAMS_VERSION,
      SANDBOX_REGIONS_VERSION,
      SANDBOX_REGION_FACTS_VERSION,
      regionCalcRef: regionCalcRef(),
      regionFactsCalcRef: regionFactsCalcRef(),
    },
    /** 诚实声明：本快照不含任何新增核实工作，只搬运既有值。 */
    disclaimer:
      "本快照原样倒出内核既有参数与溯源，未修正任何数值或置信度，未补充任何来源。除 region.demandCharge 外，山西各值仍为示例占位假设（confidence≤50 · ASSUMPTION），非经核事实。",
  },
  stats: {
    /** 参数目录规模（分母） */
    catalog,
    /** 地区包实际覆写条目（分子） */
    totalEntries: all.length,
    factEntries: factCount,
    placeholderEntries: placeholderCount,
    byEvidenceKind,
    byRegion,
    byDomain,
    placeholderByRegion,
  },
  clauseFacts: SHANXI_CLAUSE_FACTS.map((f) => ({ ...f })),
  packs,
};

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

/* ── 控制台摘要（人看的） ── */
console.log("内核区域参数快照已导出");
console.log("─".repeat(64));
console.log(`输出      : ${path.relative(process.cwd(), OUT_PATH)}`);
console.log(`源版本    : params=${SANDBOX_PARAMS_VERSION} regions=${SANDBOX_REGIONS_VERSION} facts=${SANDBOX_REGION_FACTS_VERSION}`);
console.log("");
console.log(`【参数目录】共 ${catalog.total} 个可调参数（这是"欠功课"的分母）`);
console.log(`  派生键 ${catalog.derivedCount} · 未启用 ${catalog.inactiveCount} · 不可改 ${catalog.notEditableCount} · 置信度≤50 者 ${catalog.lowConfidenceCount}`);
console.log("  按域：");
for (const [k, v] of Object.entries(catalog.byGroup).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(12)} ${String(v).padStart(3)}`);
}
console.log("  按曝光层：");
for (const [k, v] of Object.entries(catalog.byExposure).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(12)} ${String(v).padStart(3)}`);
}
console.log("");
console.log(`【地区覆写层】共 ${all.length} 条（这是实际已写进地区包的值）`);
console.log(`  FACT ${factCount} · 占位 ${placeholderCount}`);
console.log("  按地区：");
for (const [k, v] of Object.entries(byRegion).sort()) {
  const ph = placeholderByRegion[k] ?? 0;
  console.log(`    ${k.padEnd(12)} ${String(v).padStart(3)} 条（其中占位 ${ph}）`);
}
console.log("");
console.log(`【条款级 FACT 目录】${SHANXI_CLAUSE_FACTS.length} 条`);
console.log("");
console.log("提示：目录规模 ≠ 覆写规模。一个省「做完功课」指的是目录里那些参数");
console.log("      在该省的取值都已核实，而不是只做已被覆写的这几条。");
