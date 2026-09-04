import { cn } from "@/lib/cn";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Badge — 状态/标签/评分徽章。
 *
 * 变体语义对齐业务（总控第 10/11 节 案例评分体系 + 证据等级体系）：
 *   neutral   默认/未分类
 *   primary   品牌强调（如"今日推荐"）
 *   success   通过/已验证/已发布（证据等级 A、方案已审核）
 *   warning   待审核/存疑（证据等级 C、需要人工确认）
 *   danger    驳回/高风险（证据等级 D、许可证冲突）
 *   info      信息性标签（行业、地区、技术栈）
 *   outline   纯边框（次级标签、元数据）
 */

export type BadgeVariant =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "outline";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary text-primary-foreground",
  success: "bg-success text-success-foreground",
  warning: "bg-warning text-warning-foreground",
  danger: "bg-danger text-danger-foreground",
  info: "bg-info text-info-foreground",
  outline: "border border-border text-foreground bg-transparent",
};

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  variant?: BadgeVariant;
  /** 紧凑模式：更小内边距，用于表格/密集列表。 */
  compact?: boolean;
}

export function Badge({
  variant = "neutral",
  compact = false,
  className,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-medium rounded-full whitespace-nowrap",
        compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-xs",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    />
  );
}
