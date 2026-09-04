"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button, Input, Field, Alert } from "@/components/ui";
import type { AuthFormState } from "./types";

/**
 * 登录 / 注册复用的表单（client 组件，配合 server action + useActionState）。
 *
 * V1-A 说明（宪法第 2/4 条 MVP）：使用 server action，需浏览器 JS。纯 HTML 无 JS 的回退
 * 留到真正需要时再补；当前登录/注册是低频且现代浏览器场景，不提前做复杂降级。
 */
interface AuthFormProps {
  action: (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  mode: "login" | "register";
  submitLabel: string;
  pendingLabel: string;
}

export function AuthForm({ action, mode, submitLabel, pendingLabel }: AuthFormProps) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(action, {});
  const fe = state.fieldErrors ?? {};
  const isRegister = mode === "register";

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.error ? (
        <Alert variant="danger" title={isRegister ? "注册失败" : "登录失败"}>
          {state.error}
        </Alert>
      ) : null}

      {isRegister ? (
        <Field label="昵称（可选）" htmlFor="name" error={fe.name?.[0]}>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="nickname"
            placeholder="怎么称呼你"
            maxLength={50}
            invalid={!!fe.name}
            aria-describedby={fe.name ? "name-error" : undefined}
          />
        </Field>
      ) : null}

      <Field label="邮箱" htmlFor="email" required error={fe.email?.[0]}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          maxLength={254}
          invalid={!!fe.email}
          aria-describedby={fe.email ? "email-error" : undefined}
        />
      </Field>

      <Field
        label="密码"
        htmlFor="password"
        required
        error={fe.password?.[0]}
        help={isRegister ? "至少 8 位。我们只保存加盐哈希，绝不存明文。" : undefined}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={isRegister ? "new-password" : "current-password"}
          required
          placeholder="••••••••"
          minLength={isRegister ? 8 : undefined}
          maxLength={128}
          invalid={!!fe.password}
          aria-describedby={fe.password ? "password-error" : undefined}
        />
      </Field>

      <Button type="submit" variant="primary" loading={pending} loadingText={pendingLabel}>
        {submitLabel}
      </Button>

      <p className="text-sm text-muted-foreground">
        {isRegister ? (
          <>
            已有账号？{" "}
            <Link href="/login" className="text-primary hover:underline">
              登录
            </Link>
          </>
        ) : (
          <>
            还没有账号？{" "}
            <Link href="/register" className="text-primary hover:underline">
              注册
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
