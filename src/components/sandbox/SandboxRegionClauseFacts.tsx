"use client";

/**
 * 沙盘「地区已核实政策条款（FACT）」展示条（阶段3A · 纯展示、零计算）。
 *
 * 为什么存在（§16 事实与假设区分 / §20 诚实绝不虚构来源 / 阶段3A 指令二）：
 *   阶段2 核实到的高可信山西数据以**条款级 FACT** 激活（`SHANXI_CLAUSE_FACTS`，全部经
 *   `makeVerifiedFact` 管道、带可点击权威原文）。本组件把它们展示在**地区选择器旁**——用户选了山西
 *   就能看到「哪些官方条款是真的、可点开核验」，同时一眼读到诚实边界：
 *   **条款是 FACT ≠ 沙盘数值是 FACT**——相关参数取值仍是占位假设（ASSUMPTION·置信≤50），
 *   已知口径冲突（DATA_CONFLICT）原样保留、禁折算/禁改公式。
 *
 * 边界：本组件只渲染目录已有内容，不做任何计算/网络请求；未知地区 / 空目录渲染 null（不占版面）。
 */

import { Badge } from "@/components/ui";
import { getRegionClauseFacts } from "@/server/sandbox-region-facts";

export function SandboxRegionClauseFacts({ regionId }: { regionId: string }) {
  const facts = getRegionClauseFacts(regionId);
  if (facts.length === 0) return null;

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px] text-emerald-700">
          已核实政策条款 · FACT
        </Badge>
        <span className="text-[11px] leading-snug text-zinc-600">
          以下条款经权威原文核验、可点击溯源；沙盘中相关数值仍为占位假设，条款≠数值。
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {facts.map((f) => (
          <li key={f.id} className="rounded-md border border-emerald-200 bg-white px-2.5 py-2">
            <div className="text-xs font-medium leading-snug text-zinc-800">
              {f.docNo ? <span className="mr-1">{f.docNo}</span> : null}
              {f.title}
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">
              {f.publisher}
              {f.publishedOn ? ` · ${f.publishedOn} 印发` : ""} · {f.effectiveText}
              {f.meta?.confidence != null ? ` · 置信 ${f.meta.confidence}` : ""}
            </div>
            {f.meta?.sourceUrl ? (
              <a
                href={f.meta.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-[11px] text-blue-600 underline underline-offset-2"
              >
                查看原文 ↗
              </a>
            ) : null}
            {f.relatedKeys.length ? (
              <div className="mt-1 text-[10px] leading-snug text-zinc-400">
                关联参数：{f.relatedKeys.join("、")}（取值仍为 ASSUMPTION）
              </div>
            ) : null}
            {f.dataConflict ? (
              <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-[10px] leading-snug text-amber-800">
                {f.dataConflict.description}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
