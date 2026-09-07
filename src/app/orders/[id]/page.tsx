import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription, Badge, Alert, Button, Separator } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { SubmitPaymentProofForm } from "@/components/orders/SubmitPaymentProofForm";
import { getOrderById, type OrderView } from "@/server/orders";
import { getCurrentUser } from "@/server/authz";
import { deriveOrderDisplayState, ORDER_STATE_LABEL, ORDER_STATE_VARIANT } from "@/lib/order-status";
import { getPaymentInfo, PAYMENT_UNCONFIGURED_LABEL, getSupportContact, SUPPORT_UNCONFIGURED_LABEL } from "@/lib/payment-info";

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
  // 派生展示态（含「已提交付款凭证」），三处页共用同一映射，不在此各写 if。
  const displayState = deriveOrderDisplayState(order.status, order.paymentRef);
  // 人工收款信息：只透出运维在部署环境显式配置的 PAYMENT_*；未配置则页面显示占位，绝不虚构账户（宪法第 20 条）。
  const payment = getPaymentInfo();
  // 客服入口：同样只透出运维显式配置的 SUPPORT_*；未配置时诚实显示占位，绝不虚构邮箱/微信/链接（§20）。
  const support = getSupportContact();

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="订单支付说明"
        description="购买流程：下单 → 人工付款 → 提交付款凭证 → 后台确认到账 → 解锁方案完整正文。本页给出转账说明与凭证入口。"
        breadcrumb={
          <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "我的订单", href: "/account/orders" }, { label: "订单详情" }]} />
        }
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">{order.solutionTitle ?? "方案"}</CardTitle>
            <Badge variant={ORDER_STATE_VARIANT[displayState]}>{ORDER_STATE_LABEL[displayState]}</Badge>
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
      ) : order.status === "CANCELED" || order.status === "REFUNDED" ? (
        <Alert variant="info" title={order.status === "CANCELED" ? "订单已取消" : "订单已退款"}>
          {order.status === "CANCELED"
            ? "该订单已取消，如仍需此方案可返回详情页重新下单。"
            : "该订单已退款。如仍需此方案，可返回详情页重新下单。"}
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">如何完成付款（人工收款）</CardTitle>
            <CardDescription>
              当前版本未接入在线支付网关（见开发路线图），采用「站外转账 + 后台人工确认」的最简闭环。请按下方说明付款，并回填付款凭证以便核对。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            {payment.configured ? (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
                {payment.payeeName ? <InfoRow label="收款人" value={payment.payeeName} /> : null}
                {payment.account ? <InfoRow label="收款账户" value={payment.account} mono /> : null}
                {payment.instruction ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground">付款说明</span>
                    <p className="whitespace-pre-line text-foreground">{payment.instruction}</p>
                  </div>
                ) : null}
                {payment.note ? <p className="whitespace-pre-line text-xs text-muted-foreground">{payment.note}</p> : null}
              </div>
            ) : (
              <Alert variant="warning" title={PAYMENT_UNCONFIGURED_LABEL}>
                平台尚未配置收款账户信息（环境变量 <code className="font-mono text-xs">PAYMENT_*</code>），暂时无法给出具体转账指引。
                请通过下方「客服入口」联系我们，或待配置完成后回来按说明付款。你仍应先记录本单订单号
                （<code className="font-mono text-xs">{order.id}</code>）以便对账。
              </Alert>
            )}

            {displayState === "PROOF_SUBMITTED" ? (
              <Alert variant="info" title="已提交付款凭证，等待核对">
                你已提交如下凭证，工作人员核对到账后会自动确认并解锁正文，无需重复操作；如信息有误可在下方更新：
                <span className="mt-1 block whitespace-pre-line rounded bg-muted px-2 py-1 font-mono text-xs">
                  {order.paymentRef}
                </span>
              </Alert>
            ) : null}

            <Separator />
            <SubmitPaymentProofForm orderId={order.id} status={order.status} initialPaymentRef={order.paymentRef} />

            <p className="text-xs text-muted-foreground">
              应付金额 <strong>{order.amountDisplay}</strong>；汇款备注请写明<strong>订单号</strong>（
              <code className="font-mono text-xs">{order.id}</code>）以便财务对账。提交凭证仅代表你已付款，实际到账与正文解锁
              以工作人员核对确认为准。付款前请再次核实收款账户信息以防范诈骗。
            </p>
          </CardContent>
        </Card>
      )}

      {/* 客服入口（决策1.5 P0：修付款页「请联系客服」死胡同）——只透出运维配置的 SUPPORT_*；
          未配置时诚实显示占位、绝不虚构邮箱/微信/链接（§20）。付款遇到问题、凭证核对超时、
          或想核对到账状态，都可从这里发起。 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">客服入口</CardTitle>
          <CardDescription>
            付款遇到问题、想核对到账状态或更正凭证信息，都可通过以下渠道联系人工客服。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {support.configured ? (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
              {support.email ? (
                <InfoRow
                  label="邮箱"
                  value={
                    <a href={`mailto:${support.email}`} className="text-primary underline">
                      {support.email}
                    </a>
                  }
                />
              ) : null}
              {support.wechat ? <InfoRow label="微信" value={support.wechat} /> : null}
              {support.url ? (
                <InfoRow
                  label="客服/帮助中心"
                  value={
                    /^https:/i.test(support.url) ? (
                      <a
                        href={support.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-primary underline"
                      >
                        打开客服表单
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{support.url}</span>
                    )
                  }
                />
              ) : null}
            </div>
          ) : (
            <Alert variant="warning" title={SUPPORT_UNCONFIGURED_LABEL}>
              平台尚未配置客服联系方式（环境变量{" "}
              <code className="font-mono text-xs">SUPPORT_EMAIL / SUPPORT_WECHAT / SUPPORT_URL</code>
              ），本页暂时无法给出可用的联系入口。你仍可先记录订单号（
              <code className="font-mono text-xs">{order.id}</code>
              ）与联系方式，待运营方在部署环境填好客服信息后回来联系我们。
            </Alert>
          )}
        </CardContent>
      </Card>

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

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="flex-none text-muted-foreground">{label}</span>
      <span className={"text-right break-all " + (mono ? "font-mono" : "")}>{value}</span>
    </div>
  );
}
