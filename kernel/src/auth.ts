import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getAuthUserByEmail } from "@/server/users";
import { verifyPassword } from "@/lib/password";
import { LoginInputSchema, type UserRole } from "@/lib/validation";

/**
 * Auth.js v5（next-auth@beta）配置（Phase 6 M1）。
 *
 * 选型（总控第 21 节"认证尽可能用成熟现成方案" + 创始人裁决"Auth.js 自建"）：
 *   - Credentials（邮箱 + 密码）+ JWT 会话：V1-A 只需"下单身份"的最小登录，
 *     不需要 OAuth/魔法链接（后者要引入 nodemailer/Resend 邮件通道 = 额外依赖与成本，
 *     宪法第 2/4 条 MVP 优先，延后）。用户表留在自己的 Neon 库，零厂商锁定。
 *   - 不挂 Prisma Adapter：Credentials + JWT 不需要 Account/Session/VerificationToken 表，
 *     User 表由 src/server/users.ts 直接管理，依赖更少。
 *
 * 安全（SECURITY §1 / 宪法第 11 条）：
 *   - 口令用 scrypt 校验（src/lib/password.ts），失败一律返回 null → Auth.js 抛 CredentialsSignin，
 *     登录页对"账号不存在"与"密码错误"给同一提示，防用户枚举。
 *   - 需要 AUTH_SECRET（.env，gitignored）签发/校验 JWT；生产缺失 Auth.js 直接报错。
 *   - session 只暴露 id/email/name/role，绝不含 passwordHash。
 */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      role: UserRole;
    };
  }
  interface User {
    role?: UserRole;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    role?: UserRole;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login", error: "/login" },
  // 部署在反向代理/自定义 host（含本机 next start -p 冒烟）后不报 UntrustedHost。
  trustHost: true,
  providers: [
    Credentials({
      name: "邮箱密码",
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" },
      },
      async authorize(credentials) {
        const parsed = LoginInputSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const user = await getAuthUserByEmail(email);
        if (!user) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      // 仅在登录那一刻 user 有值：把稳定的 id/role 写进 JWT。
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: UserRole }).role ?? "USER";
      }
      return token;
    },
    session({ session, token }) {
      if (token.id) session.user.id = token.id;
      if (token.role) session.user.role = token.role;
      return session;
    },
  },
});
