import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { AdminOrderActions } from "@/components/admin/AdminOrderActions";
import { listOrdersForAdmin, type OrderView } from "@/server/orders";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin/orders — 订单管理（Phase 12 M3，购买闭环的后台确认台，RSC）。
 *
 * 双层门禁（沿用 Phase 6/13 教训）：layout 挡可见 UI，本页取任何数据前**再自鉴权** requireRole(STAFF)，
 * 越权直接 return null——否则 Next 会为 leaf page 段生成 RSC flight 泄露订单数据（含买家邮箱）。
 *
 * 作用：把「下单→站外付款→后台人工确认→解锁」这条 V1 闭环的**人工闸门**给到员工——
 * 对 PENDING 单点「确认收款」（→PAID，触发买家侧正文解锁）或「取消」。动作经 M2 的
 * `/api/admin/orders/[id]/{confirm,cancel}` 端点（CSRF + 角色 + 状态机由数据层守护）。
 * 支持按状态过滤 + 分页（简单优先，一次一块闭环；金额/明细编辑留后）。force-dynamic + noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "订单管理",
  robots: { index: false, follow: false },
};

type OrderStatus = OrderView["status"];

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "待支付",
  PAID: "已支付",
  REFUNDED: "已退款",
  CANCELED: "已取消",
};
const STATUS_VARIANT: Record<OrderStatus, "warning" | "success" | "neutral"> = {
  PENDING: "warning",
  PAID: "success",
  REFUNDED: "neutral",
  CANCELED: "neutral",
};
const STATUS_FILTERS: (OrderStatus | "ALL")[] = ["ALL", "PENDING", "PAID", "CANCELED", "REFUNDED"];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function asStatus(v: string | undefined): OrderStatus | undefined {
  return v && v !== "ALL" && v in STATUS_LABEL ? (v as OrderStatus) : undefined;
}

function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return "";
  }
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PAGE_SIZE = 20;

export default async function AdminOrdersPage({ searchParams }: PageProps) {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null; // 页面自守：越权时 listOrdersForAdmin 根本不被调用。

  const sp = await searchParams;
  const status = asStatus(first(sp.status));
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const list = await listOrdersForAdmin({ status, page, pageSize: PAGE_SIZE });

  const qs = (over: Record<string, string | number>) => {
    const p = new URLSearchParams();
    const merged = { status: status ?? "ALL", page: page, ...over };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") p.set(k, String(v));
    return p.toString();
  };

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title="订单管理"
        description="确认到账即解锁买家侧方案正文（V1 站外收款 + 人工确认）。所有写操作经服务端角色与 CSRF 校验，并记入审计流水。"
      />

      <div className="text-sm">
        <Link href="/admin" className="text-muted-foreground hover:underline">
          ← 返回运行概览
        </Link>
      </div>

      {/* 状态过滤 */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((s) => {
          const active = (status ?? "ALL") === s;
          return (
            <Link
              key={s}
              href={`/admin/orders?${qs({ status: s, page: 1 })}`}
              className={
                "rounded-full border px-3 py-1 text-xs transition-colors " +
                (active ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted")
              }
            >
              {s === "ALL" ? "全部" : STATUS_LABEL[s]}
            </Link>
          );
        })}
      </div>

      {!list.ok ? (
        <Alert variant="danger" title="加载失败">
          {list.error || "订单数据暂时不可用，请稍后重试。"}
        </Alert>
      ) : list.items.length === 0 ? (
        <Alert variant="info" title="暂无订单">
          当前筛选下没有订单。买家在方案详情页下单后会出现在这里。
        </Alert>
      ) : (
        <section className="flex flex-col gap-2">
          {list.items.map((o) => (
            <Card key={o.id}>
              <CardContent className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{o.solutionTitle ?? "方案"}</span>
                    <Badge variant={STATUS_VARIANT[o.status]}>{STATUS_LABEL[o.status]}</Badge>
                    <span className="text-sm font-semibold tabular-nums">{o.amountDisplay}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span>{o.buyerType === "ENTERPRISE" ? "企业" : "个人"}</span>
                    {o.buyerName ? <span>{o.buyerName}</span> : null}
                    {o.buyerEmail ? <span>{o.buyerEmail}</span> : <span>{o.userId ? "登录用户" : "—"}</span>}
                    <span>下单 {fmtDateTime(o.createdAt)}</span>
                    {o.paidAt ? <span>支付 {fmtDateTime(o.paidAt)}</span> : null}
                    <span>v{o.version}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    <Link href={`/orders/${o.id}`} className="underline">
                      支付说明页预览
                    </Link>
                    {" · "}
                    <code className="font-mono">{o.id}</code>
                  </div>
                </div>
                <AdminOrderActions orderId={o.id} status={o.status} />
              </CardContent>
            </Card>
          ))}

          {/* 分页 */}
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              第 {list.page} 页 · 共 {list.total} 条
            </span>
            <div className="flex gap-2">
              {list.hasPrev ? (
                <Link href={`/admin/orders?${qs({ page: list.page - 1 })}`} className="rounded-md border border-border px-3 py-1 hover:bg-muted">
                  上一页
                </Link>
              ) : null}
              {list.hasNext ? (
                <Link href={`/admin/orders?${qs({ page: list.page + 1 })}`} className="rounded-md border border-border px-3 py-1 hover:bg-muted">
                  下一页
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      )}
    </Container>
  );
}
