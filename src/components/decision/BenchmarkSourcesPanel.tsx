/**
 * P2「数字点开看来源 / 置信度 / 生效区间」来源下钻面板。
 *
 * 把本次情景**实际引用到的那批基准参数**（`calc.benchmarkSnapshot`）逐条摊开：
 * 取值、单位、证据等级、置信度、生效区间、适用地区、来源描述，以及**可点开的原文链接**。
 * 这是只读展示——排序与诚实闸门在 `benchmark-source-model.ts` 里，本文件只负责把它画出来。
 *
 * 刻意不新造"数字→来源"的第二套真源：数据来自计算结果自带的快照，与页面上那批数一一对应。
 */

import type { BenchmarkRef } from "@app/kernel/engine/types";
import { EvidenceBadge, SimpleTable } from "./primitives";
import { toSourceRows } from "./benchmark-source-model";

export function BenchmarkSourcesPanel({
  snapshot,
  benchmarkVersion,
}: {
  snapshot: Record<string, BenchmarkRef> | null | undefined;
  benchmarkVersion?: string;
}) {
  const rows = toSourceRows(snapshot);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">本情景未引用带来源标注的基准参数。</p>;
  }

  const factCount = rows.filter((r) => r.evidenceKind === "FACT").length;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        本次计算实际用到的 <span className="font-medium text-foreground">{rows.length}</span> 项基准参数
        {benchmarkVersion ? <span className="text-foreground">（基准版本 {benchmarkVersion}）</span> : null}：已核实{" "}
        <span className="font-medium text-foreground">{factCount}</span> 项。标「已核实」且带原文链接的可点开核对；标
        「假设 / 未核实」的是占位口径，<span className="font-medium">不是权威数据</span>。
      </p>
      <SimpleTable
        columns={["参数", "取值", "单位", "性质", "置信度", "生效区间", "地区", "来源", "原文"]}
        align={["left", "right", "left", "left", "right", "left", "left", "left", "left"]}
        rows={rows.map((r) => [
          r.label,
          r.valueText,
          r.unit || "—",
          <EvidenceBadge key={`${r.key}-ev`} kind={r.evidenceKind} />,
          r.confidenceText,
          r.validWindow,
          r.regionText,
          <span key={`${r.key}-src`}>
            {r.source}
            {r.note ? <span className="mt-0.5 block text-xs text-muted-foreground">口径：{r.note}</span> : null}
          </span>,
          r.url ? (
            <a
              key={`${r.key}-lnk`}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 whitespace-nowrap text-primary underline-offset-2 hover:underline"
            >
              查看原文 ↗
            </a>
          ) : (
            <span key={`${r.key}-nolink`} className="text-muted-foreground">
              未附权威来源
            </span>
          ),
        ])}
      />
    </div>
  );
}
