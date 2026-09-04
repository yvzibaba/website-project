import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { ReviewQueueActions } from "@/components/admin/ReviewQueueActions";
import { getReviewQueue } from "@/server/admin-review";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin/review — 审核发布队列（Phase 13 M6）。
 *
 * 跨实体待办：把「等人工审核的方案（UNDER_HUMAN_REVIEW）」与「等晋升到公开橱窗的案例
 * （CANDIDATE / KEY_RESEARCH）」汇到一处，让"人做关键决策"这步有单一入口，不必翻两张长列表。
 * 每个待审方案**就地显示发布缺口**（复用真实发布守卫的只读预览），审核人一眼看清"能不能发、还差什么"。
 *
 * 动作全复用 Phase 13 M1 既有 PATCH 端点（服务端仍跑发布守卫 + 角色 + CSRF），UI 只是薄壳（第 16 条）。
 *
 * 双层门禁（沿用 Phase 6/12/13 教训）：layout 挡可见 UI，本页取数据前再自鉴权 requireRole(STAFF)，
 * 越权直接 return null——否则 Next 会为 leaf page 段生成 RSC flight 泄露后台数据。force-dynamic + noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "审核发布队列",
  robots: { index: false, follow: false },
};

const STAGE_LABEL: Record<string, string> = {
  CANDIDATE: "候选",
  KEY_RESEARCH: "重点研究",
};

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return "";
  }
}

export default async function AdminReviewPage() {
  // 页面自守：越权时 getReviewQueue 根本不被调用，待办数据不进响应。
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const data = await getReviewQueue();

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title="审核发布队列"
        description="等待人工裁决的方案与案例集中在此。审核人负责关键判断（发布 / 退回 / 晋升到公开橱窗），所有动作经服务端发布守卫、角色与 CSRF 校验并记入审计流水。"
      />

      <div className="text-sm">
        <Link href="/admin" className="text-muted-foreground hover:underline">
          ← 返回运行概览
        </Link>
      </div>

      {/* 待审核方案 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">
            待审核方案
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {data.solutionTotal}
              {data.solutionsTruncated ? `（仅显示前 ${data.solutions.length}）` : ""}
            </span>
          </h2>
          <Link href="/admin/solutions" className="text-sm text-muted-foreground hover:underline">
            全部方案 →
          </Link>
        </div>

        {data.solutions.length === 0 ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">当前没有等待审核的方案。</CardContent>
          </Card>
        ) : (
          data.solutions.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.title}</span>
                      {s.isDemo ? <Badge variant="warning">DEMO</Badge> : null}
                      <Badge variant="info">{s.industryName}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      挂靠案例：
                      <Link href={`/admin/cases/${s.caseId}`} className="hover:underline">
                        {s.caseTitle}
                      </Link>
                      <span className="mx-1">·</span>
                      {s.priceDisplay ?? <span className="text-amber-600">未定价</span>}
                      <span className="mx-1">·</span>
                      未知变量 {s.unknownVariableCount}
                      <span className="mx-1">·</span>
                      更新 {fmtDate(s.updatedAt)}
                    </div>
                    {s.riskDomains.length > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        高风险领域：{s.riskDomains.join("、")}
                        {s.needsProfessionalReview ? "（已勾选需专业确认）" : <span className="text-amber-600">（未勾选需专业确认）</span>}
                      </div>
                    ) : null}
                  </div>
                  <ReviewQueueActions
                    endpoint={`/api/admin/solutions/${s.id}`}
                    actions={[
                      {
                        label: "通过并发布",
                        body: { status: "PUBLISHED" },
                        variant: "primary",
                        confirm: "确认通过并发布该方案？发布后立即对外可售。",
                      },
                      { label: "退回草稿", body: { status: "DRAFT" }, variant: "secondary" },
                    ]}
                  />
                </div>

                {s.publishBlockers.length > 0 ? (
                  <Alert variant="warning" title="发布前需补齐">
                    {s.publishBlockers.join("；")}
                  </Alert>
                ) : (
                  <div className="text-xs text-emerald-600">条件齐备，可发布。</div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {/* 待晋升案例 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">
            待发布案例（内部阶段）
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {data.caseTotal}
              {data.casesTruncated ? `（仅显示前 ${data.cases.length}）` : ""}
            </span>
          </h2>
          <Link href="/admin/cases" className="text-sm text-muted-foreground hover:underline">
            全部案例 →
          </Link>
        </div>

        {data.cases.length === 0 ? (
          <Card>
            <CardContent className="text-sm text-muted-foreground">当前没有停在内部阶段、等待发布的案例。</CardContent>
          </Card>
        ) : (
          data.cases.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.title}</span>
                    {c.isDemo ? <Badge variant="warning">DEMO</Badge> : null}
                    <Badge variant="neutral">{STAGE_LABEL[c.stage] ?? c.stage}</Badge>
                    <Badge variant="info">{c.industryName}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    证据 {c.evidenceCount}
                    <span className="mx-1">·</span>
                    机会分 {c.opportunityScore ?? "未评"}
                    <span className="mx-1">·</span>
                    可信度 {c.evidenceConfidence ?? "—"}
                    <span className="mx-1">·</span>
                    更新 {fmtDate(c.updatedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Link
                    href={`/admin/cases/${c.id}`}
                    className="text-sm text-muted-foreground hover:underline"
                  >
                    编辑 →
                  </Link>
                  <ReviewQueueActions
                    endpoint={`/api/admin/cases/${c.id}`}
                    actions={[
                      {
                        label: "发布到橱窗",
                        body: { stage: "DEEP_CASE" },
                        variant: "primary",
                        confirm: "确认将该案例晋升为「深度案例」并公开到案例橱窗？",
                      },
                    ]}
                  />
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>
    </Container>
  );
}
