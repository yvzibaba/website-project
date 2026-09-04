import { cn } from "@/lib/cn";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Alert — 页内提示条（非弹窗）。
 *
 * 变体语义：
 *   info     中性信息（默认）
 *   success  操作成功（保存完成、审核通过）
 *   warning  需要人工确认（宪法第 21 条：高风险领域须标注"需要专业人工确认"）
 *   danger   错误/危险（删除失败、许可证冲突）
 *
 * 可访问性：role="alert" 让屏幕阅读器立即播报；role="status" 用于非紧急更新。
 */

export type AlertVariant = "info" | "success" | "warning" | "danger";

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  info: "border-info/30 bg-info/10 text-info",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

const ICON_BY_VARIANT: Record<AlertVariant, string> = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  danger: "✕",
};

export interface AlertProps extends Omit<ComponentPropsWithoutRef<"div">, "title" | "children"> {
  variant?: AlertVariant;
  title?: ReactNode;
  children?: ReactNode;
  /** 是否显示左侧图标（默认 true）。 */
  icon?: boolean;
  /** role="alert"（紧急，立即播报）或 "status"（非紧急）。默认 alert。 */
  politeness?: "alert" | "status";
}

export function Alert({
  variant = "info",
  title,
  children,
  icon = true,
  politeness = "alert",
  className,
  ...rest
}: AlertProps) {
  return (
    <div
      role={politeness}
      className={cn(
        "flex items-start gap-3 rounded-md border p-3 text-sm",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden className="text-base leading-5 shrink-0">
          {ICON_BY_VARIANT[variant]}
        </span>
      ) : null}
      <div className="flex flex-col gap-1 min-w-0">
        {title ? <strong className="font-semibold">{title}</strong> : null}
        {children ? <div className="text-foreground/90">{children}</div> : null}
      </div>
    </div>
  );
}
