import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container, Badge, Alert, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { getPublishedSolutionById } from "@/server/solutions";

/**
 * /solutions/[id] — 方案详情页（V1-A，PRODUCT_SPEC §5，含购买入口）。
 *
 * 展示：方案摘要、定价、机会评分/证据可信度、关键未知变量、财务模型、风险领域，
 * 以及购买入口（V1 购买闭环在 Phase 12 接入，此处为占位）。
 * 高风险领域 / 需专业人工确认的方案，顶部醒目标注（宪法第 10/21 条）。
 *
 * 里程碑 2 不种子方案，故当前任何 id 都会 notFound()（诚实空态）；本页为 Phase 8/12 预铺。
 */

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const sp = await searchParams;
  const res = await getPublishedSolutionById(id, first(sp.demo) === "1");
  if (res.status !== "found") return { title: "方案未找到" };
  return { title: res.data.title, description: res.data.summary?.slice(0, 120) ?? "产业解决方案详情" };
}

export default async function SolutionDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const includeDemo = first(sp.demo) === "1";

  const res = await getPublishedSolutionById(id, includeDemo);
  if (res.status === "not_found") notFound();
  if (res.status === "error") throw new Error(`方案查询失败：${res.error}`);
  const s = res.data;

  return (
    <Container size="lg" className="py-10 flex flex-col gap-8">
      <PageHeader
        title={s.title}
        description={s.summary ?? undefined}
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "首页", href: "/" },
              { label: "方案", href: "/solutions" },
              { label: s.title.slice(0, 24) + "…" },
            ]}
          />
        }
      >
        <div className="flex flex-wrap gap-2">
          <Link href={`/industries/${s.industrySlug}`}>
            <Badge variant="outline">{s.industryName}</Badge>
          </Link>
          {s.isDemo ? <Badge variant="warning">DEMO 数据</Badge> : null}
        </div>
      </PageHeader>

      {s.needsProfessionalReview ? (
        <Alert variant="danger" title="需要专业人工确认">
          本方案涉及高风险领域
          {s.riskDomains.length > 0 ? `（${s.riskDomains.join("、")}）` : ""}
          ，依据宪法第 10/21 条，投资、法律、工程安全、环保、能源、医疗、政策等决策
          <strong>必须由具备资质的专业人士复核</strong>后再执行，切勿仅凭本页内容决策。
        </Alert>
      ) : s.riskDomains.length > 0 ? (
        <Alert variant="warning" title="风险提示">
          涉及领域：{s.riskDomains.join("、")}。请结合关键未知变量谨慎评估。
        </Alert>
      ) : null}

      {s.isDemo ? (
        <Alert variant="warning" title="这是 DEMO 示例数据">
          本方案关联的案例为 DEMO 示例，<strong>不是可购买的真实方案</strong>。
        </Alert>
      ) : null}

      {/* 购买区 */}
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">单份方案一次性购买</span>
            <span className="text-3xl font-semibold tabular-nums text-foreground">{s.priceDisplay ?? "定价待定"}</span>
            <span className="text-xs text-muted-foreground">
              机会评分 {s.opportunityScore ?? "—"}/100 · 证据可信度 {s.evidenceConfidence ?? "—"}/100 · 关键未知变量 {s.unknowns.length} 项
            </span>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <Button variant="primary" size="lg" disabled title="购买与支付闭环将在 Phase 12 接入">
              购买方案（即将开放）
            </Button>
            <span className="text-[11px] text-muted-foreground">
              下单 → 支付说明 → 后台确认 → 解锁，将于用户系统与订单阶段接入。
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 关联案例 */}
      <section className="text-sm">
        <span className="text-muted-foreground">源自案例：</span>
        <Link href={`/cases/${s.caseId}${includeDemo ? "?demo=1" : ""}`} className="text-primary underline">
          {s.caseTitle}
        </Link>
      </section>

      {/* 财务模型 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">财务模型</h2>
        {s.financials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无结构化财务模型。关键数字须来源可追溯、公式可复算、假设可改（宪法第 7 条），将在方案生成阶段补齐。
          </p>
        ) : (
          s.financials.map((f) => (
            <Card key={f.id}>
              <CardHeader>
                <CardTitle className="text-base">财务测算（{f.currency}）</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Fin label="CAPEX" value={f.capex} />
                  <Fin label="年 OPEX" value={f.opexAnnual} />
                  <Fin label="年收入" value={f.revenueAnnual} />
                  <Fin label="ROI" value={f.roiPct} suffix="%" />
                  <Fin label="IRR" value={f.irrPct} suffix="%" />
                  <Fin label="回收期" value={f.paybackYears} suffix=" 年" />
                </div>
                {f.calcRef ? (
                  <p className="text-xs text-muted-foreground">
                    计算引用：<code className="font-mono">{f.calcRef}</code>（程序计算 &gt; 口算）
                  </p>
                ) : null}
                {f.sourceUrl ? (
                  <p className="text-xs text-muted-foreground">
                    来源：<a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{f.sourceUrl}</a>
                  </p>
                ) : null}
                {f.note ? <p className="text-xs text-muted-foreground">{f.note}</p> : null}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {/* 关键未知变量 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">关键未知变量</h2>
        <p className="text-xs text-muted-foreground">
          依据宪法第 9 条，禁止用高评分掩盖高不确定性；以下变量会显著影响结论，需优先验证。
        </p>
        {s.unknowns.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无登记的关键未知变量。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {s.unknowns.map((u) => (
              <li key={u.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{u.name}</span>
                  {typeof u.severity === "number" ? <Badge variant="warning" compact>严重度 {u.severity}</Badge> : null}
                </div>
                {u.impact ? <p className="mt-1 text-xs text-muted-foreground">影响：{u.impact}</p> : null}
                {u.howToResolve ? <p className="mt-1 text-xs text-muted-foreground">验证方式：{u.howToResolve}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!s.hasBody ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          方案的 34 分节结构化正文（<code className="font-mono">Solution.body</code>）规范将在 Phase 8 定稿并渲染，
          当前尚未填充。
        </p>
      ) : null}
    </Container>
  );
}

function Fin({ label, value, suffix }: { label: string; value: string | null; suffix?: string }) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-foreground">{value ? `${value}${suffix ?? ""}` : "—"}</div>
    </div>
  );
}
