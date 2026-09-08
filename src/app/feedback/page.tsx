import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { getCurrentUser } from "@/server/authz";
import { FeedbackForm } from "@/components/account/FeedbackForm";

/**
 * /feedback — 公开反馈页（Phase 4 模块 C）。
 *
 * 游客与登录用户都可提交（可匿名；登录用户由服务端会话自动归因，表单不收集身份）。
 * 提交走 POST /api/feedback（CSRF 同源 + zod 白名单），后台 /admin/feedback 人工阅读处理。
 * 诚实边界：无验证码/频率限制（公开端点，刷量风险记 P2）；不留邮箱则无人能回复，页面明示。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "反馈与建议",
  description: "向站点提交问题报错、功能建议或使用咨询。可匿名提交。",
};

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  const sp = await searchParams;
  const from = Array.isArray(sp.from) ? sp.from[0] : sp.from;

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="反馈与建议"
        description="遇到报错、数据可疑，或希望增加功能？在这里告诉我们。"
        breadcrumb={<Breadcrumb items={[{ label: "首页", href: "/" }, { label: "反馈与建议" }]} />}
      />

      <Card>
        <CardContent className="pt-6">
          <FeedbackForm page={from} />
        </CardContent>
      </Card>

      <Alert variant="info" title="提交须知">
        反馈由站点维护者在后台人工查看处理。{user ? "你已登录，本条反馈会自动关联到你的账号。" : "当前未登录：如需我们回复，请在表单留下邮箱。"}
        {" "}本站不对反馈内容提供即时客服承诺。
      </Alert>

      <div className="text-sm">
        <Link href="/" className="text-muted-foreground hover:underline">
          ← 返回首页
        </Link>
      </div>
    </Container>
  );
}
