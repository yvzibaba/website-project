/**
 * 页面级布局组件 barrel export。
 *
 * 与 @/components/ui（原子组件）区分：这里是页面骨架级组合件。
 * 用法：import { PageHeader, EmptyState, Breadcrumb } from "@/components/page";
 */

export { PageHeader } from "./PageHeader";
export type { PageHeaderProps } from "./PageHeader";

export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export { Breadcrumb } from "./Breadcrumb";
export type { BreadcrumbItem, BreadcrumbProps } from "./Breadcrumb";
