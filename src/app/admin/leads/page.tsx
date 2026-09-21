import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { listLeads, LEAD_SOURCES, type LeadAdminItem, type LeadStatus } from "@/server/leads";
import { LeadStatusControl } from "@/components/admin/LeadStatusControl";

/**
 * /admin/leads — 后台留资（RFQ）列表（V1.1 P4 · 商业闭环人工跟进的接收端）。
 *
 * 双层门禁（与 /admin/feedback 同构）：layout 挡 UI，本页取数据前自鉴权 `requireRole(STAFF_ROLES)`，
 * 越权 return null（留资含企业 / 邮箱 / 电话等隐私，绝不进越权响应）。
 * 支持 `?status=NEW|CONTACTED|CLOSED` 过滤（服务端读取，非法值当无过滤）。
 * force-dynamic + noindex（继承 layout metadata）。
 *
 * 刻意边界：
 *   - 提供「列表 + 详情展开 + 逐条跟进状态回写」（V1.1 P6 补 P4 尾巴：`LeadStatusControl` →
 *     POST `/api/admin/leads/[id]/status`，走 `requireStaffWrite` + CSRF，数据层幂等）；
 *     仍**不做 CRM 集成 / 邮件通知 / 自动派单**（宪法：更少依赖）。
 *   - 「1 个工作日内联系」是**流程 SLA**、不是系统能力；本页只帮你读得清楚、改状态留痕，不发任何提醒。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台",
  robots: { index: false, follow: false },
};

const SOURCE_LABEL: Record<string, string> = {
  enterprise: "企业页",
  report: "决策报告尾",
  pricing: "方案定价位",
};

const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "待处理",
  CONTACTED: "已联系",
  CLOSED: "已归档",
};

function fmtDateTime(d: Date): string {
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
    return "";
  }
}

function LeadRow({ l }: { l: LeadAdminItem }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info" compact>{SOURCE_LABEL[l.source] ?? l.source}</Badge>
          <Badge variant={l.status === "NEW" ? "warning" : l.status === "CONTACTED" ? "outline" : "success"} compact>
            {STATUS_LABEL[l.status as LeadStatus] ?? l.status}
          </Badge>
          <span className="text-sm font-semibold text-foreground">{l.company}</span>
          <span className="text-xs text-muted-foreground">
            · {l.contactName}
            {l.role ? `（${l.role}）` : ""}
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">{fmtDateTime(l.createdAt)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span>邮箱：<span className="font-mono text-foreground">{l.email}</span></span>
          {l.phone ? <span>电话：<span className="font-mono text-foreground">{l.phone}</span></span> : null}
          {l.projectStage ? <span>项目阶段：{l.projectStage}</span> : null}
          {l.projectRegion ? <span>项目地区：{l.projectRegion}</span> : null}
          {l.fleetSize ? <span>车辆规模：{l.fleetSize}</span> : null}
          {l.needType ? <span>需求类型：{l.needType}</span> : null}
          {l.budgetRange ? <span>预算档位：{l.budgetRange}</span> : null}
        </div>

        {l.message ? (
          <p className="whitespace-pre-wrap rounded-md border border-dashed border-border bg-muted/30 p-2 text-[13px] leading-6 text-foreground/90">
            {l.message}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {l.submitterUserEmail ? (
            <span>登录提交者：<span className="font-mono">{l.submitterUserEmail}</span></span>
          ) : (
            <span>游客提交（凭其自填邮箱联系）</span>
          )}
          {l.page ? <span>来源页面：<span className="font-mono">{l.page}</span></span> : null}
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          <Link
            href={`/admin/leads/${l.id}`}
            className="text-[12px] font-medium text-primary hover:underline"
          >
            查看工作流 →
          </Link>
          <LeadStatusControl leadId={l.id} current={l.status} />
        </div>
      </CardContent>
    </Card>
  );
}

export default async function AdminLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const sp = await searchParams;
  const statusRaw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status: LeadStatus | undefined =
    statusRaw === "NEW" || statusRaw === "CONTACTED" || statusRaw === "CLOSED" ? statusRaw : undefined;

  const res = await listLeads({ status, limit: 100 });
  const items = res.ok ? res.items : [];
  const newCount = res.ok ? items.filter((l) => l.status === "NEW").length : 0;

  const filters: Array<{ label: string; href: string; active: boolean }> = [
    { label: `全部${res.ok ? `（${items.length}）` : ""}`, href: "/admin/leads", active: !status },
    {
      label: `待处理${res.ok && !status ? `（${newCount}）` : ""}`,
      href: "/admin/leads?status=NEW",
      active: status === "NEW",
    },
    { label: "已联系", href: "/admin/leads?status=CONTACTED", active: status === "CONTACTED" },
    { label: "已归档", href: "/admin/leads?status=CLOSED", active: status === "CLOSED" },
  ];

  return (
    <Container className="py-10 flex flex-col gap-6">
      <PageHeader
        title="留资（RFQ）列表"
        description="企业询价意向。逐条按邮箱 / 电话人工跟进，并可就地点「待处理 / 已联系 / 已归档」回写状态；无自动通知、无 CRM 同步（跟进结果只在本表留痕）。"
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">筛选：</span>
        {filters.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={
              t.active
                ? "rounded-full border border-blue-500 bg-blue-50 px-3 py-1 text-xs text-blue-700"
                : "rounded-full border border-input px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      <Alert variant="info" title="落位来源">
        留资来自三处：<Badge variant="outline" compact>{SOURCE_LABEL[LEAD_SOURCES[0]]}</Badge>{" "}
        <Badge variant="outline" compact>{SOURCE_LABEL[LEAD_SOURCES[1]]}</Badge>{" "}
        <Badge variant="outline" compact>{SOURCE_LABEL[LEAD_SOURCES[2]]}</Badge>。
        source 字段已在每条上标出，`page` 是提交时 URL 路径（辅助定位）。
      </Alert>

      {!res.ok ? (
        <Alert variant="warning" title="留资列表暂不可用">
          查询失败，请稍后刷新重试。
        </Alert>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {status ? `没有状态为「${STATUS_LABEL[status]}」的留资。` : "还没有收到任何留资。"}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((l) => (
            <LeadRow key={l.id} l={l} />
          ))}
        </div>
      )}
    </Container>
  );
}
