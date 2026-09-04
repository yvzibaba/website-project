import { cn } from "@/lib/cn";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Button — 基础按钮组件。
 *
 * 设计取舍（宪法第 4/5 条）：
 *   - 不引入 Radix Slot / shadcn 全套，用极简 polymorphic：传 href 渲染 <a>，否则渲染 <button>。
 *   - 所有样式走设计 tokens（globals.css），不硬编码颜色。
 *   - Server Component 安全（无 "use client"），onClick 由调用方按需加。
 *
 * 变体语义：
 *   primary   主行动（购买、提交、发布）
 *   secondary 次行动（取消、返回）
 *   ghost     无边框、悬停才显（工具栏、导航）
 *   danger    破坏性操作（删除、撤销）— 宪法第 21 条要求危险操作必须有视觉区分
 *   link      纯文字链接样式
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "link";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm disabled:bg-primary/50",
  secondary:
    "bg-muted text-foreground border border-border hover:bg-muted/80 disabled:opacity-50",
  ghost: "bg-transparent text-foreground hover:bg-muted disabled:opacity-50",
  danger:
    "bg-danger text-danger-foreground hover:bg-danger/90 shadow-sm disabled:bg-danger/50",
  link: "bg-transparent text-primary underline-offset-4 hover:underline disabled:opacity-50",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs rounded-md gap-1.5",
  md: "h-10 px-4 text-sm rounded-md gap-2",
  lg: "h-12 px-6 text-base rounded-lg gap-2.5",
  icon: "h-10 w-10 rounded-md",
};

const BASE_CLASSES =
  "inline-flex items-center justify-center font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export interface ButtonBaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** 加载态时替换 children 左侧的 spinner 文本（默认 "…"）。 */
  loadingText?: string;
  className?: string;
  children?: ReactNode;
}

export type ButtonAsButton = ButtonBaseProps &
  Omit<ComponentPropsWithoutRef<"button">, keyof ButtonBaseProps> & {
    href?: undefined;
  };

export type ButtonAsAnchor = ButtonBaseProps &
  Omit<ComponentPropsWithoutRef<"a">, keyof ButtonBaseProps> & {
    href: string;
  };

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    loading = false,
    loadingText,
    className,
    children,
    ...rest
  } = props;

  const classes = cn(
    BASE_CLASSES,
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  );

  const content = (
    <>
      {loading ? (
        <span aria-hidden className="inline-block animate-pulse">
          {loadingText ?? "…"}
        </span>
      ) : null}
      {children}
    </>
  );

  if (typeof (rest as ButtonAsAnchor).href === "string") {
    const { href, ...anchorRest } = rest as ButtonAsAnchor;
    return (
      <a
        href={href}
        className={classes}
        aria-busy={loading || undefined}
        {...anchorRest}
      >
        {content}
      </a>
    );
  }

  const { disabled, ...buttonRest } = rest as ButtonAsButton;
  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...buttonRest}
    >
      {content}
    </button>
  );
}
