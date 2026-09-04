"use server";

import { signOut } from "@/auth";

/** 登出 Server Action：清除 JWT 会话 cookie 并回首页。 */
export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
