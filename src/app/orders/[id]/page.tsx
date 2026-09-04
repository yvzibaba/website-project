import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription, Badge, Alert, Button, Separator } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { getOrderById, type OrderView } from "@/server/orders";
import { getCurrentUser } from "@/server/authz";

/**
 * /orders/[id] — 订单支付说明页（Phase 12 M3，购买闭环第二站，RSC）。
 *
 * V1 刻意「不接支付网关」（ROADMAP #5）：下单后本页给出**站外付款指引 + 订单快照**，
 * 由买家按说明付款、管理员在后台确认后解锁方案正文。本页因此是「订单回执 + 待办清单」，不是收银台。
 *
 * 属主门禁（SECURITY，防 IDOR）：订单可按 id 直链访问，故渲染前**必须**核对
 * 「会话身份 == 订单属主」——登录 userId 命中，或登录邮箱命中订单 buyerEmail（归一小写）。
 * 不匹配一律 notFound()：既不泄露「该订单是否存在」，也不泄露金额/方案名（宁严毋松）。
 * 未登录 → redirect /login（带 callbackUrl，登录后回到本单）。
 *
 * 金额展示：`amountDisplay` 由数据层用服务端快照的 Decimal 组装（两位小数 + 币种符号），前端不再算钱（宪法第 7 条）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "订单支付说明",
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

const STATUS_LABEL: Record<OrderView["status"], string> = {
  PENDING: "待支付",
  PAID: "已支付",
  REFUNDED: "已退款",
  CANCELED: "已取消",
};
const STATUS_VARIANT: Record<OrderView["status"], "warning" | "success" | "neutral"> = {
  PENDING: "warning",
  PAID: "success",
  REFUNDED: "neutral",
  CANCELED: "neutral",
};

function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
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

function isOwner(order: OrderView, user: { id: string; email: string }): boolean {
  if (order.userId && order.userId === user.id) return true;
  if (order.buyerEmail && order.buyerEmail === user.email.toLowerCase()) return true;
  return false;
}

export default async function OrderPaymentPage({ params }: PageProps) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/orders/${id}`)}`);
  }

  const res = await getOrderById(id);
  if (res.status === "error") throw new Error(`订单查询失败：${res.error}`);
  if (res.status === "not_found" || !res.data) notFound();
  const order = res.data;
  // 属主校验放在「取到订单之后」，但对外的失败分支统一 notFound——避免用「存在但无权」与「不存在」给出可区分响应。
  if (!isOwner(order, user)) notFound();

  const paid = order.status === "PAID";

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="订单支付说明"
        description="按下方说明完成付款，管理员确认到账后即解锁方案完整正文。"
        breadcrumb={
          <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "我的订单", href: "/account/orders" }, { label: "订单详情" }]} />
        }
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">{order.solutionTitle ?? "方案"}</CardTitle>
            <Badge variant={STATUS_VARIANT[order.status]}>{STATUS_LABEL[order.status]}</Badge>
          </div>
          <CardDescription className="font-mono text-xs">订单号 {order.id}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <Row label="应付金额">
            <span className="text-xl font-semibold tabular-nums text-foreground">{order.amountDisplay}</span>
          </Row>
          <Row label="买家类型">{order.buyerType === "ENTERPRISE" ? "企业" : "个人"}</Row>
          {order.buyerName ? <Row label="联系人">{order.buyerName}</Row> : null}
          {order.buyerEmail ? <Row label="联系邮箱">{order.buyerEmail}</Row> : null}
          <Row label="下单时间">{fmtDateTime(order.createdAt)}</Row>
          {order.paidAt ? <Row label="支付时间">{fmtDateTime(order.paidAt)}</Row> : null}
        </CardContent>
      </Card>

      {paid ? (
        <>
          <Alert variant="success" title="已确认到账，正文已解锁">
            该方案完整正文现已对你开放，可返回方案详情页查看。
          </Alert>
          {order.solutionId ? (
            <div>
              <Button variant="primary" href={`/solutions/${order.solutionId}`}>
                查看方案完整正文 →
              </Button>
            </div>
          ) : null}
        </>
      ) : order.status === "CANCELED" ? (
        <Alert variant="info" title="订单已取消">
          该订单已取消，如仍需此方案可返回详情页重新下单。
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">如何完成支付（V1 站外收款）</CardTitle>
            <CardDescription>
              当前版本未接入在线支付网关（见开发路线图），采用「线下/站外转账 + 后台人工确认」的最简闭环。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <ol className="flex flex-col gap-2">
              <Step n={1}>
                按应付金额 <strong>{order.amountDisplay}</strong> 汇款至平台对公/收款账户（联系方式见页面底部或站内公告）。
              </Step>
              <Step n={2}>
                汇款备注请写明<strong>订单号</strong>（<code className="font-mono text-xs">{order.id}</code>）或本单联系邮箱，以便财务对账。
              </Step>
              <Step n={3}>
                工作人员核到账后在后台把订单确认为「已支付」，<strong>本页与方案正文将自动解锁</strong>，无需你再次操作。
              </Step>
            </ol>
            <Separator />
            <p className="text-xs text-muted-foreground">
              如长时间未解锁，请携带订单号联系客服核对。付款前请再次确认收款账户信息以防范诈骗。
            </p>
          </CardContent>
        </Card>
      )}

      <div className="text-sm">
        <Link href="/account/orders" className="text-muted-foreground hover:underline">
          ← 返回我的订单
        </Link>
      </div>
    </Container>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
        {n}
      </span>
      <span className="text-foreground">{children}</span>
    </li>
  );
}
