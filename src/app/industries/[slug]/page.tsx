import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container, Badge } from "@/components/ui";
import { PageHeader, Breadcrumb, EmptyState } from "@/components/page";
import { INDUSTRIES, getIndustryBySlug } from "@/server/industries";

/**
 * /industries/[slug] — 行业详情页（V1-A，PRODUCT_SPEC §5）。
 *
 * 展示单个行业的定位与"该行业暂无公开深度案例"的诚实空态。
 * 案例列表本身在 Phase 5 M2 接入 /cases?industry=…；此页先把 URL、SEO、
 * 信息架构立起来（总控第 19 节：每个行业独立 URL + title/description）。
 *
 * 路由策略（关键决策）：
 *   行业 slug 是固定枚举集合，用 generateStaticParams 预渲染 7 个合法 slug，
 *   并置 dynamicParams = false —— 任何非法 slug 由路由器直接返回真 404。
 *   为什么不用 force-dynamic + notFound()：根 loading.tsx 的 Suspense 会先 flush 200 shell，
 *   流式渲染下页面内 notFound() 无法把状态码回退成 404（SEO 会误收录无效页）。
 *   静态化同时让行业页更快、更利于 SEO；实时案例计数保留在 force-dynamic 的 /industries 列表页。
 */

interface RouteParams {
  slug: string;
}

interface PageProps {
  params: Promise<RouteParams>;
}

export function generateStaticParams(): RouteParams[] {
  return INDUSTRIES.map((industry) => ({ slug: industry.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const industry = getIndustryBySlug(slug);
  if (!industry) {
    return { title: "行业未找到" };
  }
  return {
    title: `${industry.name} · 行业`,
    description: `${industry.name}（${industry.nameEn}）产业案例与解决方案：${industry.tagline}`,
  };
}

export default async function IndustryDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const industry = getIndustryBySlug(slug);
  if (!industry) {
    notFound();
  }

  return (
    <Container size="lg" className="py-10 flex flex-col gap-8">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span aria-hidden className="text-3xl leading-none">
              {industry.icon}
            </span>
            {industry.name}
          </span>
        }
        description={industry.tagline}
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "首页", href: "/" },
              { label: "行业", href: "/industries" },
              { label: industry.name },
            ]}
          />
        }
      >
        <Badge variant="outline">{industry.nameEn}</Badge>
      </PageHeader>

      <EmptyState
        title={`「${industry.name}」暂无已发布的深度案例`}
        description="每日流水线（60 候选 → 20 重点 → 10 深度 → 3 方案 → 1 精品）将自动发现并填充。当前为诚实空态，未预置任何示例数据；案例浏览页将在下一里程碑接入。"
      />
    </Container>
  );
}
