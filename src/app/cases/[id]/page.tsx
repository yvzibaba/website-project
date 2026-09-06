import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container, Badge, Alert, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { getPublicCaseById } from "@/server/cases";
import type { CaseScores } from "@/server/scoring";
import { JsonLd } from "@/components/seo";
import { seoMetadata } from "@/lib/site";
import { breadcrumbJsonLd, caseArticleJsonLd } from "@/lib/json-ld";

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

// 总控 §11 来源权威度等级（v1 仅标注，不参与打分）。
const GRADE_META: Record<string, { label: string; variant: "success" | "info" | "primary" | "warning" | "danger" }> = {
  S: { label: "来源 S", variant: "success" },
  A: { label: "来源 A", variant: "info" },
  B: { label: "来源 B", variant: "primary" },
  C: { label: "来源 C", variant: "warning" },
  D: { label: "来源 D·AI推断", variant: "danger" },
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const sp = await searchParams;
  const includeDemo = first(sp.demo) === "1";
  const res = await getPublicCaseById(id, includeDemo);
  if (res.status !== "found") return { title: "案例未找到", robots: { index: false, follow: false } };
  const description = res.data.summary?.slice(0, 120) ?? "产业案例详情";
  return {
    title: res.data.title.replace(/^【DEMO】/, ""),
    description,
    ...seoMetadata({ title: res.data.title.replace(/^【DEMO】/, ""), description, path: `/cases/${id}`, type: "article" }),
    // DEMO 视图（?demo=1）不是真实研究产出 → 永不收录（宪法第 20 条）。
    ...(includeDemo ? { robots: { index: false, follow: false } } : {}),
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
      {/* 结构化数据（Phase 14 M2）：仅真实案例发 Article/Breadcrumb；DEMO 非真实研究产出，绝不发（宪法第 20 条，与页面 noindex 同口径）。 */}
      {!c.isDemo ? (
        <>
          <JsonLd
            id="ld-article"
            data={caseArticleJsonLd({
              id: c.id,
              title: c.title,
              summary: c.summary,
              industryName: c.industryName,
              regionName: c.regionName,
              regionCountry: c.regionCountry,
              sourceUrl: c.sourceUrl,
              discoveredAt: c.discoveredAt,
            })}
          />
          <JsonLd
            id="ld-breadcrumb"
            data={breadcrumbJsonLd([
              { label: "首页", href: "/" },
              { label: "案例", href: "/cases" },
              { label: c.title },
            ])}
          />
        </>
      ) : null}
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

      {/* 评分拆解（Phase 7 M3：可审计、复算自 10 维度录入分 + 证据） */}
      <ScoreBreakdownCard scores={c.scoreBreakdown} />

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

      {/* 证据（事实/假设/推断/预测 分层 + §11 来源权威度分级） */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">证据与判断分层</h2>
        <p className="text-xs text-muted-foreground">
          依据宪法第 6 条，每条结论标注「类型（事实 / 假设 / 推断 / 预测）+ 来源等级（总控 §11 的 S/A/B/C/D）+ 可信度」，
          避免把推断包装成事实。等级只作权威度参考标注，v1 不并入可信度打分。
        </p>
        {c.evidences.some((ev) => ev.grade === "D") ? (
          <Alert variant="warning" title="存在 AI 推断 / 待验证来源（D 级）">
            依据总控 §11，来源仅为 D 级（AI 推断）的信息<strong>不得表述为已确认事实</strong>，须待补充 S/A/B 级来源后复核。
            {c.evidences.some((ev) => ev.grade === "D" && ev.type === "FACT") ? (
              <> 当前有被标为「事实」的结论仅由 D 级来源支撑，请特别留意。</>
            ) : null}
          </Alert>
        ) : null}
        {c.evidences.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无证据条目。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {c.evidences.map((ev) => {
              const meta = EVIDENCE_META[ev.type] ?? { label: ev.type, variant: "neutral" as const };
              const grade = ev.grade ? GRADE_META[ev.grade] : undefined;
              return (
                <li key={ev.id} className="flex gap-3 rounded-lg border border-border p-3">
                  <div className="flex shrink-0 flex-col items-start gap-1">
                    <Badge variant={meta.variant} compact>
                      {meta.label}
                    </Badge>
                    {grade ? (
                      <Badge variant={grade.variant} compact>
                        {grade.label}
                      </Badge>
                    ) : null}
                  </div>
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

function ScoreBreakdownCard({ scores }: { scores: CaseScores | null }) {
  if (!scores) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">评分拆解</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            该案例暂未录入 / 复算评分拆解。机会评分与证据可信度<strong>必须可复算、可追溯</strong>
            （宪法第 7 条），因此在补录 10 维度评分输入之前，此处不展示任何推算结果，避免把猜测包装成结论。
          </p>
        </CardContent>
      </Card>
    );
  }

  const dims = scores.opportunityBreakdown ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">评分拆解</CardTitle>
        {scores.rubricVersion ? (
          <span className="font-mono text-[11px] text-muted-foreground">公式 v{scores.rubricVersion}</span>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* 机会评分总分 */}
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-muted-foreground">机会评分</span>
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {typeof scores.opportunityScore === "number" ? scores.opportunityScore : "—"}
          </span>
          <span className="text-sm text-muted-foreground">/ {scores.opportunityMax}</span>
        </div>

        {dims.length === 0 ? (
          <p className="text-sm text-muted-foreground">机会评分入参非法，未能拆解到维度。</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {dims.map((d) => {
              const ratio = d.max > 0 ? Math.max(0, Math.min(1, d.contribution / d.max)) : 0;
              return (
                <div key={d.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{d.label}</span>
                      {d.polarity === "inverse" ? (
                        <span className="text-[10px] text-muted-foreground" title="该维度为负面强度，越低越好">
                          （越低越好）
                        </span>
                      ) : null}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {d.contribution}/{d.max}
                      <span className="ml-1 text-[10px]">
                        {d.polarity === "inverse" ? `录入 ${d.raw}` : `评分 ${d.raw}`}
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 证据可信度 / 关键未知变量 */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted-foreground">证据可信度</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {scores.evidenceConfidence}/100
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{scores.evidenceCount} 条证据</div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted-foreground">关键未知变量</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{scores.unknownVariableCount}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">非事实类证据条数</div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-xs text-muted-foreground">证据构成</div>
            <div className="mt-1 flex flex-wrap gap-1">
              <Badge variant="success" compact>事实 {scores.evidenceByType.FACT}</Badge>
              <Badge variant="info" compact>假设 {scores.evidenceByType.ASSUMPTION}</Badge>
              <Badge variant="warning" compact>推断 {scores.evidenceByType.INFERENCE}</Badge>
              <Badge variant="neutral" compact>预测 {scores.evidenceByType.PREDICTION}</Badge>
            </div>
          </div>
        </div>

        <Alert variant="info" title="综合评分 ≠ 项目一定成功">
          评分只表达「机会相对优先级 + 证据强度」（总控 §10 / 宪法第 9 条），不构成任何投资结论。
          高机会分若伴随低证据可信度或多项关键未知变量，须先补充事实证据再决策。
        </Alert>
      </CardContent>
    </Card>
  );
}
