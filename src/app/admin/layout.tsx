import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Container, Badge, Alert } from "@/components/ui";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin 门禁布局（Phase 6 M2，总控 §13「后台必须有权限控制」）。
 *
 * 整段 /admin 子树共用此布局做**服务端**授权（客户端隐藏链接不是安全边界，真正的门在这里）：
 *   - 无会话 → redirect("/login")（登录后回到 /admin）；
 *   - 已登录但角色不在 STAFF_ROLES（审核员/管理员）→ 渲染「无访问权限」面板并**不渲染 children**
 *     （即受保护的后台数据根本不参与渲染，而非靠前端 CSS 藏起来）；
 *   - 授权通过 → 渲染后台顶栏 + children。
 *
 * 用 forbidden 面板而非 302 回首页：让越权者明确看到「权限不足」，也便于 HTTP 冒烟断言分支。
 * force-dynamic：依赖会话 cookie；noindex：后台绝不入搜索引擎。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台",
  robots: { index: false, follow: false },
};

const ROLE_LABEL: Record<string, string> = {
  USER: "普通用户",
  REVIEWER: "审核员",
  ADMIN: "管理员",
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const res = await requireRole(STAFF_ROLES);

  if (!res.ok && res.reason === "unauthenticated") {
    // 登录后固定回 /account，用户可从账号页「进入管理后台」再回此（V1-A 不引入 next 回跳，避免开放重定向面）。
    redirect("/login");
  }

  if (!res.ok) {
    // 已登录但角色不符（forbidden）：受保护的后台数据根本不参与渲染。
    return (
      <Container size="md" className="py-16">
        <Alert variant="danger" title="无访问权限">
          当前登录身份不足以进入管理后台。管理后台仅对审核员 / 管理员开放。如需权限，
          请联系站点管理员通过
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">user:promote</code>
          脚本授予角色，或改用有权限的账号登录。
        </Alert>
        <div className="mt-6 text-sm">
          <Link href="/" className="hover:underline">← 返回首页</Link>
        </div>
      </Container>
    );
  }

  const user = res.user;
  const roleLabel = ROLE_LABEL[user.role] ?? user.role;

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
        <Container className="flex items-center justify-between py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-tight">管理后台</span>
            <Badge variant="success">{roleLabel}</Badge>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">{user.email}</span>
            <Link href="/account" className="hover:underline">
              我的账号
            </Link>
            <Link href="/" className="hover:underline">
              退出后台
            </Link>
          </div>
        </Container>
      </div>
      <main className="flex-1">{children}</main>
    </div>
  );
}
