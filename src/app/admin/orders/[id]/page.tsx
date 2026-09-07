import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription, Badge, Alert, Separator } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { getOrderById } from "@/server/orders";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { deriveOrderDisplayState, ORDER_STATE_LABEL, ORDER_STATE_VARIANT } from "@/lib/order-status";

/**
 * /admin/orders/[id] — 后台订单只读预览（决策1.5 P1：修 /admin/orders 列表「支付说明页预览」
 * 直连 /orders/[id] 会因属主校验 for 非买家 admin 而 notFound 的死链）。
 *
 * 门禁（沿用 /admin/orders 双层策略，宪法·SECURITY 属主 IDOR）：
 *   - 页面**取任何数据前**先 `requireRole(STAFF_ROLES)`，非员工直接 return null——
 *     否则 Next 会为 leaf page 段生成 RSC flight 泄露订单数据；
 *   - **不放宽 /orders/[id] 的 owner 校验**：本路由是 admin 侧独立读视图，不复用买家侧页；
 *     买家侧页保持「非属主 404」的对外一致响应，避免存在性泄露。
 *
 * 展示：状态徽章（派生态含 PROOF_SUBMITTED）+ 金额快照 + 买家身份（userId / buyerEmail / buyerName / 类型）
 *       + paymentProvider / paymentRef 全文（供人工核对）+ 版本时间戳。只读，无写动作
 *       （确认收款 / 取消仍在 /admin/orders 列表行上完成）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "订单预览",
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

export default async function AdminOrderPreviewPage({ params }: PageProps) {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null; // 页面自守：非员工时 getOrderById 根本不被调用。

  const { id } = await params;
  const res = await getOrderById(id);
  if (res.status === "error") throw new Error(`订单查询失败：${res.error}`);
  if (res.status === "not_found" || !res.data) notFound();
  const order = res.data;
  const displayState = deriveOrderDisplayState(order.status, order.paymentRef);

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="订单预览（后台只读）"
        description="员工核对到账用的订单快照视图：展示金额、买家身份、凭证文本与状态。写操作（确认收款 / 取消）请回到列表页对应行完成。"
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "后台", href: "/admin" },
              { label: "订单管理", href: "/admin/orders" },
              { label: "订单预览" },
            ]}
          />
        }
      />

      <div className="text-sm">
        <Link href="/admin/orders" className="text-muted-foreground hover:underline">
          ← 返回订单管理
        </Link>
      </div>

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
          <Row label="DB 状态">
            <code className="font-mono text-xs">{order.status}</code>
          </Row>
          <Row label="买家类型">{order.buyerType === "ENTERPRISE" ? "企业" : "个人"}</Row>
          {order.buyerName ? <Row label="联系人">{order.buyerName}</Row> : null}
          {order.buyerEmail ? <Row label="联系邮箱">{order.buyerEmail}</Row> : null}
          {order.userId ? (
            <Row label="会话用户 ID">
              <code className="font-mono text-xs">{order.userId}</code>
            </Row>
          ) : (
            <Row label="会话用户 ID">—（游客单，按 buyerEmail 认领）</Row>
          )}
          <Row label="下单时间">{fmtDateTime(order.createdAt)}</Row>
          {order.paidAt ? <Row label="支付时间">{fmtDateTime(order.paidAt)}</Row> : null}
          <Row label="版本">v{order.version}</Row>
          {order.paymentProvider ? (
            <Row label="收款渠道">
              <code className="font-mono text-xs">{order.paymentProvider}</code>
            </Row>
          ) : null}
        </CardContent>
      </Card>

      {order.paymentRef ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">买家提交的付款凭证</CardTitle>
            <CardDescription>
              仅供人工核对；凭证文本由买家自填，<strong>不改变订单金额或状态</strong>，实际到账以你点击「确认收款」为准。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="whitespace-pre-line rounded border border-border bg-muted px-3 py-2 font-mono text-xs">
              {order.paymentRef}
            </div>
          </CardContent>
        </Card>
      ) : order.status === "PENDING" ? (
        <Alert variant="info" title="买家尚未提交付款凭证">
          该订单仍处于「待支付」且无凭证文本。若你已通过与买家线下沟通确认到账，可直接在列表页对应行点「确认收款」。
        </Alert>
      ) : null}

      {order.solutionId ? (
        <>
          <Separator />
          <div className="text-sm">
            <span className="text-muted-foreground">关联方案：</span>
            <Link href={`/admin/solutions/${order.solutionId}`} className="text-primary underline">
              {order.solutionTitle ?? order.solutionId}
            </Link>
          </div>
        </>
      ) : null}
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
