import type { Metadata } from "next";
import Link from "next/link";
import { Container, Badge, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb, EmptyState } from "@/components/page";
import { INDUSTRIES, getIndustryBySlug } from "@/server/industries";
import { listPublishedSolutions, SOLUTION_SORT_FIELDS, type SolutionSortField } from "@/server/solutions";
import { PaginationSchema, makeSortSchema } from "@/lib/validation";
import { cn } from "@/lib/cn";

/**
 * /solutions — 方案列表页（V1-A，PRODUCT_SPEC §5）。
 *
 * 只展示已发布（PUBLISHED）的产业解决方案。里程碑 2 按创始人裁决**不种子方案**，
 * 故当前为诚实空态；真实方案由每日流水线经多角色质量门禁 + 人工审核发布后出现。
 * 支持行业筛选、分页、排序、DEMO 可见性开关（?demo=1）。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "产业解决方案",
  description: "可购买、可实施、可定制的产业解决方案：含成本模型、ROI、回收期、风险与关键未知变量。",
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SolutionSortSchema = makeSortSchema(SOLUTION_SORT_FIELDS, "publishedAt");

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function buildHref(base: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `/solutions?${s}` : "/solutions";
}

export default async function SolutionsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const pagination = PaginationSchema.parse({ page: first(sp.page), pageSize: first(sp.pageSize) });
  const sort = SolutionSortSchema.parse({ sortBy: first(sp.sortBy), sortOrder: first(sp.sortOrder) });

  const industrySlugRaw = first(sp.industry);
  const industry = industrySlugRaw ? getIndustryBySlug(industrySlugRaw)?.enum : undefined;
  const includeDemo = first(sp.demo) === "1";

  const result = await listPublishedSolutions({
    offset: pagination.offset,
    limit: pagination.limit,
    page: pagination.page,
    pageSize: pagination.pageSize,
    industry,
    sortBy: sort.sortBy as SolutionSortField,
    sortOrder: sort.sortOrder,
    includeDemo,
  });

  const common = { industry: industrySlugRaw, demo: includeDemo ? "1" : undefined, sortBy: sort.sortBy, sortOrder: sort.sortOrder };

  return (
    <Container size="lg" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="产业解决方案"
        description="把全球成功案例经 AI 拆解、开源匹配与中国本土化重构，形成可购买、可实施的方案。每份方案含成本/收益模型、ROI、回收期、风险与关键未知变量。"
        breadcrumb={<Breadcrumb items={[{ label: "首页", href: "/" }, { label: "方案" }]} />}
      >
        <Badge variant={result.total > 0 ? "success" : "neutral"}>
          {result.ok ? `${result.total} 个方案` : "计数暂不可用"}
        </Badge>
      </PageHeader>

      {includeDemo ? (
        <Alert variant="warning" title="DEMO 数据视图">
          已开启 DEMO 视图，但按创始人裁决里程碑 2 <strong>不种子任何方案</strong>（方案涉及定价与购买闭环，
          须由真实多角色流水线产出并经人工审核发布）。故此列表仍为空。
        </Alert>
      ) : null}

      {!result.ok ? (
        <Alert variant="danger" title="方案查询失败">
          数据库可能正在冷启动或不可达，请稍后重试。
          <span className="font-mono text-xs opacity-70"> {result.error}</span>
        </Alert>
      ) : null}

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
          icon="📦"
          title="暂无已发布的产业解决方案"
          description="方案由每日流水线（60 候选 → 20 重点 → 10 深度 → 3 方案 → 1 精品）经技术匹配、开源许可证检查、中国本土化重构与多角色质量门禁（Research → Bull → Bear → Judge → QA）生成，须人工审核后方可发布。当前尚未有方案发布。"
          action={
            <Link href="/cases" className="rounded-full border border-border px-4 py-2 text-sm transition-colors hover:border-ring">
              先浏览产业案例
            </Link>
          }
        />
      ) : null}

      {result.items.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {result.items.map((s) => (
            <li key={s.id}>
              <Link href={`/solutions/${s.id}${includeDemo ? "?demo=1" : ""}`} className="group block h-full">
                <article className="flex h-full flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" compact>{s.industryName}</Badge>
                    {s.isDemo ? <Badge variant="warning" compact>DEMO</Badge> : null}
                    {s.needsProfessionalReview ? <Badge variant="danger" compact>需专业人工确认</Badge> : null}
                    {s.priceDisplay ? (
                      <span className="ml-auto text-sm font-semibold text-foreground">{s.priceDisplay}</span>
                    ) : null}
                  </div>
                  <h2 className="text-base font-semibold leading-6 text-foreground group-hover:text-primary">{s.title}</h2>
                  {s.summary ? <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{s.summary}</p> : null}
                  {s.riskDomains.length > 0 ? (
                    <div className="mt-auto flex flex-wrap gap-1 pt-2">
                      {s.riskDomains.map((r) => (
                        <span key={r} className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{r}</span>
                      ))}
                    </div>
                  ) : null}
                </article>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {result.ok && result.total > 0 ? (
        <nav aria-label="分页" className="flex items-center justify-between gap-3 pt-2 text-sm">
          {result.hasPrev ? (
            <Link href={buildHref({ ...common, page: pagination.page - 1 })} className="rounded-full border border-border px-4 py-2 transition-colors hover:border-ring">
              ← 上一页
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            第 {result.page} 页 · 每页 {result.pageSize} · 共 {result.total} 条
          </span>
          {result.hasNext ? (
            <Link href={buildHref({ ...common, page: pagination.page + 1 })} className="rounded-full border border-border px-4 py-2 transition-colors hover:border-ring">
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
