import { handlers } from "@/auth";

/**
 * Auth.js v5 catch-all 路由处理器（/api/auth/*）。
 * 由 src/auth.ts 的 NextAuth() 生成 GET/POST，处理 signin/signout/session/csrf/callback 等。
 */
export const { GET, POST } = handlers;
