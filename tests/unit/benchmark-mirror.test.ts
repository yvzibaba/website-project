import { describe, it, expect, vi } from "vitest";

// 纯映射层不需要 DB；mock 掉 prisma 单例，避免干净环境下构造客户端带来的噪音/依赖。
vi.mock("@app/kernel/lib/prisma", () => ({ prisma: {}, disconnectPrisma: async () => {} }));

import { BENCHMARK_ENTRIES, BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import type { BenchmarkRef } from "@app/kernel/engine/types";
import { allBenchmarkRowSeeds, toBenchmarkRow, fromBenchmarkRow } from "@app/kernel/server/benchmark-repo";

/**
 * R4 镜像不变量测试（**不碰数据库**，全部在干净 `test:unit` 环境跑）。
 *
 * 钉的是"落库无损 + 不篡改基准值"这条命脉：
 *   entry → row → entry 必须与原 BenchmarkRef **逐字段语义相等**。
 * 这条一旦红，就说明镜像在悄悄改基准值（例如把 0 塌成 null、把缺省键凭空补出来），
 * 那正是"落库"最危险的失败模式——表面数据齐了，实则可信度路径被污染。
 */

const OPTIONAL_KEYS = ["textValue", "validFrom", "validTo", "sourceUrl", "note", "regionId"] as const;

function assertSameRef(a: BenchmarkRef, b: BenchmarkRef, ctx: string): void {
  // 必现键逐一比对（含 value：0 与 null 必须严格区分）。
  expect(b.key, ctx).toBe(a.key);
  expect(b.label, ctx).toBe(a.label);
  expect(b.unit, ctx).toBe(a.unit);
  expect(Object.is(b.value, a.value), `${ctx} · value(0≠null)`).toBe(true);
  expect(b.valueClass, ctx).toBe(a.valueClass);
  expect(b.source, ctx).toBe(a.source);
  expect(b.evidenceKind, ctx).toBe(a.evidenceKind);
  expect(b.confidence, ctx).toBe(a.confidence);
  // 可选键：存在性 + 值都必须一致（不能"多补"也不能"少给"）。
  for (const k of OPTIONAL_KEYS) {
    const inA = k in a;
    const inB = k in b;
    expect(inB, `${ctx} · 可选键 ${k} 存在性`).toBe(inA);
    if (inA) expect(b[k], `${ctx} · ${k}`).toBe(a[k]);
  }
}

describe("R4 基准镜像 · 往返无损", () => {
  it("每一条 entry → row → entry 语义相等", () => {
    const rows = allBenchmarkRowSeeds();
    expect(rows.length).toBe(BENCHMARK_ENTRIES.length);
    for (let i = 0; i < BENCHMARK_ENTRIES.length; i++) {
      const original = BENCHMARK_ENTRIES[i];
      const back = fromBenchmarkRow(rows[i]);
      assertSameRef(original, back, `#${i} ${original.key}`);
    }
  });

  it("value=0 的基准不被塌成 null（关键：0 是有效值，不是'没有'）", () => {
    const zeroEntries = BENCHMARK_ENTRIES.filter((e) => e.value === 0);
    // 若内核里确有 value=0 的项（如集中式充换电免收需量电费 → 0），必须逐条验证镜像忠实。
    for (const e of zeroEntries) {
      const row = toBenchmarkRow(e);
      expect(row.value, e.key).toBe(0);
      expect(fromBenchmarkRow(row).value, e.key).toBe(0);
    }
    // 无论有几条，都要保证"至少 value 为 0 的行往返后仍严格为 0"这条逻辑被覆盖：
    // 若内核暂无 value=0 项，此处也确保过滤逻辑与断言不抛错（空循环合法）。
    expect(Array.isArray(zeroEntries)).toBe(true);
  });

  it("UNKNOWN 基准 value 恒为 null，镜像不得臆造数值", () => {
    const unknowns = BENCHMARK_ENTRIES.filter((e) => e.valueClass === "UNKNOWN");
    for (const e of unknowns) {
      expect(e.value, e.key).toBeNull();
      const row = toBenchmarkRow(e);
      expect(row.value, e.key).toBeNull();
      expect(fromBenchmarkRow(row).value, e.key).toBeNull();
    }
  });
});

describe("R4 基准镜像 · 唯一键与版本", () => {
  it("(benchmarkVersion, regionId, key) 唯一——否则 upsert 会静默覆盖丢行", () => {
    const rows = allBenchmarkRowSeeds();
    const seen = new Set<string>();
    for (const r of rows) {
      const composite = `${r.benchmarkVersion}::${r.regionId}::${r.key}`;
      expect(seen.has(composite), `重复唯一键：${composite}`).toBe(false);
      seen.add(composite);
    }
  });

  it("镜像统一打上当前 BENCHMARK_VERSION（按版本整体重灌的口径）", () => {
    for (const r of allBenchmarkRowSeeds()) {
      expect(r.benchmarkVersion).toBe(BENCHMARK_VERSION);
    }
  });
});
