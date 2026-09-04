import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Breadcrumb — 面包屑导航。
 *
 * 可及性：<nav aria-label="面包屑"> + 有序列表；当前页（最后一项）用 aria-current="page"
 * 且渲染为纯文本（不可点），符合 WAI-ARIA breadcrumb 模式。
 *
 * 用法：
 *   <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "行业", href: "/industries" }, { label: "新能源" }]} />
 */
export interface BreadcrumbItem {
  label: string;
  /** 不传 href 表示当前页（最后一项），渲染为不可点文本。 */
  href?: string;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="面包屑" className={cn("text-sm", className)}>
      <ol className="flex flex-wrap items-center gap-1 text-muted-foreground">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1">
              {item.href && !isLast ? (
                <Link href={item.href} className="hover:text-foreground hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? "page" : undefined} className="text-foreground">
                  {item.label}
                </span>
              )}
              {!isLast ? (
                <span aria-hidden className="opacity-50">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
