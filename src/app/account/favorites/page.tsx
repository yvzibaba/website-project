import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb, EmptyState } from "@/components/page";
import { getCurrentUser } from "@/server/authz";
import { listFavoritesForUser } from "@/server/favorites";
import { FavoriteRemoveButton } from "@/components/account/FavoriteRemoveButton";

/**
 * /account/favorites — 我的收藏（Phase 4 模块 C）。
 *
 * 受保护：无会话 → redirect /login（携 callbackUrl 回本页）。数据只取**当前会话用户自己**的收藏
 * （listFavoritesForUser 以会话 user.id 过滤）。悬挂引用（收藏对象已被删/下架）诚实标注「已失效」
 * 并允许移除——绝不悄悄吞掉行数，也绝不伪造链接。force-dynamic + noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的收藏",
  robots: { index: false, follow: false },
};

function fmtDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return "";
  }
}

const TYPE_LABEL: Record<string, string> = { CASE: "案例", SOLUTION: "方案" };

export default async function AccountFavoritesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?callbackUrl=%2Faccount%2Ffavorites");

  const res = await listFavoritesForUser(user.id);
  const items = res.ok ? res.items : [];

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="我的收藏"
        description="你标记过的案例与方案会汇总在此，方便回访对比。"
        breadcrumb={
          <Breadcrumb
            items={[{ label: "首页", href: "/" }, { label: "我的账号", href: "/account" }, { label: "我的收藏" }]}
          />
        }
      />

      <div className="text-sm">
        <Link href="/account" className="text-muted-foreground hover:underline">
          ← 返回我的账号
        </Link>
      </div>

      {!res.ok ? (
        <Alert variant="warning" title="收藏列表暂不可用">
          查询失败（数据库可能正在冷启动），请稍后刷新重试。
        </Alert>
      ) : items.length === 0 ? (
        <>
          <EmptyState
            title="还没有收藏"
            description="浏览案例或方案时点「☆ 收藏」，它们就会出现在这里。"
          />
          <div className="flex justify-center gap-3">
            <Link
              href="/cases"
              className="rounded-full border border-border px-5 py-2 text-sm font-medium transition-colors hover:border-ring"
            >
              去逛案例 →
            </Link>
            <Link
              href="/solutions"
              className="rounded-full border border-border px-5 py-2 text-sm font-medium transition-colors hover:border-ring"
            >
              去逛方案 →
            </Link>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((it) => (
            <Card key={it.favoriteId}>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Badge variant="outline" compact>
                  {TYPE_LABEL[it.targetType] ?? it.targetType}
                </Badge>
                {it.title && it.href ? (
                  <Link href={it.href} className="text-sm font-medium text-foreground underline-offset-4 hover:underline">
                    {it.title}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">该内容已失效（可能已下架）</span>
                )}
                <span className="ml-auto flex items-center gap-3">
                  <span className="text-[11px] text-muted-foreground">收藏于 {fmtDate(it.createdAt)}</span>
                  <FavoriteRemoveButton targetType={it.targetType} targetId={it.targetId} />
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Container>
  );
}
