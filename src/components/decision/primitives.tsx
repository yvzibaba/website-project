"use client";

/**
 * V2 决策平台的**通用小件**：数值格式化与状态徽章。
 *
 * 为什么单独抽出来：整套界面有 20+ 处要展示「元 / kWh / % / 年」，若每处各写一遍四舍五入，
 * 迟早会出现同一个数在两个位置显示成两个样子（一个 1,095,960、一个 109.6 万）。
 * 这里统一口径，且**空值一律显示为「—」而不是 0**——没算出来和算出来是 0 是两件事，
 * 用 0 顶替会让读者以为结论是「收益为零」。
 */

import type { ReactNode } from "react";
import { Badge } from "@/components/ui";

export function fmtMoney(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `¥${v.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 金额的万/亿简写（用于卡片主数字，避免一长串数字挤爆版面）。 */
export function fmtMoneyShort(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `¥${(v / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `¥${(v / 1e4).toFixed(1)} 万`;
  return fmtMoney(v, 0);
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function fmtYears(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(2)} 年`;
}

/** 关键指标卡片（标签 + 主值 + 可选副说明）。 */
export function MetricCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "bad" | "muted";
}) {
  const toneClass =
    tone === "good"
      ? "text-success"
      : tone === "bad"
        ? "text-danger"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** 计算状态徽章：把后端的 calcStatus 翻译成一句人话 + 合适的颜色。 */
export function CalcStatusBadge({ status }: { status: string | null | undefined }) {
  const map: Record<string, { text: string; variant: "success" | "warning" | "danger" | "neutral" }> = {
    ok: { text: "已算通", variant: "success" },
    pending: { text: "还没算", variant: "neutral" },
    invalid_input: { text: "输入有误", variant: "warning" },
    tech_error: { text: "校验未通过", variant: "danger" },
    error: { text: "计算失败", variant: "danger" },
  };
  const hit = map[status ?? "pending"] ?? { text: status ?? "未知状态", variant: "neutral" as const };
  return <Badge variant={hit.variant}>{hit.text}</Badge>;
}

/** 证据等级徽章（基准参数的来源可信度）。 */
export function EvidenceBadge({ kind }: { kind: string }) {
  const map: Record<string, { text: string; variant: "success" | "info" | "warning" | "danger" | "neutral" }> = {
    FACT: { text: "已核实", variant: "success" },
    ASSUMPTION: { text: "假设", variant: "info" },
    ESTIMATE: { text: "估算", variant: "warning" },
    UNKNOWN: { text: "未核实", variant: "danger" },
  };
  const hit = map[kind] ?? { text: kind, variant: "neutral" as const };
  return <Badge variant={hit.variant}>{hit.text}</Badge>;
}

/** 简易表格（九段式里多处使用，统一边框与对齐）。 */
export function SimpleTable({
  columns,
  rows,
  align = [],
}: {
  columns: string[];
  rows: Array<Array<ReactNode>>;
  align?: Array<"left" | "right">;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted/50">
          <tr>
            {columns.map((c) => (
              <th key={c} className="border-b border-border px-3 py-2 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="odd:bg-background even:bg-muted/20">
              {r.map((cell, j) => (
                <td
                  key={j}
                  className={`border-b border-border px-3 py-2 ${
                    (align[j] ?? "left") === "right" ? "text-right tabular-nums" : "text-left"
                  }`}
                >
                  {cell == null || cell === "" ? "—" : cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-muted-foreground">
                暂无数据
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** 九段式里每一段的容器（统一编号与标题样式）。 */
export function Section({
  index,
  title,
  description,
  children,
}: {
  index: number;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={`sec-${index}`} className="scroll-mt-24">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {index}
        </span>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {description ? <p className="mb-3 text-sm text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  );
}
