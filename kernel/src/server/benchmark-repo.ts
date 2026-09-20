/**
 * 基准参数层的**落库 / 读取层**（R4 · M9）。
 *
 * ## 这里的"落库"是"无损镜像"，不是"计算真源"
 *
 * 引擎在计算时仍从内核常量 `BENCHMARK_ENTRIES` 取基准（铁律①：内核不碰 DB），
 * 所以黄金基线逐字节不变。本模块把同一批基准**忠实地投影**进 Prisma 表，供：
 *   - P2「数字点开看来源 / 置信度 / 生效区间」的读取；
 *   - 治理与审计（结构化、可查询、可比对）；
 *   - 未来若要真正切库到计算，这是一份"已与内核等价"的候选源——但**切换本身是财务口径
 *     变更，须创始人裁决 + 升版本 + 重录黄金**，不在本层擅自发生。
 *
 * ## 两条硬性质（都有单测钉死）
 *
 * 1. **派生自内核，绝不手抄**：`allBenchmarkRowSeeds()` 唯一的数据来源是 `BENCHMARK_ENTRIES`。
 *    seed 脚本、UI、审计都从这同一条管线走，杜绝"库里一套、内核一套"。
 * 2. **往返无损**：`entry → row → entry` 必须与原 `BenchmarkRef` **逐字段语义相等**
 *    （`0` 仍是 `0`、`null` 仍是 `null`、缺省键仍缺省、`textValue`/`note` 等的"仅在真值时出现"
 *    约定与内核 `entry()` 完全对齐）。这条不变量一旦破，就说明镜像在悄悄改变基准值。
 */

import { prisma } from "@app/kernel/lib/prisma";
import { BENCHMARK_ENTRIES, BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import type { BenchmarkRef, ValueClass } from "@app/kernel/engine/types";

/** 落库行 DTO（字段与 Prisma `BenchmarkEntry` 一一对应；不依赖生成类型，便于纯净单测）。 */
export interface BenchmarkRowInput {
  benchmarkVersion: string;
  regionId: string; // "" = 全局/无地区（与唯一键约定一致）
  key: string;
  label: string;
  unit: string;
  value: number | null;
  textValue: string | null;
  valueClass: string;
  evidenceKind: string;
  confidence: number;
  source: string;
  sourceUrl: string | null;
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
}

/** 从数据库读回来的行（比写入 DTO 多 id/时间戳；读取层据此再还原成 BenchmarkRef）。 */
export interface BenchmarkRowRecord extends BenchmarkRowInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 一条内核基准 → 一行落库 DTO。**这是镜像唯一的构造点**，纯函数、无 DB。
 * 刻意集中在此：任何"内核字段 → 列"的映射规则只写一遍，读回时反向对齐。
 */
export function toBenchmarkRow(entry: BenchmarkRef, benchmarkVersion = BENCHMARK_VERSION): BenchmarkRowInput {
  return {
    benchmarkVersion,
    regionId: entry.regionId ?? "",
    key: entry.key,
    label: entry.label,
    unit: entry.unit,
    // value 原样（含 0）；只有 null 才是 null——绝不做 `value || null` 之类的 falsy 塌缩。
    value: entry.value,
    textValue: entry.textValue ?? null,
    valueClass: entry.valueClass,
    evidenceKind: entry.evidenceKind,
    confidence: entry.confidence,
    source: entry.source,
    sourceUrl: entry.sourceUrl ?? null,
    validFrom: entry.validFrom ?? null,
    validTo: entry.validTo ?? null,
    note: entry.note ?? null,
  };
}

/**
 * 一行落库 DTO / 记录 → 内核 `BenchmarkRef`。
 * 与内核 `entry()` 的"可选键仅在真值时出现"约定严格对齐，保证往返语义相等。
 */
export function fromBenchmarkRow(row: BenchmarkRowInput): BenchmarkRef {
  const out: BenchmarkRef = {
    key: row.key,
    label: row.label,
    unit: row.unit,
    value: row.value,
    valueClass: row.valueClass as ValueClass,
    source: row.source,
    evidenceKind: row.evidenceKind,
    confidence: row.confidence,
  };
  if (row.textValue) out.textValue = row.textValue;
  if (row.validFrom) out.validFrom = row.validFrom;
  if (row.validTo) out.validTo = row.validTo;
  if (row.sourceUrl) out.sourceUrl = row.sourceUrl;
  if (row.note) out.note = row.note;
  if (row.regionId) out.regionId = row.regionId;
  return out;
}

/** 由内核注册表派生的全量落库行（seed 与"无损性"校验共用同一条管线）。 */
export function allBenchmarkRowSeeds(benchmarkVersion = BENCHMARK_VERSION): BenchmarkRowInput[] {
  return BENCHMARK_ENTRIES.map((e) => toBenchmarkRow(e, benchmarkVersion));
}

/**
 * 把当前版本的全量基准镜像灌入库（按 `(benchmarkVersion, regionId, key)` upsert）。
 * 幂等：重复跑只更新不新增。返回写入条数。
 */
export async function seedBenchmarkRows(version = BENCHMARK_VERSION): Promise<number> {
  const rows = allBenchmarkRowSeeds(version);
  for (const r of rows) {
    await prisma.benchmarkEntry.upsert({
      where: {
        benchmarkVersion_regionId_key: {
          benchmarkVersion: r.benchmarkVersion,
          regionId: r.regionId,
          key: r.key,
        },
      },
      create: r,
      update: {
        label: r.label,
        unit: r.unit,
        value: r.value,
        textValue: r.textValue,
        valueClass: r.valueClass,
        evidenceKind: r.evidenceKind,
        confidence: r.confidence,
        source: r.source,
        sourceUrl: r.sourceUrl,
        validFrom: r.validFrom,
        validTo: r.validTo,
        note: r.note,
      },
    });
  }
  return rows.length;
}

/**
 * 读取某版本的基准镜像（供 P2 溯源面板 / 审计）。
 * `regionId` 传入时附带该地区命中项；缺省只回全局项。返回行按 key 字典序，稳定可缓存。
 */
export async function listBenchmarkEntries(input: {
  version?: string;
  regionId?: string;
}): Promise<BenchmarkRowRecord[]> {
  const version = input.version ?? BENCHMARK_VERSION;
  const where: Record<string, unknown> = { benchmarkVersion: version };
  if (input.regionId) {
    where.OR = [{ regionId: input.regionId }, { regionId: "" }];
  } else {
    where.regionId = "";
  }
  const rows = await prisma.benchmarkEntry.findMany({ where, orderBy: { key: "asc" } });
  return rows as unknown as BenchmarkRowRecord[];
}
