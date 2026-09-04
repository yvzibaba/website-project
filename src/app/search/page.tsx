import type { Metadata } from "next";
import Link from "next/link";
import { Container, Badge, Alert, Input, Button } from "@/components/ui";
import { PageHeader, Breadcrumb, EmptyState } from "@/components/page";
import { INDUSTRIES, getIndustryBySlug } from "@/server/industries";
import { searchPublic } from "@/server/search";
import { SearchQuerySchema } from "@/lib/validation";
import { cn } from "@/lib/cn";

/**
 * /search — 搜索页（V1-A，PRODUCT_SPEC §5/§7，总控第 18 节）。
 *
 * V1 用最简单可验证的方案（宪法第 4/22 条）：关键词 ILIKE（title/summary，不区分大小写）
 * 跨"公开案例 + 已发布方案"两类实体，叠加行业筛选与 DEMO 门控。**不引入全文索引 / 语义搜索**。
 *
 * 交互：GET 表单（无 JS 也能用），?q=<关键词>&industry=<slug>&demo=1。
 * 结果按"案例 / 方案"分组各显示前若干条 + 各自 total，并提供"查看全部"链接跳到
 * 对应列表页（完整分页在列表页做，避免搜索页维护两套分页 UI）。
 *
 * force-dynamic：搜索须实时；q 缺省时展示搜索引导（不查库）。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "搜索",
  description: "按关键词与行业搜索全球产业案例与可购买的产业解决方案。",
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export default async function SearchPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const qRaw = first(sp.q);
  const industrySlugRaw = first(sp.industry);
  const industryMeta = industrySlugRaw ? getIndustryBySlug(industrySlugRaw) : undefined;
  const industry = industryMeta?.enum;
  const includeDemo = first(sp.demo) === "1";

  // 公共链接参数（保留关键词/行业/DEMO 视图）
  const common = { q: qRaw, industry: industrySlugRaw, demo: includeDemo ? "1" : undefined };

  // 校验关键词：缺省 → 引导态；非法（过长/全控制字符）→ 错误态；合法 → 查询。
  const parsed = qRaw && qRaw.trim() ? SearchQuerySchema.safeParse(qRaw) : null;
  const invalidMsg =
    parsed && !parsed.success
      ? parsed.error.issues.map((i) => i.message).join("；")
      : null;
  const q = parsed?.success ? parsed.data : undefined;

  const result = q ? await searchPublic({ q, industry, includeDemo }) : null;

  return (
    <Container size="lg" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="搜索"
        description="按关键词与行业检索公开产业案例与已发布的产业解决方案。V1 为关键词匹配，语义搜索将在后续增强。"
        breadcrumb={<Breadcrumb items={[{ label: "首页", href: "/" }, { label: "搜索" }]} />}
      />

      {/* 搜索表单（GET，无 JS 亦可用） */}
      <form method="get" action="/search" className="flex flex-col gap-3" role="search">
        <div className="flex gap-2">
          <Input
            type="search"
            name="q"
            defaultValue={qRaw ?? ""}
            placeholder="输入关键词，如：沼气、储能、视觉质检…"
            aria-label="搜索关键词"
            maxLength={100}
            className="flex-1"
          />
          <Button type="submit" variant="primary">
            搜索
          </Button>
        </div>
        {/* 保留行业与 DEMO 视图，使表单提交不丢失当前筛选上下文 */}
        {industrySlugRaw ? <input type="hidden" name="industry" value={industrySlugRaw} /> : null}
        {includeDemo ? <input type="hidden" name="demo" value="1" /> : null}
      </form>

      {/* 行业筛选 chips（保留关键词） */}
      <nav aria-label="按行业筛选" className="flex flex-wrap gap-2">
        <Link
          href={`/search${qs({ ...common, industry: undefined })}`}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm transition-colors",
            !industrySlugRaw ? "border-primary bg-primary/10 text-primary" : "border-border hover:border-ring",
          )}
        >
          全部行业
        </Link>
        {INDUSTRIES.map((ind) => (
          <Link
            key={ind.slug}
            href={`/search${qs({ ...common, industry: ind.slug })}`}
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

      {includeDemo ? (
        <Alert variant="warning" title="DEMO 数据视图">
          当前结果可能包含标注为【DEMO】的示例数据，仅用于开发期验证，<strong>不是真实研究成果</strong>。
          去掉网址中的 <code>?demo=1</code> 即回到只显示真实数据的默认视图。
        </Alert>
      ) : null}

      {invalidMsg ? (
        <Alert variant="danger" title="搜索关键词无效">
          {invalidMsg}
        </Alert>
      ) : null}

      {/* 引导态：尚无关键词 */}
      {!qRaw?.trim() ? (
        <EmptyState
          title="输入关键词开始搜索"
          description="可搜索公开产业案例与已发布方案的标题与摘要；也可点击上方行业标签按行业浏览。"
        />
      ) : null}

      {/* 结果态 */}
      {result ? (
        result.ok === false ? (
          <Alert variant="danger" title="搜索查询失败">
            数据库可能正在冷启动或不可达，请稍后重试。
            <span className="font-mono text-xs opacity-70"> {result.cases.error ?? result.solutions.error}</span>
          </Alert>
        ) : result.hits === 0 ? (
          <EmptyState
            title={`没有找到与「${result.q}」相关的案例或方案`}
            description={
              includeDemo
                ? "试试更短或更宽泛的关键词，或切换行业筛选。"
                : "试试更宽泛的关键词。真实案例与方案由每日流水线逐步填充；开发期可加 ?demo=1 查看【DEMO】示例数据。"
            }
          />
        ) : (
          <div className="flex flex-col gap-8">
            <ResultSection
              kind="案例"
              total={result.cases.total}
              shown={result.cases.items.length}
              viewAllHref={`/cases${qs(common)}`}
              empty="没有匹配的案例。"
            >
              {result.cases.items.map((c) => (
                <li key={c.id}>
                  <Link href={`/cases/${c.id}${includeDemo ? "?demo=1" : ""}`} className="group block">
                    <article className="flex flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" compact>{c.industryName}</Badge>
                        {c.regionName ? <span className="text-xs text-muted-foreground">{c.regionName}</span> : null}
                        {c.isDemo ? <Badge variant="warning" compact>DEMO</Badge> : null}
                        {typeof c.opportunityScore === "number" ? (
                          <span className="ml-auto text-xs text-muted-foreground">
                            机会评分 <strong className="text-foreground tabular-nums">{c.opportunityScore}</strong>
                          </span>
                        ) : null}
                      </div>
                      <h3 className="text-base font-semibold leading-6 text-foreground group-hover:text-primary">{c.title}</h3>
                      {c.summary ? <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{c.summary}</p> : null}
                    </article>
                  </Link>
                </li>
              ))}
            </ResultSection>

            <ResultSection
              kind="方案"
              total={result.solutions.total}
              shown={result.solutions.items.length}
              viewAllHref={`/solutions${qs(common)}`}
              empty="没有匹配的方案（方案由每日流水线经多角色质量门禁 + 人工审核后发布）。"
            >
              {result.solutions.items.map((s) => (
                <li key={s.id}>
                  <Link href={`/solutions/${s.id}${includeDemo ? "?demo=1" : ""}`} className="group block">
                    <article className="flex flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" compact>{s.industryName}</Badge>
                        {s.needsProfessionalReview ? <Badge variant="danger" compact>需专业确认</Badge> : null}
                        {s.isDemo ? <Badge variant="warning" compact>DEMO</Badge> : null}
                        {s.priceDisplay ? (
                          <span className="ml-auto text-sm font-semibold text-foreground tabular-nums">{s.priceDisplay}</span>
                        ) : null}
                      </div>
                      <h3 className="text-base font-semibold leading-6 text-foreground group-hover:text-primary">{s.title}</h3>
                      {s.summary ? <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{s.summary}</p> : null}
                    </article>
                  </Link>
                </li>
              ))}
            </ResultSection>
          </div>
        )
      ) : null}
    </Container>
  );
}

interface ResultSectionProps {
  kind: string;
  total: number;
  shown: number;
  viewAllHref: string;
  empty: string;
  children: React.ReactNode;
}

function ResultSection({ kind, total, shown, viewAllHref, empty, children }: ResultSectionProps) {
  return (
    <section className="flex flex-col gap-3" aria-label={`${kind}搜索结果`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{kind}</h2>
        <Badge variant={total > 0 ? "success" : "neutral"}>{total} 个结果</Badge>
        {total > shown ? (
          <Link href={viewAllHref} className="ml-auto text-sm text-primary underline-offset-4 hover:underline">
            查看全部 {total} 个 →
          </Link>
        ) : null}
      </div>
      {shown > 0 ? <ul className="flex flex-col gap-3">{children}</ul> : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}
