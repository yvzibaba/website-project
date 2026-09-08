import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { listFeedback, type FeedbackAdminItem } from "@/server/feedback";
import { FeedbackResolveButton } from "@/components/admin/FeedbackResolveButton";

/**
 * /admin/feedback — 后台反馈处理（Phase 4 模块 C，只读列表 + 标记已处理）。
 *
 * 双层门禁（与 /admin 首页同构）：layout 挡 UI，本页取数据前自鉴权 requireRole(STAFF_ROLES)，
 * 越权 return null（反馈含用户邮箱等隐私，绝不进越权响应）。
 * 支持 ?status=OPEN|RESOLVED 过滤（服务端读取，非法值当无过滤）。
 * force-dynamic + noindex（继承 layout metadata）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台",
  robots: { index: false, follow: false },
};

const KIND_LABEL: Record<string, string> = {
  BUG: "问题/报错",
  SUGGESTION: "功能建议",
  QUESTION: "使用咨询",
  OTHER: "其他",
};

function fmtDateTime(d: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return "";
  }
}

function FeedbackRow({ f }: { f: FeedbackAdminItem }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={f.kind === "BUG" ? "danger" : "info"} compact>
            {KIND_LABEL[f.kind] ?? f.kind}
          </Badge>
          {f.status === "RESOLVED" ? (
            <Badge variant="success" compact>已处理</Badge>
          ) : (
            <Badge variant="warning" compact>待处理</Badge>
          )}
          <span className="text-[11px] text-muted-foreground">{fmtDateTime(f.createdAt)}</span>
          <span className="ml-auto">
            {f.status === "OPEN" ? <FeedbackResolveButton feedbackId={f.id} /> : null}
          </span>
        </div>

        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{f.message}</p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            提交者：
            {f.userEmail ? (
              <span className="font-mono">{f.userEmail}</span>
            ) : f.email ? (
              <span className="font-mono">{f.email}（匿名自填）</span>
            ) : (
              "匿名"
            )}
          </span>
          {f.page ? <span>来源页面：<span className="font-mono">{f.page}</span></span> : null}
          {f.resolvedAt ? <span>处理时间：{fmtDateTime(f.resolvedAt)}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const sp = await searchParams;
  const statusRaw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = statusRaw === "OPEN" || statusRaw === "RESOLVED" ? statusRaw : undefined;

  const res = await listFeedback({ status, limit: 100 });
  const items = res.ok ? res.items : [];
  const openCount = res.ok ? items.filter((f) => f.status === "OPEN").length : 0;

  return (
    <Container className="py-10 flex flex-col gap-6">
      <PageHeader
        title="反馈处理"
        description="用户提交的问题报错 / 功能建议 / 使用咨询。阅读后点「标记已处理」归档；无自动通知，属人工闭环。"
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">筛选：</span>
        {[
          { label: `全部${res.ok ? `（${items.length}）` : ""}`, href: "/admin/feedback", active: !status },
          {
            label: `待处理${res.ok && !status ? `（${openCount}）` : ""}`,
            href: "/admin/feedback?status=OPEN",
            active: status === "OPEN",
          },
          { label: "已处理", href: "/admin/feedback?status=RESOLVED", active: status === "RESOLVED" },
        ].map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={
              t.active
                ? "rounded-full border border-blue-500 bg-blue-50 px-3 py-1 text-xs text-blue-700"
                : "rounded-full border border-input px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {!res.ok ? (
        <Alert variant="warning" title="反馈列表暂不可用">
          查询失败，请稍后刷新重试。
        </Alert>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {status === "OPEN" ? "没有待处理的反馈。" : status === "RESOLVED" ? "没有已处理的反馈。" : "还没有收到任何反馈。"}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((f) => (
            <FeedbackRow key={f.id} f={f} />
          ))}
        </div>
      )}
    </Container>
  );
}
