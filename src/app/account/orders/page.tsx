import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, Badge, Alert, Button } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { listOrdersForBuyer, type OrderView } from "@/server/orders";
import { getCurrentUser } from "@/server/authz";

/**
 * /account/orders — 我的订单（Phase 12 M3，购买闭环买家侧汇聚点，RSC）。
 *
 * 受保护：无会话 → redirect /login（登录后回本页）。数据只取「与当前会话身份相关」的订单
 * （listOrdersForBuyer 按 userId 或归一 email 命中），绝不展示他人订单（SECURITY 属主过滤在数据层）。
 *
 * 每张卡给到：方案名、状态、金额快照、下单时间，以及「支付说明 / 查看正文」入口——
 * PENDING 引导去支付说明页继续付款，PAID 引导回方案详情页读已解锁正文。
 * force-dynamic（依赖会话 + 实时数据）+ noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的订单",
  robots: { index: false, follow: false },
};

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

function fmtDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return "";
  }
}

export default async function MyOrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?callbackUrl=%2Faccount%2Forders");

  const orders = await listOrdersForBuyer({ userId: user.id, email: user.email });

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="我的订单"
        description="你名下所有方案订单（含待支付）。付款确认到账后对应方案正文自动解锁。"
        breadcrumb={<Breadcrumb items={[{ label: "首页", href: "/" }, { label: "我的账号", href: "/account" }, { label: "我的订单" }]} />}
      />

      <div className="text-sm">
        <Link href="/account" className="text-muted-foreground hover:underline">
          ← 返回我的账号
        </Link>
      </div>

      {orders.length === 0 ? (
        <Alert variant="info" title="还没有订单">
          浏览并购买感兴趣的方案后，订单会在此处汇总。
          <Link href="/solutions" className="ml-1 underline">
            去逛逛方案 →
          </Link>
        </Alert>
      ) : (
        <section className="flex flex-col gap-3">
          {orders.map((o) => (
            <Card key={o.id}>
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{o.solutionTitle ?? "方案"}</span>
                    <Badge variant={STATUS_VARIANT[o.status]}>{STATUS_LABEL[o.status]}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {o.amountDisplay} · 下单 {fmtDate(o.createdAt)} · <code className="font-mono">{o.id.slice(0, 8)}…</code>
                  </span>
                </div>
                <div className="flex flex-none items-center gap-2">
                  {o.status === "PAID" ? (
                    <Button variant="primary" size="sm" href={`/solutions/${o.solutionId}`}>
                      查看正文
                    </Button>
                  ) : null}
                  <Button variant={o.status === "PENDING" ? "primary" : "secondary"} size="sm" href={`/orders/${o.id}`}>
                    {o.status === "PENDING" ? "去支付" : "订单详情"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
    </Container>
  );
}
