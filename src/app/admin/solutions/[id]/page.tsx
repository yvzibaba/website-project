import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { EditSolutionMetaForm } from "@/components/admin/EditSolutionMetaForm";
import { SolutionBodyEditor } from "@/components/admin/SolutionBodyEditor";
import { AdminSolutionFinancials } from "@/components/admin/AdminSolutionFinancials";
import { AdminSolutionUnknowns } from "@/components/admin/AdminSolutionUnknowns";
import { DeleteSolutionButton } from "@/components/admin/DeleteSolutionButton";
import { PublishSolutionButton } from "@/components/admin/PublishSolutionButton";
import { getAdminSolutionDetail } from "@/server/admin-solutions";
import { parseSolutionBody } from "@/server/solution-body";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin/solutions/[id] — 方案「内容编辑台」（Phase 13 M4）。
 *
 * 为什么：Phase 12 打通了「购买 → 解锁正文」、Phase 13 M3 能建/发布方案，但**正文与财务/未知变量此前只能靠
 * 裸 API 写**——没有编辑台，卖的就是空壳，直接拖累「方案质量」这一宪法高优先级。本页把一份可售方案的
 * 全部可编辑面（基本信息 / 34 分节正文 / 财务测算 / 关键未知变量 / 发布 / 删除）收敛到一处，
 * **零 schema、零新数据层写逻辑**，全复用 Phase 13 M1 已测写端点（第 16 条单一真源）。
 *
 * 双层门禁：layout 挡可见 UI，本页取数据前**再自鉴权** requireRole(STAFF)、越权 return null——
 * 否则 Next 会为 leaf page 段生成 RSC flight 泄露方案正文（Phase 6/12/13 反复踩过的坑）。
 * force-dynamic + noindex（后台、含未发布草稿，绝不进搜索引擎）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "编辑方案",
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

export default async function AdminSolutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // 先自鉴权，越权 → 直接 null，getAdminSolutionDetail 根本不被调用、正文不进响应。
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const { id } = await params;
  const detail = await getAdminSolutionDetail(id);
  if (detail.notFound) notFound();
  if (!detail.ok || !detail.data) {
    return (
      <Container className="py-10">
        <Alert variant="danger" title="加载失败">
          {detail.error || "方案数据暂时不可用，请稍后重试。"}
        </Alert>
      </Container>
    );
  }

  const s = detail.data;
  const parsed = parseSolutionBody(s.body);
  const sections = parsed.sections.map((sec) => ({
    key: sec.key,
    title: sec.title,
    value: typeof sec.content === "string" ? sec.content : sec.content === undefined ? "" : JSON.stringify(sec.content, null, 2),
  }));
  const extras = Object.fromEntries(parsed.extras.map((e) => [e.key, e.content]));

  return (
    <Container className="flex flex-col gap-6 py-8">
      <div className="text-sm">
        <Link href="/admin/solutions" className="text-muted-foreground hover:underline">
          ← 返回方案管理
        </Link>
      </div>

      <PageHeader title={`编辑方案：${s.title}`} description="补全基本信息、正文 34 分节、财务测算与关键未知变量；全部保存后经服务端发布守卫才会对外可售。" />

      <div className="flex flex-wrap items-center gap-2">
        {s.isDemo ? <Badge variant="warning">DEMO</Badge> : null}
        <Badge variant={STATUS_VARIANT[s.status] ?? "neutral"}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
        <Badge variant="neutral">{s.industryName}</Badge>
        {s.priceDisplay ? <span className="text-sm font-semibold tabular-nums">{s.priceDisplay}</span> : <Badge variant="warning">未定价</Badge>}
        {s.needsProfessionalReview ? <Badge variant="info">需专业确认</Badge> : null}
        <span className="text-xs text-muted-foreground tabular-nums">v{s.version}</span>
        <Link href={`/solutions/${s.id}${s.isDemo ? "?demo=1" : ""}`} className="text-xs text-muted-foreground underline">
          详情页预览 →
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          挂靠案例：<span className="font-medium text-foreground">{s.caseTitle}</span>
          <code className="ml-2 font-mono text-xs">{s.slug}</code>
        </p>
        <div className="flex items-center gap-3">
          <PublishSolutionButton solutionId={s.id} status={s.status} />
          <DeleteSolutionButton solutionId={s.id} title={s.title} orderCount={s.orderCount} />
        </div>
      </div>

      <EditSolutionMetaForm
        solutionId={s.id}
        status={s.status}
        initial={{
          title: s.title,
          titleEn: s.titleEn,
          summary: s.summary,
          price: s.price,
          currency: s.currency,
          riskDomains: s.riskDomains,
          needsProfessionalReview: s.needsProfessionalReview,
        }}
      />

      <SolutionBodyEditor solutionId={s.id} sections={sections} extras={extras} />

      <AdminSolutionFinancials solutionId={s.id} items={s.financials} />

      <AdminSolutionUnknowns solutionId={s.id} items={s.unknowns} />

      <Card>
        <CardContent className="py-4 text-xs text-muted-foreground">
          本页所有写操作经服务端 CSRF 同源 + 角色门禁（`requireStaffWrite`），并逐条写入审计流水（`ChangeLog`，宪法第 13 条）。
          数据层强制：草稿建方案不自动评分；发布须非空价格、涉高风险领域须勾选专业人工确认。
        </CardContent>
      </Card>
    </Container>
  );
}
