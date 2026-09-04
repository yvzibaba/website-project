import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui";
import { Breadcrumb } from "@/components/page";
import { auth } from "@/auth";
import { AuthForm } from "@/components/auth/AuthForm";
import { register } from "./actions";

/**
 * /register — 注册页（Phase 6 M1，总控页面清单 14）。
 * 已登录用户直接跳 /account。注册成功即自动登录并跳 /account。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "注册",
  description: "创建产业案例引擎账号：查看已购方案、下单购买产业解决方案。",
  robots: { index: false, follow: false },
};

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/account");

  return (
    <Container size="sm" className="py-10 flex flex-col gap-6">
      <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "注册" }]} />
      <Card>
        <CardHeader>
          <CardTitle>注册</CardTitle>
          <CardDescription>
            只需邮箱和密码。密码经 scrypt 加盐哈希后存储，我们绝不会保存明文。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm action={register} mode="register" submitLabel="注册并登录" pendingLabel="注册中…" />
        </CardContent>
      </Card>
    </Container>
  );
}
