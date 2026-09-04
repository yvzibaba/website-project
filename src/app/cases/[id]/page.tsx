import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container, Badge, Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { getPublicCaseById } from "@/server/cases";

/**
 * /cases/[id] — 案例详情页（V1-A，PRODUCT_SPEC §5）。
 *
 * 展示：案例概览、地区/来源、机会评分与证据可信度、商业模式拆解、
 * 技术能力关联、以及**按 事实/假设/推断/预测 分层标注的证据**（宪法第 6 条）。
 *
 * 404 语义：id 不存在、案例非公开阶段、或为 DEMO 但未带 ?demo=1 → notFound()。
 * 该页必须动态渲染（id 是任意 cuid，无法 generateStaticParams）。
 */

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const EVIDENCE_META: Record<string, { label: string; variant: "success" | "info" | "warning" | "neutral" }> = {
  FACT: { label: "事实", variant: "success" },
  ASSUMPTION: { label: "假设", variant: "info" },
  INFERENCE: { label: "推断", variant: "warning" },
  PREDICTION: { label: "预测", variant: "neutral" },
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const sp = await searchParams;
  const includeDemo = first(sp.demo) === "1";
  const res = await getPublicCaseById(id, includeDemo);
  if (res.status !== "found") return { title: "案例未找到" };
  return {
    title: res.data.title.replace(/^【DEMO】/, ""),
    description: res.data.summary?.slice(0, 120) ?? "产业案例详情",
  };
}

export default async function CaseDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const includeDemo = first(sp.demo) === "1";

  const res = await getPublicCaseById(id, includeDemo);
  if (res.status === "not_found") notFound();
  if (res.status === "error") {
    // 交给全局 error.tsx 边界（500），不伪装成 404
    throw new Error(`案例查询失败：${res.error}`);
  }
  const c = res.data;

  return (
    <Container size="lg" className="py-10 flex flex-col gap-8">
      <PageHeader
        title={c.title}
        description={c.summary ?? undefined}
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "首页", href: "/" },
              { label: "案例", href: "/cases" },
              { label: c.title.replace(/^【DEMO】/, "").slice(0, 24) + "…" },
            ]}
          />
        }
      >
        <div className="flex flex-wrap gap-2">
          <Link href={`/industries/${c.industrySlug}`}>
            <Badge variant="outline">{c.industryName}</Badge>
          </Link>
          {c.isDemo ? <Badge variant="warning">DEMO 数据</Badge> : null}
        </div>
      </PageHeader>

      {c.isDemo ? (
        <Alert variant="warning" title="这是 DEMO 示例数据">
          本案例由开发种子脚本插入，<strong>不是真实产业案例研究</strong>，仅用于验证页面渲染。
          真实案例将由每日流水线发现、拆解并经质量门禁后发布。
        </Alert>
      ) : null}

      {/* 概览指标 */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="机会评分" value={c.opportunityScore} suffix="/100" />
        <Metric label="证据可信度" value={c.evidenceConfidence} suffix="/100" />
        <Metric label="地区" text={c.regionName ?? "—"} sub={c.regionCountry ?? undefined} />
        <Metric label="发现时间" text={new Date(c.discoveredAt).toLocaleDateString("zh-CN")} />
      </section>

      {c.sourceUrl ? (
        <p className="text-xs text-muted-foreground">
          来源：
          <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
            {c.sourceUrl}
          </a>
          {c.sourceType ? <span className="ml-2 font-mono">({c.sourceType})</span> : null}
        </p>
      ) : null}

      {/* 商业模式拆解 */}
      {c.businessModel ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">商业模式拆解</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">{c.businessModel.name}</p>
            {c.businessModel.description ? (
              <p className="text-sm leading-6 text-muted-foreground">{c.businessModel.description}</p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <TagList title="收入来源" items={c.businessModel.revenueStreams} />
              <TagList title="成本结构" items={c.businessModel.costStructure} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 技术能力关联 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">涉及技术能力</h2>
        {c.capabilities.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无关联技术能力。</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {c.capabilities.map((cap) => (
              <div key={cap.capabilityId} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{cap.name}</span>
                  {typeof cap.relevance === "number" ? (
                    <Badge variant="primary" compact>相关度 {cap.relevance}</Badge>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  {cap.category ? <span className="font-mono">{cap.category}</span> : null}
                  <span className="font-mono">{cap.maturity}</span>
                </div>
                {cap.note ? <p className="mt-1 text-xs text-muted-foreground">{cap.note}</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 证据（事实/假设/推断/预测 分层） */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">证据与判断分层</h2>
        <p className="text-xs text-muted-foreground">
          依据宪法第 6 条，结论严格区分「事实 / 假设 / 推断 / 预测」，并标注可信度，避免把推断包装成事实。
        </p>
        {c.evidences.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无证据条目。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {c.evidences.map((ev) => {
              const meta = EVIDENCE_META[ev.type] ?? { label: ev.type, variant: "neutral" as const };
              return (
                <li key={ev.id} className="flex gap-3 rounded-lg border border-border p-3">
                  <Badge variant={meta.variant} compact className="shrink-0 self-start">
                    {meta.label}
                  </Badge>
                  <div className="flex flex-col gap-1">
                    <p className="text-sm leading-6 text-foreground">{ev.statement}</p>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      {typeof ev.confidence === "number" ? <span>可信度 {ev.confidence}/100</span> : null}
                      {ev.sourceUrl ? (
                        <a href={ev.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">
                          来源
                        </a>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 关联方案 */}
      <section className="rounded-lg border border-border bg-muted/30 p-5 text-sm">
        <h2 className="mb-2 font-semibold text-foreground">产业解决方案</h2>
        {c.publishedSolutionCount > 0 ? (
          <p className="text-muted-foreground">
            本案例已有 {c.publishedSolutionCount} 个已发布方案，前往{" "}
            <Link href="/solutions" className="text-primary underline">方案列表</Link> 查看。
          </p>
        ) : (
          <p className="text-muted-foreground">
            本案例暂无已发布的产业解决方案。方案由每日流水线经技术匹配、开源许可检查、中国本土化重构与
            多角色质量门禁（Research → Bull → Bear → Judge → QA）后生成，需人工审核发布。
          </p>
        )}
      </section>
    </Container>
  );
}

function Metric({ label, value, suffix, text, sub }: { label: string; value?: number | null; suffix?: string; text?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
        {text ?? (typeof value === "number" ? `${value}${suffix ?? ""}` : "—")}
      </div>
      {sub ? <div className="font-mono text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function TagList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      {items.length === 0 ? (
        <span className="text-xs text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => (
            <span key={it} className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground">
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
