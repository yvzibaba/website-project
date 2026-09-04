/**
 * UI 组件库 barrel export。
 *
 * 用法：import { Button, Card, Badge } from "@/components/ui";
 *
 * Phase 4 里程碑 3 范围（宪法第 4 条 MVP 优先）：
 *   只放 V1-A 闭环真正会用到的基础件；复杂组件（Dialog/Dropdown/Toast/DatePicker/
 *   Table 排序分页等）留到 Phase 5+ 真正需要时再加，避免提前做复杂 UI（宪法第 22 条）。
 */

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./Card";
export type { CardProps } from "./Card";

export { Badge } from "./Badge";
export type { BadgeProps, BadgeVariant } from "./Badge";

export { Input, Textarea, Label, FieldError, Field } from "./Input";
export type { InputProps, TextareaProps, LabelProps, FieldProps } from "./Input";

export { Alert } from "./Alert";
export type { AlertProps, AlertVariant } from "./Alert";

export { Skeleton, Spinner } from "./Skeleton";
export type { SkeletonProps, SkeletonVariant, SpinnerProps } from "./Skeleton";

export { Container, Separator } from "./Container";
export type { ContainerProps, ContainerSize, SeparatorProps } from "./Container";
