"use server";

import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { registerUser } from "@/server/users";
import type { AuthFormState } from "@/components/auth/types";

/**
 * 注册 Server Action（配合 useActionState）。
 *
 * 流程：校验 + 建号（src/server/users.ts，scrypt 哈希）→ 成功后自动登录并跳转 /account。
 * 失败态映射为字段级错误（校验 / 邮箱已存在）或顶层错误（DB 异常），提示对用户友好且不泄露内部细节。
 */
export async function register(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const password = String(formData.get("password") ?? "");

  const result = await registerUser({
    email: formData.get("email"),
    name: formData.get("name"),
    password,
  });

  switch (result.status) {
    case "invalid":
      return { fieldErrors: result.fieldErrors };
    case "email_taken":
      return { fieldErrors: { email: ["该邮箱已被注册，请直接登录"] } };
    case "weak_password":
      return { fieldErrors: { password: ["密码过长，请缩短后重试"] } };
    case "error":
      return { error: "注册失败，请稍后重试" };
    case "created": {
      try {
        await signIn("credentials", {
          email: result.email,
          password,
          redirectTo: "/account",
        });
      } catch (err) {
        if (err instanceof AuthError) {
          // 极少见：建号成功但自动登录失败——引导用户手动登录，不重复建号。
          return { error: "注册成功，请前往登录" };
        }
        throw err; // NEXT_REDIRECT 冒泡完成跳转
      }
      return {};
    }
  }
}
