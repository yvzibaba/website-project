import type { Metadata } from "next";
import Link from "next/link";
import { Container, Badge, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb, EmptyState } from "@/components/page";
import { INDUSTRIES, getIndustryBySlug } from "@/server/industries";
import { listPublicCases, CASE_SORT_FIELDS, type CaseSortField } from "@/server/cases";
import { PaginationSchema, makeSortSchema, SearchQuerySchema } from "@/lib/validation";
import { cn } from "@/lib/cn";

/**
 * /cases — 案例列表页（V1-A，PRODUCT_SPEC §5）。
 *
 * 支持：行业筛选（?industry=<slug>）、分页（?page&pageSize）、排序（?sortBy&sortOrder）、
 * DEMO 可见性开关（?demo=1，默认关闭 —— 见 demo.ts / 宪法第 20 条）。
 *
 * force-dynamic：数据须实时。默认（无 demo）库为空时展示诚实空态；
 * 带 ?demo=1 时展示 seed 脚本插入的【DEMO】示例案例并全程打角标。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "案例",
  description: "浏览全球产业案例：按行业、时间、机会评分筛选，查看 AI 拆解的深度案例。",
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const CaseSortSchema = makeSortSchema(CASE_SORT_FIELDS, "discoveredAt");

/** 取查询参数首个字符串值（Next 16：searchParams 值可能是数组）。 */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** 构造保留筛选条件的分页/筛选链接。 */
function buildHref(base: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `/cases?${s}` : "/cases";
}

export default async function CasesPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const pagination = PaginationSchema.parse({
    page: first(sp.page),
    pageSize: first(sp.pageSize),
  });
  const sort = CaseSortSchema.parse({
    sortBy: first(sp.sortBy),
    sortOrder: first(sp.sortOrder),
  });

  const industrySlugRaw = first(sp.industry);
  const industryMeta = industrySlugRaw ? getIndustryBySlug(industrySlugRaw) : undefined;
  const industry = industryMeta?.enum;

  const includeDemo = first(sp.demo) === "1";

  const qRaw = first(sp.q);
  const qParsed = qRaw && qRaw.trim() ? SearchQuerySchema.safeParse(qRaw) : null;
  const q = qParsed?.success ? qParsed.data : undefined;

  const result = await listPublicCases({
    offset: pagination.offset,
    limit: pagination.limit,
    page: pagination.page,
    pageSize: pagination.pageSize,
    industry,
    q,
    sortBy: sort.sortBy as CaseSortField,
    sortOrder: sort.sortOrder,
    includeDemo,
  });

  // 公共查询参数（分页切换/筛选时保留）
  const common = { q, industry: industrySlugRaw, demo: includeDemo ? "1" : undefined, sortBy: sort.sortBy, sortOrder: sort.sortOrder };

  return (
    <Container size="lg" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="案例"
        description="每天从全球六大产业发现并深度拆解的高价值案例。案例免费查看，可进一步购买对应的产业解决方案。"
        breadcrumb={<Breadcrumb items={[{ label: "首页", href: "/" }, { label: "案例" }]} />}
      >
        <Badge variant={result.total > 0 ? "success" : "neutral"}>
          {result.ok ? `${result.total} 个案例` : "计数暂不可用"}
        </Badge>
      </PageHeader>

      {includeDemo ? (
        <Alert variant="warning" title="DEMO 数据视图">
          当前展示的是标注为【DEMO】的示例案例，仅用于开发期验证页面渲染，
          <strong>不是真实研究成果</strong>。去掉网址中的 <code>?demo=1</code> 即回到只显示真实数据的默认视图。
        </Alert>
      ) : null}

      {!result.ok ? (
        <Alert variant="danger" title="案例查询失败">
          数据库可能正在冷启动或不可达，请稍后重试。
          <span className="font-mono text-xs opacity-70"> {result.error}</span>
        </Alert>
      ) : null}

      {q ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">关键词</span>
          <Badge variant="info">{q}</Badge>
          <Link
            href={buildHref({ ...common, q: undefined, page: undefined })}
            className="text-primary underline-offset-4 hover:underline"
          >
            清除
          </Link>
        </div>
      ) : null}

      {/* 行业筛选 chips */}
      <nav aria-label="按行业筛选" className="flex flex-wrap gap-2">
        <Link
          href={buildHref({ ...common, industry: undefined, page: undefined })}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm transition-colors",
            !industrySlugRaw ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-ring",
          )}
        >
          全部
        </Link>
        {INDUSTRIES.map((ind) => (
          <Link
            key={ind.slug}
            href={buildHref({ ...common, industry: ind.slug, page: undefined })}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm transition-colors",
              industrySlugRaw === ind.slug ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-ring",
            )}
          >
            <span aria-hidden className="mr-1">{ind.icon}</span>
            {ind.name}
          </Link>
        ))}
      </nav>

      {result.ok && result.items.length === 0 ? (
        <EmptyState
          title={includeDemo ? "暂无案例（含 DEMO）" : "暂无已发布的深度案例"}
          description={
            includeDemo
              ? "连 DEMO 数据都没有。请先运行 npm run db:seed 插入示例案例。"
              : "每日流水线（60 候选 → 20 重点 → 10 深度 → 3 方案 → 1 精品）将自动发现并填充。开发期可加 ?demo=1 查看【DEMO】示例数据。"
          }
        />
      ) : null}

      {result.items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {result.items.map((c) => (
            <li key={c.id}>
              <Link href={`/cases/${c.id}${includeDemo ? "?demo=1" : ""}`} className="group block">
                <article className="flex flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" compact>
                      {c.industryName}
                    </Badge>
                    {c.regionName ? (
                      <span className="text-xs text-muted-foreground">{c.regionName}</span>
                    ) : null}
                    {c.isDemo ? <Badge variant="warning" compact>DEMO</Badge> : null}
                    {typeof c.opportunityScore === "number" ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        机会评分 <strong className="text-foreground tabular-nums">{c.opportunityScore}</strong>
                      </span>
                    ) : null}
                  </div>
                  <h2 className="text-base font-semibold leading-6 text-foreground group-hover:text-primary">
                    {c.title}
                  </h2>
                  {c.summary ? (
                    <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{c.summary}</p>
                  ) : null}
                </article>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {/* 分页控件 */}
      {result.ok && result.total > 0 ? (
        <nav aria-label="分页" className="flex items-center justify-between gap-3 pt-2 text-sm">
          {result.hasPrev ? (
            <Link
              href={buildHref({ ...common, page: pagination.page - 1 })}
              className="rounded-full border border-border px-4 py-2 transition-colors hover:border-ring"
            >
              ← 上一页
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            第 {result.page} 页 · 每页 {result.pageSize} · 共 {result.total} 条
          </span>
          {result.hasNext ? (
            <Link
              href={buildHref({ ...common, page: pagination.page + 1 })}
              className="rounded-full border border-border px-4 py-2 transition-colors hover:border-ring"
            >
              下一页 →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </Container>
  );
}
