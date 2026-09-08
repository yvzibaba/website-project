import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container, Badge } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { JsonLd } from "@/components/seo";
import { IndustryCaseList } from "@/components/industries/IndustryCaseList";
import { INDUSTRIES, getIndustryBySlug } from "@/server/industries";
import { seoMetadata } from "@/lib/site";
import { breadcrumbJsonLd, collectionPageJsonLd } from "@/lib/json-ld";

/**
 * /industries/[slug] — 行业详情页（V1-A，PRODUCT_SPEC §5；Phase 4 模块 A 接入真实案例预览）。
 *
 * 展示单个行业的定位 + 该行业公开深度案例预览（客户端经 /api/cases 拉取，
 * 空态/加载/失败均诚实降级，未预置任何示例数据）。
 *
 * 路由策略（关键决策）：
 *   行业 slug 是固定枚举集合，用 generateStaticParams 预渲染 7 个合法 slug，
 *   并置 dynamicParams = false —— 任何非法 slug 由路由器直接返回真 404。
 *   为什么不用 force-dynamic + notFound()：根 loading.tsx 的 Suspense 会先 flush 200 shell，
 *   流式渲染下页面内 notFound() 无法把状态码回退成 404（SEO 会误收录无效页）。
 *   静态化同时让行业页更快、更利于 SEO；真实案例数据由客户端组件补齐（不破坏静态性），
 *   实时案例计数保留在 force-dynamic 的 /industries 列表页。
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
    return { title: "行业未找到", robots: { index: false, follow: false } };
  }
  const description = `${industry.name}（${industry.nameEn}）产业案例与解决方案：${industry.tagline}`;
  return {
    title: `${industry.name} · 行业`,
    description,
    ...seoMetadata({ title: `${industry.name} · 行业`, description, path: `/industries/${slug}` }),
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
      {/* 结构化数据（Phase 14 M2 口径延续）：CollectionPage 声明行业集合页身份 + 面包屑。
          只映射既有事实字段（名称/英文名/tagline），不逐条铺案例（案例由客户端 API 拉取，见下）。 */}
      <JsonLd
        id="ld-industry-collection"
        data={collectionPageJsonLd({
          name: `${industry.name} · 行业`,
          description: `${industry.name}（${industry.nameEn}）产业案例与解决方案：${industry.tagline}`,
          path: `/industries/${industry.slug}`,
        })}
      />
      <JsonLd
        id="ld-industry-breadcrumb"
        data={breadcrumbJsonLd([
          { label: "首页", href: "/" },
          { label: "行业", href: "/industries" },
          { label: industry.name },
        ])}
      />
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

      {/* 真实案例预览（Phase 4 模块 A）：页面保持静态，案例经公开只读 API /api/cases
          由客户端补齐——加载骨架/失败降级/诚实空态均由 IndustryCaseList 内部处理。
          数据恒为公开可见（stage ≥ DEEP_CASE 且非 DEMO），不预置示例数据（宪法第 20 条）。 */}
      <IndustryCaseList slug={industry.slug} industryName={industry.name} />
    </Container>
  );
}
