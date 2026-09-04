import { cn } from "@/lib/cn";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Card — 内容容器卡片。
 *
 * 用法：
 *   <Card>
 *     <CardHeader><CardTitle>标题</CardTitle><CardDescription>副标题</CardDescription></CardHeader>
 *     <CardContent>正文</CardContent>
 *     <CardFooter><Button>行动</Button></CardFooter>
 *   </Card>
 *
 * 所有子组件都是纯样式包装，Server Component 安全。
 */

export interface CardProps extends ComponentPropsWithoutRef<"div"> {
  /** 是否可交互（悬停时加阴影 + 边框高亮）。 */
  interactive?: boolean;
}

export function Card({ className, interactive = false, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-background shadow-sm",
        interactive &&
          "transition-shadow hover:shadow-md hover:border-ring cursor-pointer",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  className,
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 p-5 pb-3", className)}
      {...rest}
    />
  );
}

export function CardTitle({
  className,
  ...rest
}: ComponentPropsWithoutRef<"h3">) {
  return (
    <h3
      className={cn("text-base font-semibold tracking-tight", className)}
      {...rest}
    />
  );
}

export function CardDescription({
  className,
  ...rest
}: ComponentPropsWithoutRef<"p">) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)} {...rest} />
  );
}

export function CardContent({
  className,
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("p-5 pt-0", className)} {...rest} />;
}

export function CardFooter({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"div"> & { children?: ReactNode }) {
  return (
    <div
      className={cn("flex items-center gap-2 p-5 pt-0", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
