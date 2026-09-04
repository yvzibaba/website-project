import type { Metadata } from "next";
import Link from "next/link";
import { Container, Badge } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { INDUSTRIES, getIndustryCaseCounts } from "@/server/industries";
import { seoMetadata } from "@/lib/site";

/**
 * /industries — 行业列表页（V1-A，PRODUCT_SPEC §5）。
 *
 * 展示六大行业 + OTHER，每个行业带"公开可见深度案例数"实时计数。
 * 数据层 getIndustryCaseCounts() 用 groupBy 一次查回；DB 不可达时降级为全 0 + 提示条。
 *
 * force-dynamic：计数须实时（开发期数据库随时被流水线写入）。
 * 当前数据库为空，所有计数显示 0 —— 这是诚实状态（宪法第 20 条），
 * 案例由 Phase 9–10 每日流水线自动填充，不预置假数据。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "行业",
  description:
    "按行业浏览全球产业案例与解决方案：新能源、工业制造、交通运输、农林牧渔、教育培训、房地产建筑。",
  ...seoMetadata({
    title: "行业",
    description:
      "按行业浏览全球产业案例与解决方案：新能源、工业制造、交通运输、农林牧渔、教育培训、房地产建筑。",
    path: "/industries",
  }),
};

export default async function IndustriesPage() {
  const { ok, counts, error } = await getIndustryCaseCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <Container size="lg" className="py-10 flex flex-col gap-8">
      <PageHeader
        title="行业"
        description="每天从全球六大产业发现高价值案例，经 AI 拆解、开源匹配与中国本土化重构，形成可购买、可实施的产业解决方案。"
        breadcrumb={
          <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "行业" }]} />
        }
      >
        <Badge variant={total > 0 ? "success" : "neutral"}>
          {ok ? `${total} 个公开案例` : "计数暂不可用"}
        </Badge>
      </PageHeader>

      {!ok ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          案例计数查询失败（数据库可能正在冷启动），下方行业仍可正常浏览。
          <span className="font-mono opacity-70"> {error}</span>
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {INDUSTRIES.map((industry) => {
          const count = counts[industry.slug] ?? 0;
          return (
            <Link key={industry.slug} href={`/industries/${industry.slug}`} className="group">
              <article className="flex h-full flex-col gap-3 rounded-lg border border-border bg-background p-5 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <span aria-hidden className="text-2xl leading-none">
                    {industry.icon}
                  </span>
                  <Badge variant={count > 0 ? "primary" : "outline"} compact>
                    {count} 案例
                  </Badge>
                </div>
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold tracking-tight text-foreground group-hover:text-primary">
                    {industry.name}
                  </h2>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {industry.nameEn}
                  </span>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{industry.tagline}</p>
              </article>
            </Link>
          );
        })}
      </div>
    </Container>
  );
}
