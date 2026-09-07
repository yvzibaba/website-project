import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui";
import { Breadcrumb } from "@/components/page";
import { auth } from "@/auth";
import { AuthForm } from "@/components/auth/AuthForm";
import { sanitizeCallbackUrl } from "@/lib/redirect-safety";
import { login } from "./actions";

/**
 * /login — 登录页（Phase 6 M1；决策1.5 加登录回跳支持）。
 *
 * 未登录看到表单，表单通过 hidden input 携带**已清洗**的 callbackUrl；`login` action 取回后
 * 作为 `signIn` 的 `redirectTo`。已登录访问本页同样跳回原目标或 /account。
 * 游客在方案详情页点「登录后可购买」→ 携 callbackUrl 回跳，登录后**直接落回原购买流程**（不再
 * 掉到 /account 得自己找方案）。
 *
 * 开放重定向防护统一走 `sanitizeCallbackUrl`（`src/lib/redirect-safety.ts`）：白名单只放行
 * `/solutions/*`、`/orders/*`、`/account*` 三类站内路径；`//evil`、绝对 URL、控制字符、
 * 非白名单前缀一律回落 `/account`（SECURITY·白名单 > 黑名单）。
 *
 * force-dynamic：需读会话 cookie 与 query。noindex（登录页不进 SEO）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "登录",
  description: "登录你的产业案例引擎账号。",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  // 白名单清洗：无论后续跳去哪，都以这里得到的 `cb` 为唯一口径，页面渲染与 action 走同一份。
  const cb = sanitizeCallbackUrl(first(sp.callbackUrl));
  const session = await auth();
  if (session?.user) redirect(cb);

  return (
    <Container size="sm" className="py-10 flex flex-col gap-6">
      <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "登录" }]} />
      <Card>
        <CardHeader>
          <CardTitle>登录</CardTitle>
          <CardDescription>用邮箱和密码登录，即可查看已购方案与下单。</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthForm
            action={login}
            mode="login"
            submitLabel="登录"
            pendingLabel="登录中…"
            hiddenFields={{ callbackUrl: cb }}
          />
        </CardContent>
      </Card>
    </Container>
  );
}
