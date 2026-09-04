import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription, Badge, Button, Separator } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { auth } from "@/auth";
import { getProfileUserById } from "@/server/users";
import { hasRole, STAFF_ROLES } from "@/server/authz";
import { logout } from "./actions";

/**
 * /account — 我的账号（Phase 6 M1，总控页面清单 15，V1-A 最小版）。
 *
 * 受保护路由：无会话 → 跳 /login（携 callbackUrl 以便登录后回到本页）。
 * V1-A 只展示身份与登出；"我的订单/报告/收藏/企业画像/诊断"分别属 Phase 12 与 V1-B，此处仅留诚实入口说明。
 * force-dynamic：依赖会话 cookie 与实时 DB 资料。noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的账号",
  robots: { index: false, follow: false },
};

const ROLE_LABEL: Record<string, string> = {
  USER: "普通用户",
  REVIEWER: "审核员",
  ADMIN: "管理员",
};

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user) {
    // 登录成功后固定跳回 /account，故无需额外 callbackUrl。
    redirect("/login");
  }

  const profile = await getProfileUserById(session.user.id);
  if (!profile) {
    // 会话有效但 DB 里查不到该用户（极罕见，如账号被删）：回登录页重新认证。
    redirect("/login");
  }

  const roleLabel = ROLE_LABEL[profile.role] ?? profile.role;

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="我的账号"
        description="你的登录身份与账号信息。"
        breadcrumb={<Breadcrumb items={[{ label: "首页", href: "/" }, { label: "我的账号" }]} />}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {profile.name ?? "未设置昵称"}
            <Badge variant={profile.role === "USER" ? "neutral" : "success"}>{roleLabel}</Badge>
          </CardTitle>
          <CardDescription>{profile.email}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">邮箱验证</span>
            <span>{profile.emailVerified ? "已验证" : "未验证（V1-A 暂不强制）"}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">注册时间</span>
            <span className="tabular-nums">{profile.createdAt.toISOString().slice(0, 10)}</span>
          </div>
          <Separator />
          {hasRole(profile.role, STAFF_ROLES) ? (
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">管理后台</span>
              <Link href="/admin" className="font-medium text-primary hover:underline">
                进入管理后台 →
              </Link>
            </div>
          ) : null}
          <form action={logout}>
            <Button type="submit" variant="secondary">
              登出
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">即将开放</CardTitle>
          <CardDescription>
            我的订单（Phase 12 购买闭环）、我的报告 / 企业画像 / 诊断记录（V1-B 企业适配）将在此汇聚。当前 V1-A 仅提供登录身份，用于后续下单。
          </CardDescription>
        </CardHeader>
      </Card>
    </Container>
  );
}
