import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

/**
 * EmptyState — 空状态占位。
 *
 * V1-A 开发期数据库尚无内容（案例/方案由 Phase 9–10 的每日流水线自动填充），
 * 所有列表/详情页都需要一个诚实、 informative 的空态，而不是白屏或假数据
 * （宪法第 20 条：禁止虚构"已有内容"；总控第 44 节：禁止伪造完成）。
 *
 * 用法：
 *   <EmptyState
 *     title="该行业暂无已发布的深度案例"
 *     description="每日流水线（60 候选 → 20 重点 → 10 深度 → 3 方案 → 1 精品）将自动发现并填充。"
 *     action={<Button href="/about">了解我们如何工作</Button>}
 *   />
 */
export interface EmptyStateProps {
  /** 顶部图标（emoji 或单字符，aria-hidden）。默认 "📭"。 */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** 操作区（按钮/链接）。 */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon = "📭",
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border",
        "bg-muted/30 px-6 py-14 text-center",
        className,
      )}
    >
      {icon ? (
        <span aria-hidden className="text-3xl leading-none opacity-70">
          {icon}
        </span>
      ) : null}
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description ? (
        <p className="max-w-md text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
