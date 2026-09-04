import { cn } from "@/lib/cn";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Skeleton — 加载占位骨架。
 *
 * 用法：
 *   <Skeleton className="h-4 w-32" />
 *   <Skeleton variant="circle" size={40} />
 *   <Skeleton variant="text" lines={3} />
 *
 * 可访问性：aria-hidden（屏幕阅读器忽略），配合外层 aria-busy / role="status" 使用。
 */

export type SkeletonVariant = "rect" | "circle" | "text";

export interface SkeletonProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  variant?: SkeletonVariant;
  /** circle 变体的直径（px）。 */
  size?: number;
  /** text 变体的行数。 */
  lines?: number;
}

export function Skeleton({
  variant = "rect",
  size,
  lines = 1,
  className,
  style,
  ...rest
}: SkeletonProps) {
  const base = "animate-pulse bg-muted rounded-md aria-hidden";

  if (variant === "circle") {
    const d = size ?? 32;
    return (
      <div
        aria-hidden
        className={cn(base, "rounded-full", className)}
        style={{ width: d, height: d, ...style }}
        {...rest}
      />
    );
  }

  if (variant === "text") {
    return (
      <div aria-hidden className={cn("flex flex-col gap-2", className)} style={style} {...rest}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={cn(
              base,
              "h-3",
              i === lines - 1 ? "w-3/4" : "w-full",
            )}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      aria-hidden
      className={cn(base, "h-4 w-full", className)}
      style={style}
      {...rest}
    />
  );
}

/**
 * Spinner — 旋转加载指示器（纯 CSS，无 SVG 依赖）。
 *
 * 用法：
 *   <Spinner />
 *   <Spinner size={24} label="加载中" />
 */
export interface SpinnerProps extends ComponentPropsWithoutRef<"span"> {
  size?: number;
  /** 屏幕阅读器播报文本（默认 "加载中"）。 */
  label?: string;
}

export function Spinner({
  size = 16,
  label = "加载中",
  className,
  style,
  ...rest
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-block align-middle", className)}
      style={style}
      {...rest}
    >
      <span
        aria-hidden
        className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
        style={{ width: size, height: size }}
      />
    </span>
  );
}
