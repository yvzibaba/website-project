import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

/**
 * PageHeader — 页面级标题区。
 *
 * 统一所有公共页面的标题/副标题/操作区排布，避免每页各写一套（宪法第 12 条标准化）。
 * Server Component 安全。
 *
 * 用法：
 *   <PageHeader title="行业" description="六大产业 + 其他" breadcrumb={<Breadcrumb .../>}>
 *     <Button>行动</Button>
 *   </PageHeader>
 */
export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** 标题上方的面包屑导航。 */
  breadcrumb?: ReactNode;
  /** 右侧/下方的操作区（按钮等）。 */
  children?: ReactNode;
  className?: string;
  /** 标题层级，默认 h1（每页应只有一个 h1，可及性要求）。 */
  as?: "h1" | "h2";
}

export function PageHeader({
  title,
  description,
  breadcrumb,
  children,
  className,
  as = "h1",
}: PageHeaderProps) {
  const Heading = as;
  return (
    <header className={cn("flex flex-col gap-3", className)}>
      {breadcrumb}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1.5 min-w-0">
          <Heading
            className={cn(
              "font-semibold tracking-tight text-foreground",
              as === "h1" ? "text-3xl" : "text-2xl",
            )}
          >
            {title}
          </Heading>
          {description ? (
            <p className="text-sm leading-6 text-muted-foreground max-w-2xl">
              {description}
            </p>
          ) : null}
        </div>
        {children ? (
          <div className="flex flex-wrap items-center gap-2 shrink-0">{children}</div>
        ) : null}
      </div>
    </header>
  );
}
