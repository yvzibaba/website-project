import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Container, Card, CardContent, CardHeader, CardTitle, CardDescription, Badge } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { getAdminDashboardData } from "@/server/admin";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin 首页 — 运行概览（Phase 6 M2，总控 §13「后台必须有权限控制」+ 管理侧验收）。
 *
 * 双层门禁（纵深防御）：
 *   - layout.tsx 的 requireRole 负责**可见 UI**：未登录跳 /login、越权渲染「无访问权限」面板；
 *   - **本页在取任何数据前先自鉴权**（requireRole），未授权直接 return null。这一步是关键安全边界——
 *     实测 Next App Router 会为 leaf page 段生成 RSC flight 负载（即使 layout 未渲染 children），
 *     若只在 layout 挡、页面照拉数据，概览内容仍会被序列化进 HTML（HTTP 冒烟曾实测到此泄露）。
 *     页面自守 → 越权时 getAdminDashboardData 根本不被调用，敏感聚合数据绝不进入响应。
 *
 * 展示：案例/方案/用户/证据/订单的实时计数与分维度分布 + 最近 ChangeLog（审计流水，呼应 M5 案例 CRUD）。
 *   全部数字来自 DB 聚合，绝不缓存/编造（宪法第 20 条）。force-dynamic + noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // 标题取中性的「管理后台」（与 layout 一致），越权时页面虽不渲染数据、但 metadata 仍生效，避免用
  // 「运行概览」等仅后台可见的措辞作为可被探测的指纹。
  title: "管理后台",
  robots: { index: false, follow: false },
};

const STAGE_LABEL: Record<string, string> = {
  CANDIDATE: "候选",
  KEY_RESEARCH: "重点研究",
  DEEP_CASE: "深度案例",
  KEY_SOLUTION: "重点方案",
  PREMIUM_SOLUTION: "精品方案",
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  UNDER_HUMAN_REVIEW: "人工审核中",
  PUBLISHED: "已发布",
};
const ROLE_LABEL: Record<string, string> = {
  USER: "普通用户",
  REVIEWER: "审核员",
  ADMIN: "管理员",
};
const ACTION_LABEL: Record<string, string> = {
  CREATE: "创建",
  UPDATE: "更新",
  DELETE: "删除",
  ROLLBACK: "回滚",
};

function Chips({ map, labels }: { map: Record<string, number>; labels?: Record<string, string> }) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <Badge key={k} variant="neutral" className="tabular-nums">
          {(labels?.[k] ?? (k === "NONE" ? "未标注" : k))} {v}
        </Badge>
      ))}
    </div>
  );
}

function StatCard({ title, total, children }: { title: string; total: number; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="text-3xl font-semibold tabular-nums">{total}</div>
        {children}
      </CardContent>
    </Card>
  );
}

export default async function AdminDashboardPage() {
  // 取数据前先自鉴权（纵深防御）：越权 → 返回 null，敏感概览聚合根本不被调用/序列化。
  const res = await requireRole(STAFF_ROLES);
  if (!res.ok) return null;

  const data = await getAdminDashboardData(20);

  return (
    <Container className="py-10 flex flex-col gap-6">
      <PageHeader
        title="运行概览"
        description={`实时聚合，生成于 ${data.generatedAt.toLocaleString("zh-CN")}。全部数字来自数据库查询，非缓存值。`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="案例" total={data.cases.total}>
          <Chips map={data.cases.byStage} labels={STAGE_LABEL} />
        </StatCard>
        <StatCard title="解决方案" total={data.solutions.total}>
          <Chips map={data.solutions.byStatus} labels={STATUS_LABEL} />
        </StatCard>
        <StatCard title="用户" total={data.users.total}>
          <Chips map={data.users.byRole} labels={ROLE_LABEL} />
        </StatCard>
        <StatCard title="证据条目" total={data.evidences.total}>
          <Chips map={data.evidences.byGrade} />
        </StatCard>
        <StatCard title="订单" total={data.orders.total}>
          <span className="text-xs text-muted-foreground">购买闭环将于 Phase 12 接入。</span>
        </StatCard>
        <StatCard title="内容入口" total={0}>
          <div className="flex flex-col gap-1 text-sm">
            <Link href="/cases" className="hover:underline">公开案例列表 →</Link>
            <Link href="/solutions" className="hover:underline">已发布方案列表 →</Link>
          </div>
        </StatCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>最近审计流水（ChangeLog）</CardTitle>
          <CardDescription>
            后台/数据层写操作留痕（宪法第 13 条版本化 / §13 管理员操作审计）。当前由 Phase 7 M5 案例 CRUD 数据层写入。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无审计记录。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-muted-foreground dark:border-zinc-800">
                    <th className="py-2 pr-4 font-medium">时间</th>
                    <th className="py-2 pr-4 font-medium">对象</th>
                    <th className="py-2 pr-4 font-medium">操作</th>
                    <th className="py-2 pr-4 font-medium">操作者</th>
                    <th className="py-2 font-medium">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentChanges.map((c) => (
                    <tr key={c.id} className="border-b border-zinc-100 dark:border-zinc-800/60">
                      <td className="py-2 pr-4 whitespace-nowrap tabular-nums text-muted-foreground">
                        {c.createdAt.toLocaleString("zh-CN")}
                      </td>
                      <td className="py-2 pr-4">
                        <span className="font-mono text-xs">{c.entityType}</span>
                        <span className="ml-1 font-mono text-xs text-muted-foreground">{c.entityId.slice(0, 8)}</span>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge variant={c.action === "DELETE" ? "danger" : c.action === "CREATE" ? "success" : "info"}>
                          {ACTION_LABEL[c.action] ?? c.action}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{c.changedBy ?? "—"}</td>
                      <td className="py-2 text-muted-foreground">{c.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Container>
  );
}
