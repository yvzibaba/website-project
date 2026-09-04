import { cn } from "@/lib/cn";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * Input — 单行文本输入框。
 *
 * 设计：
 *   - 受控/非受控都支持（调用方决定传 value 还是 defaultValue）。
 *   - invalid 态走 aria-invalid + 红色边框，配合 <FieldError> 使用。
 *   - Server Component 安全；onChange 由调用方按需加（需 "use client" 的表单自己包）。
 */

export interface InputProps extends ComponentPropsWithoutRef<"input"> {
  invalid?: boolean;
}

export function Input({ className, invalid, type = "text", ...rest }: InputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-60",
        invalid && "border-danger focus-visible:outline-danger",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * Textarea — 多行文本输入框。
 */
export interface TextareaProps extends ComponentPropsWithoutRef<"textarea"> {
  invalid?: boolean;
}

export function Textarea({ className, invalid, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "placeholder:text-muted-foreground resize-y",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-60",
        invalid && "border-danger focus-visible:outline-danger",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * Label — 表单标签，自动关联 htmlFor。
 */
export interface LabelProps extends ComponentPropsWithoutRef<"label"> {
  required?: boolean;
}

export function Label({ className, required, children, ...rest }: LabelProps) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none flex items-center gap-1",
        className,
      )}
      {...rest}
    >
      {children}
      {required ? (
        <span aria-hidden className="text-danger">
          *
        </span>
      ) : null}
    </label>
  );
}

/**
 * FieldError — 表单字段错误提示，配合 aria-describedby 使用。
 *
 * 调用方需自行把 id 传给控件的 aria-describedby，例如：
 *   <Field label="邮箱" htmlFor="email" error="格式错误">
 *     <Input id="email" aria-describedby="email-error" invalid />
 *   </Field>
 */
export function FieldError({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      id={id}
      role="alert"
      className={cn("text-xs text-danger mt-1", className)}
    >
      {children}
    </p>
  );
}

/**
 * Field — 表单字段容器：Label + 控件 + 错误/帮助文本。
 *
 * 用法：
 *   <Field label="邮箱" htmlFor="email" required error={errors.email}>
 *     <Input id="email" type="email" aria-describedby={errors.email ? "email-error" : undefined} invalid={!!errors.email} />
 *   </Field>
 *
 * 错误元素 id 约定为 `${htmlFor}-error`，帮助文本 id 约定为 `${htmlFor}-help`。
 */
export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  error?: ReactNode;
  help?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  htmlFor,
  required,
  error,
  help,
  className,
  children,
}: FieldProps) {
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  const helpId = htmlFor ? `${htmlFor}-help` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      {help && !error ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
}
