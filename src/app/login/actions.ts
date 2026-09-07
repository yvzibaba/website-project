"use server";

import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { LoginInputSchema } from "@/lib/validation";
import { sanitizeCallbackUrl } from "@/lib/redirect-safety";
import type { AuthFormState } from "@/components/auth/types";

/**
 * 登录 Server Action（配合 useActionState）。
 *
 * 安全：
 *   - 登录失败（账号不存在 / 密码错 / 格式非法）一律返回同一句"邮箱或密码不正确"，
 *     不区分具体原因，防止用户枚举（SECURITY §1 / 宪法第 11 条）。
 *   - `signIn` 成功且带 `redirectTo` 时内部会调用 `redirect()` 抛出 NEXT_REDIRECT，
 *     须向上冒泡以完成跳转。
 *
 * 决策1.5 回跳：从 hidden form 字段 `callbackUrl` 取目标路径，**再走一次 `sanitizeCallbackUrl`**
 *   白名单清洗——即便攻击者绕过前端直接 POST action 端点带任意串，也会被压回 `/account`。
 *   与 `src/app/login/page.tsx` 用同一份清洗函数、同一份白名单，防两处漂移。
 */
export async function login(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = LoginInputSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "邮箱或密码不正确" };
  }
  // 二次清洗：formData 里的 callbackUrl 由客户端 hidden input 携带，视为不可信；fallback 仍是 /account。
  const rawCb = formData.get("callbackUrl");
  const redirectTo = sanitizeCallbackUrl(typeof rawCb === "string" ? rawCb : null);

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "邮箱或密码不正确" };
    }
    // NEXT_REDIRECT / 其它框架级错误：冒泡交由 Next 处理（完成跳转）。
    throw err;
  }

  return {};
}
