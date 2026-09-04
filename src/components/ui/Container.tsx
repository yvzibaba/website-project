import { cn } from "@/lib/cn";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Container — 页面级最大宽度容器。
 *
 * 尺寸约定（对齐总控第 5 节 35 页面 + 第 6 节首页体验）：
 *   sm  表单/登录/详情页（max-w-md  ~28rem）
 *   md  文章/方案详情（max-w-3xl   ~48rem）
 *   lg  列表页/后台（max-w-6xl     ~72rem，与 layout.tsx 导航一致）
 *   xl  宽屏仪表盘（max-w-7xl      ~80rem）
 *   full 通栏（仅 padding）
 */

export type ContainerSize = "sm" | "md" | "lg" | "xl" | "full";

const SIZE_CLASSES: Record<ContainerSize, string> = {
  sm: "max-w-md",
  md: "max-w-3xl",
  lg: "max-w-6xl",
  xl: "max-w-7xl",
  full: "max-w-none",
};

export interface ContainerProps extends ComponentPropsWithoutRef<"div"> {
  size?: ContainerSize;
  /** 是否加标准横向 padding（px-4 sm:px-6）。默认 true。 */
  padded?: boolean;
}

export function Container({
  size = "lg",
  padded = true,
  className,
  ...rest
}: ContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full",
        SIZE_CLASSES[size],
        padded && "px-4 sm:px-6",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * Separator — 视觉分隔线（水平/垂直）。
 *
 * 可访问性：role="separator"，装饰性时 aria-hidden。
 */
export interface SeparatorProps extends ComponentPropsWithoutRef<"div"> {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}

export function Separator({
  orientation = "horizontal",
  decorative = true,
  className,
  ...rest
}: SeparatorProps) {
  return (
    <div
      role={decorative ? undefined : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      aria-hidden={decorative || undefined}
      className={cn(
        orientation === "horizontal"
          ? "h-px w-full bg-border"
          : "w-px self-stretch bg-border",
        className,
      )}
      {...rest}
    />
  );
}
