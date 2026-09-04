import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui";
import { Breadcrumb } from "@/components/page";
import { auth } from "@/auth";
import { AuthForm } from "@/components/auth/AuthForm";
import { login } from "./actions";

/**
 * /login — 登录页（Phase 6 M1，总控页面清单 13）。
 * 已登录用户直接跳 /account。force-dynamic：需读会话 cookie。noindex（登录页不进 SEO）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "登录",
  description: "登录你的产业案例引擎账号。",
  robots: { index: false, follow: false },
};

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/account");

  return (
    <Container size="sm" className="py-10 flex flex-col gap-6">
      <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "登录" }]} />
      <Card>
        <CardHeader>
          <CardTitle>登录</CardTitle>
          <CardDescription>用邮箱和密码登录，即可查看已购方案与下单。</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm action={login} mode="login" submitLabel="登录" pendingLabel="登录中…" />
        </CardContent>
      </Card>
    </Container>
  );
}
