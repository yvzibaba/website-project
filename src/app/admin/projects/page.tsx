import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { listAllProjectsForAdmin } from "@/server/sandbox-store";

/**
 * /admin/projects — 后台沙盘项目列表（Phase 4 模块 C，**只读**）。
 *
 * 双层门禁（与 /admin 首页同构）：layout 挡 UI，本页取数据前自鉴权 requireRole(STAFF_ROLES)，
 * 越权 return null。展示全量项目 + owner 归因 + 基线情景结果摘要（服务端引擎落库列，非页面数字）。
 * 刻意只读：后台不提供改参数/删项目入口——写操作只允许 owner 本人在沙盘内完成（SECURITY 属主边界）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台",
  robots: { index: false, follow: false },
};

function fmtMoneyWan(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
}

function fmtDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return "";
  }
}

export default async function AdminProjectsPage() {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  let items: Awaited<ReturnType<typeof listAllProjectsForAdmin>> = [];
  let dbError = false;
  try {
    items = await listAllProjectsForAdmin(100);
  } catch {
    dbError = true;
  }

  return (
    <Container className="py-10 flex flex-col gap-6">
      <PageHeader
        title="沙盘项目列表"
        description="全量用户项目总览（只读）。写操作只允许 owner 本人在沙盘内完成，后台不提供代改入口。"
      />

      {dbError ? (
        <Alert variant="warning" title="项目列表暂不可用">
          查询失败，请稍后刷新重试。
        </Alert>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            还没有保存任何沙盘项目。
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-muted-foreground dark:border-zinc-800">
                    <th className="py-2 pr-4 font-medium">项目</th>
                    <th className="py-2 pr-4 font-medium">Owner</th>
                    <th className="py-2 pr-4 font-medium">地区</th>
                    <th className="py-2 pr-4 font-medium">状态</th>
                    <th className="py-2 pr-4 font-medium">NPV</th>
                    <th className="py-2 pr-4 font-medium">IRR</th>
                    <th className="py-2 pr-4 font-medium">回收期</th>
                    <th className="py-2 pr-4 font-medium">计算状态</th>
                    <th className="py-2 font-medium">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => {
                    const b = p.scenarios[0] ?? null;
                    return (
                      <tr key={p.id} className="border-b border-zinc-100 dark:border-zinc-800/60">
                        <td className="py-2 pr-4">
                          {p.name}
                          {p.description ? (
                            <span className="block max-w-64 truncate text-[11px] text-muted-foreground">{p.description}</span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {p.owner?.email ?? (p.ownerId ? "（已注销）" : "匿名 dev")}
                        </td>
                        <td className="py-2 pr-4">{p.region?.name ?? "—"}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={p.status === "ACTIVE" ? "success" : "neutral"} compact>
                            {p.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4 tabular-nums">{b?.npv != null ? fmtMoneyWan(b.npv.toNumber()) : "—"}</td>
                        <td className="py-2 pr-4 tabular-nums">
                          {b?.irrPct != null ? `${b.irrPct.toNumber().toFixed(1)}%` : "—"}
                        </td>
                        <td className="py-2 pr-4 tabular-nums">
                          {b?.paybackYears != null ? `${b.paybackYears.toNumber().toFixed(1)} 年` : "—"}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant={b?.calcStatus === "ok" ? "success" : "warning"} compact>
                            {b?.calcStatus ?? "无基线"}
                          </Badge>
                        </td>
                        <td className="py-2 whitespace-nowrap tabular-nums text-muted-foreground">{fmtDate(p.updatedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              共 {items.length} 个项目（最多展示最近更新 100）。NPV/IRR/回收期为基线情景落库快照（Decimal 精确列），
              全部继承「占位假设 + 需专业人工确认」边界，不作投资依据。
            </p>
          </CardContent>
        </Card>
      )}

      <div className="text-sm">
        <Link href="/admin" className="text-muted-foreground hover:underline">
          ← 返回运行概览
        </Link>
      </div>
    </Container>
  );
}
