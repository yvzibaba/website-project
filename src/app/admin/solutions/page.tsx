import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { NewSolutionForm } from "@/components/admin/NewSolutionForm";
import { PublishSolutionButton } from "@/components/admin/PublishSolutionButton";
import { listAdminSolutions } from "@/server/admin-solutions";
import { listAdminCases } from "@/server/admin-cases";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin/solutions — 方案管理（Phase 13 M3，「方案从录入到可售」链路的后台入口）。
 *
 * 双层门禁（沿用 Phase 6/12/13 教训）：layout 挡可见 UI，本页取任何数据前**再自鉴权** requireRole(STAFF)，
 * 越权直接 return null——否则 Next 会为 leaf page 段生成 RSC flight 泄露后台数据。
 *
 * 组成：① 全量方案列表（含 DRAFT / UNDER_HUMAN_REVIEW / DEMO 关联，`listAdminSolutions`，非公开橱窗）；
 *       ② `NewSolutionForm` 新建（POST `/api/admin/solutions`，强制 DRAFT）；
 *       ③ 每行 `PublishSolutionButton` 发布（PATCH `/api/admin/solutions/[id]`，走数据层 publishGuard）。
 *   刻意只做「列表 + 新建 + 发布」这条最小闭环；正文 34 分节 / 财务 / 未知变量 / 删除的录入留 M4
 *   （简单优先，一次一个明确任务）。force-dynamic + noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "方案管理",
  robots: { index: false, follow: false },
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  UNDER_HUMAN_REVIEW: "人工审核中",
  PUBLISHED: "已发布",
};
const STATUS_VARIANT: Record<string, "neutral" | "info" | "success"> = {
  DRAFT: "neutral",
  UNDER_HUMAN_REVIEW: "info",
  PUBLISHED: "success",
};

const CURRENCY_OPTIONS = [
  { value: "CNY", label: "人民币 CNY" },
  { value: "USD", label: "美元 USD" },
];

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return "";
  }
}

export default async function AdminSolutionsPage() {
  // 页面自守：越权时 listAdminSolutions / listAdminCases 根本不被调用，数据不进响应。
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const [list, cases] = await Promise.all([listAdminSolutions(), listAdminCases()]);

  // 新建表单的案例下拉：全量案例（含候选态，运营常在候选案例上先起方案骨架）。
  const caseOptions = cases.ok
    ? cases.items.map((c) => ({ value: c.id, label: `${c.title}${c.isDemo ? "（DEMO）" : ""} · ${c.industryName}` }))
    : [];

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title="方案管理"
        description="录入、定价并发布可售方案。发布后方案即进入「用户查看→购买」闭环、可被下单。所有写操作经服务端角色与 CSRF 校验，并记入审计流水。"
      />

      <div className="text-sm">
        <Link href="/admin" className="text-muted-foreground hover:underline">
          ← 返回运行概览
        </Link>
      </div>

      <NewSolutionForm cases={caseOptions} currencies={CURRENCY_OPTIONS} />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">方案列表</h2>
          <span className="text-sm text-muted-foreground">
            共 {list.total} 条{list.truncated ? `（首屏最多显示 ${list.items.length} 条）` : ""}
          </span>
        </div>

        {!list.ok ? (
          <Alert variant="danger" title="加载失败">
            {list.error || "方案数据暂时不可用，请稍后重试。"}
          </Alert>
        ) : list.items.length === 0 ? (
          <Alert variant="info" title="还没有方案">
            用上方表单基于一个已有案例创建第一条方案（草稿），补齐价格后即可发布对外可售。
          </Alert>
        ) : (
          <div className="flex flex-col gap-2">
            {list.items.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex flex-col gap-2 py-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.title}</span>
                      {s.isDemo ? <Badge variant="warning">DEMO</Badge> : null}
                      <Badge variant={STATUS_VARIANT[s.status] ?? "neutral"}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
                      <Badge variant="neutral">{s.industryName}</Badge>
                      {s.priceDisplay ? (
                        <span className="text-sm font-semibold tabular-nums">{s.priceDisplay}</span>
                      ) : (
                        <Badge variant="warning">未定价</Badge>
                      )}
                      {s.needsProfessionalReview ? <Badge variant="info">需专业确认</Badge> : null}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">v{s.version} · {fmtDate(s.updatedAt)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                      <span>挂靠案例：<Link href={`/admin/cases`} className="underline">{s.caseTitle}</Link></span>
                      <span>财务 {s.financialCount}</span>
                      <span>未知变量 {s.unknownVariableCount}</span>
                      <span>订单 {s.orderCount}</span>
                      {s.publishedAt ? <span>发布 {fmtDate(s.publishedAt)}</span> : null}
                    </div>
                    {s.riskDomains.length ? (
                      <div className="text-xs text-muted-foreground">高风险领域：{s.riskDomains.join("、")}</div>
                    ) : null}
                    <div className="text-[11px] text-muted-foreground">
                      <Link href={`/solutions/${s.id}`} className="underline">
                        详情页预览
                      </Link>
                      {" · "}
                      <code className="font-mono">{s.slug}</code>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <PublishSolutionButton solutionId={s.id} status={s.status} />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </Container>
  );
}
