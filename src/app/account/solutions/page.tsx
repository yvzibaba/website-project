import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb, EmptyState } from "@/components/page";
import { getCurrentUser } from "@/server/authz";
import { listOrdersForBuyer } from "@/server/orders";

/**
 * /account/solutions — 我购买的方案（Phase 4 模块 D，用户中心重构）。
 *
 * 受保护：无会话 → redirect /login（携 callbackUrl 回本页）。数据口径与解锁判定同源：
 * listOrdersForBuyer 按当前会话 userId/归一 email 命中，仅取 PAID（已确认到账）订单映射到方案——
 * 与 hasPaidEntitlement 的解锁口径一致，绝不把 PENDING 单的方案标成「可读正文」。
 * 每行给到：方案名（链到详情页）、订单金额与支付时间、订单状态入口。force-dynamic + noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我购买的方案",
  robots: { index: false, follow: false },
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

export default async function AccountSolutionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?callbackUrl=%2Faccount%2Fsolutions");

  const orders = await listOrdersForBuyer({ userId: user.id, email: user.email });
  const paid = orders.filter((o) => o.status === "PAID");

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="我购买的方案"
        description="已确认到账（PAID）的订单对应的方案正文在此汇聚，点开即读完整正文。"
        breadcrumb={
          <Breadcrumb
            items={[{ label: "首页", href: "/" }, { label: "我的账号", href: "/account" }, { label: "我购买的方案" }]}
          />
        }
      />

      <div className="text-sm">
        <Link href="/account" className="text-muted-foreground hover:underline">
          ← 返回我的账号
        </Link>
      </div>

      {paid.length === 0 ? (
        <>
          <EmptyState
            title="还没有已解锁的方案"
            description="购买流程：下单 → 人工付款 → 提交付款凭证 → 后台确认到账 → 方案正文自动解锁并出现在这里。"
          />
          <div className="flex justify-center gap-3">
            <Link
              href="/solutions"
              className="rounded-full border border-border px-5 py-2 text-sm font-medium transition-colors hover:border-ring"
            >
              去逛方案 →
            </Link>
            <Link
              href="/account/orders"
              className="rounded-full border border-border px-5 py-2 text-sm font-medium transition-colors hover:border-ring"
            >
              查看待支付订单 →
            </Link>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {paid.map((o) => (
            <Card key={o.id}>
              <CardContent className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {o.solutionId ? (
                    <Link
                      href={`/solutions/${o.solutionId}`}
                      className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {o.solutionTitle ?? "（方案已移除）"}
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">{o.solutionTitle ?? "（方案已移除）"}</span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {o.amountDisplay} · 确认到账 {fmtDateTime(o.paidAt)} · 订单
                    <span className="ml-1 font-mono">{o.id.slice(0, 8)}</span>
                  </span>
                </div>
                <Badge variant="success" compact>
                  已解锁
                </Badge>
                {o.solutionId ? (
                  <Link href={`/solutions/${o.solutionId}`} className="text-sm font-medium text-primary hover:underline">
                    查看完整正文 →
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ))}
          <Alert variant="info" title="解锁口径说明">
            本页与方案详情页使用同一解锁判定（数 PAID 订单）：后台确认到账即解锁，退款（REFUNDED）后方案不会再出现在这里。
          </Alert>
        </div>
      )}
    </Container>
  );
}
