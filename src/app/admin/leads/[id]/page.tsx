import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { LeadStatusControl } from "@/components/admin/LeadStatusControl";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { getLeadPipeline, type LeadPipelineView } from "@/server/lead-pipeline";
import type { PipelineStage } from "@/server/lead-pipeline-model";

/**
 * /admin/leads/[id] — 单条留资的「企业项目工作流」视图（R7-D · 只读投影）。
 *
 * 为什么：Lead/Project/Scenario/Solution/Order 五张表都各自能看，但**没有一个地方把"这一家企业
 * 从留资到成交到底走到哪一步"摊开**——运营得在多个后台页之间人肉对齐邮箱才能拼出全貌。本页用
 * **纯派生**（`getLeadPipeline` + `deriveLeadPipeline`，零新表零迁移）把这条留资关联到的既有记录
 * 聚成一条七段漏斗，并如实标注"到哪了 / 差什么 / 下一步做什么（人工）"。
 *
 * 双层门禁（与 /admin/leads、/admin/solutions/[id] 同构）：layout 挡 UI，本页取数据前**再自鉴权**
 * requireRole(STAFF)，越权 return null（留资含企业 / 邮箱 / 电话隐私）。force-dynamic + noindex。
 *
 * 诚实边界：身份未确证（游客 / 邮箱未注册）→ 顶部黄条如实提示"关联可能不全"，不臆造项目 / 方案；
 * 本页**不改任何状态、不推进流程**，真实报价 / 收款 / 交付仍是人工（创始人域）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "留资工作流",
  robots: { index: false, follow: false },
};

function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return "—";
  }
}

const SOLUTION_BADGE: Record<string, { label: string; variant: "outline" | "warning" | "success" }> = {
  DRAFT: { label: "草稿", variant: "outline" },
  UNDER_HUMAN_REVIEW: { label: "审核中", variant: "warning" },
  PUBLISHED: { label: "已发布", variant: "success" },
};
const ORDER_BADGE: Record<string, { label: string; variant: "outline" | "warning" | "success" | "danger" }> = {
  PENDING: { label: "待支付", variant: "warning" },
  PAID: { label: "已支付", variant: "success" },
  REFUNDED: { label: "已退款", variant: "danger" },
  CANCELED: { label: "已取消", variant: "outline" },
};

function Stepper({ stages }: { stages: PipelineStage[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {stages.map((s, i) => (
        <li key={s.key} className="flex items-start gap-3">
          <span
            className={
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold " +
              (s.reached ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-500")
            }
            aria-hidden
          >
            {s.reached ? "✓" : i + 1}
          </span>
          <div className="flex flex-col">
            <span className={"text-sm font-semibold " + (s.reached ? "text-foreground" : "text-muted-foreground")}>
              {s.label}
            </span>
            <span className="text-[12px] text-muted-foreground">{s.detail}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Records({ v }: { v: LeadPipelineView }) {
  return (
    <div className="flex flex-col gap-4">
      {/* 项目 */}
      <Card>
        <CardContent>
          <div className="mb-2 text-sm font-semibold text-foreground">关联项目（{v.projects.length}）</div>
          {v.projects.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">尚未确证到该客户的任何项目。</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {v.projects.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Link href={`/workbench/projects/${p.id}`} className="font-medium text-primary hover:underline">
                    {p.name}
                  </Link>
                  <Badge variant="outline" compact>
                    {p.status}
                  </Badge>
                  <span className="text-muted-foreground">
                    情景 {p.scenarioCount} · 算通出报告 {p.computedCount}
                  </span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{fmtDateTime(p.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 方案 */}
      <Card>
        <CardContent>
          <div className="mb-2 text-sm font-semibold text-foreground">关联方案（{v.solutions.length}）</div>
          {v.solutions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">尚未由该客户导出任何方案卡片。</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {v.solutions.map((s) => {
                const b = SOLUTION_BADGE[s.status] ?? SOLUTION_BADGE.DRAFT;
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <Link href={`/admin/solutions/${s.id}`} className="font-medium text-primary hover:underline">
                      {s.title}
                    </Link>
                    <Badge variant={b.variant} compact>
                      {b.label}
                    </Badge>
                    <span className="text-muted-foreground">
                      {s.price == null ? "未定价" : `${s.currency === "USD" ? "$" : "¥"}${s.price}`}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{fmtDateTime(s.updatedAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 订单 */}
      <Card>
        <CardContent>
          <div className="mb-2 text-sm font-semibold text-foreground">关联订单（{v.orders.length}）</div>
          {v.orders.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">该客户暂无订单记录。</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {v.orders.map((o) => {
                const b = ORDER_BADGE[o.status] ?? ORDER_BADGE.PENDING;
                return (
                  <li key={o.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <Link href={`/admin/orders/${o.id}`} className="font-mono text-[12px] text-primary hover:underline">
                      {o.id}
                    </Link>
                    <Badge variant={b.variant} compact>
                      {b.label}
                    </Badge>
                    <span className="text-muted-foreground">
                      {o.currency === "USD" ? "$" : "¥"}
                      {o.amount}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{fmtDateTime(o.createdAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function AdminLeadPipelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const { id } = await params;
  const res = await getLeadPipeline(id);
  if (!res.ok) {
    if ("notFound" in res) notFound();
    return (
      <Container className="py-10">
        <Alert variant="warning" title="工作流视图暂不可用">
          {res.error}
        </Alert>
      </Container>
    );
  }

  const v = res.data;
  const STATUS_LABEL: Record<string, string> = { NEW: "待处理", CONTACTED: "已联系", CLOSED: "已归档" };

  return (
    <Container className="py-10 flex flex-col gap-6">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Link href="/admin/leads" className="hover:underline">
          ← 返回留资列表
        </Link>
      </div>

      <PageHeader
        title={`${v.lead.company} · 项目工作流`}
        description="把这条留资关联到的既有项目 / 情景 / 方案 / 订单，纯派生成一条从留资到成交的推进视图（只读，不改状态、不自动推进）。"
      />

      {/* 留资卡 */}
      <Card>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info" compact>
              来源：{v.lead.source}
            </Badge>
            <Badge variant={v.lead.status === "NEW" ? "warning" : v.lead.status === "CONTACTED" ? "outline" : "success"} compact>
              {STATUS_LABEL[v.lead.status] ?? v.lead.status}
            </Badge>
            <span className="text-sm font-semibold text-foreground">{v.lead.company}</span>
            <span className="text-xs text-muted-foreground">
              · {v.lead.contactName}
              {v.lead.role ? `（${v.lead.role}）` : ""}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">{fmtDateTime(v.lead.createdAt)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            <span>
              邮箱：<span className="font-mono text-foreground">{v.lead.email}</span>
            </span>
            {v.lead.phone ? (
              <span>
                电话：<span className="font-mono text-foreground">{v.lead.phone}</span>
              </span>
            ) : null}
            {v.lead.needType ? <span>需求类型：{v.lead.needType}</span> : null}
            {v.lead.projectRegion ? <span>项目地区：{v.lead.projectRegion}</span> : null}
            {v.lead.fleetSize ? <span>车辆规模：{v.lead.fleetSize}</span> : null}
            {v.lead.budgetRange ? <span>预算档位：{v.lead.budgetRange}</span> : null}
          </div>
          <div className="flex justify-end pt-1">
            <LeadStatusControl leadId={v.lead.id} current={v.lead.status} />
          </div>
        </CardContent>
      </Card>

      {!v.identityResolved ? (
        <Alert variant="warning" title="客户身份未确证">
          未在该留资邮箱上匹配到已注册账户，下方「项目 / 方案」可能关联不全（游客留资只能按邮箱匹配到订单）。
          如需完整跟踪，请引导客户用同一邮箱注册后在工作台推进。
        </Alert>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardContent>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">推进漏斗</span>
              <Badge variant="info" compact>
                当前：{v.pipeline.stages.find((s) => s.key === v.pipeline.furthest)?.label}
              </Badge>
            </div>
            <Stepper stages={v.pipeline.stages} />
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <div className="mb-3 text-sm font-semibold text-foreground">下一步（人工动作）</div>
            {v.pipeline.nextActions.length === 0 ? (
              <p className="text-[13px] text-emerald-700">已到「成交交付」，闭环完成。后续维护走常规客户成功流程。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {v.pipeline.nextActions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-foreground/90">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    {a}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
              提示：漏斗只反映**已有记录**的确证进度，不代表系统会自动推进。真实报价、收款、交付、法务确认均为人工环节。
            </p>
          </CardContent>
        </Card>
      </div>

      <Records v={v} />
    </Container>
  );
}
