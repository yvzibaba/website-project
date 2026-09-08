import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import { listUsersForAdmin } from "@/server/users";

/**
 * /admin/users — 后台用户列表（Phase 4 模块 C，**只读**）。
 *
 * 双层门禁（与 /admin 首页同构）：layout 挡 UI，本页取数据前自鉴权 requireRole(STAFF_ROLES)，
 * 越权 return null（用户邮箱等隐私绝不进越权响应）。刻意只读、不开改角色/删号入口——
 * 权限提升属高风险操作，仍走 user:promote 脚本（总指令 §十一：高风险须停止汇报，不猜不绕）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台",
  robots: { index: false, follow: false },
};

const ROLE_LABEL: Record<string, "success" | "info" | "neutral"> = {
  ADMIN: "success",
  REVIEWER: "info",
  USER: "neutral",
};
const ROLE_TEXT: Record<string, string> = {
  ADMIN: "管理员",
  REVIEWER: "审核员",
  USER: "普通用户",
};

function fmtDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return "";
  }
}

export default async function AdminUsersPage() {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const res = await listUsersForAdmin(200);
  const items = res.ok ? res.items : [];

  return (
    <Container className="py-10 flex flex-col gap-6">
      <PageHeader
        title="用户列表"
        description="注册用户总览（只读）。角色变更走 user:promote 脚本——后台不开改角色入口，防误操作。"
      />

      {!res.ok ? (
        <Alert variant="warning" title="用户列表暂不可用">
          查询失败，请稍后刷新重试。
        </Alert>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            还没有注册用户。
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-muted-foreground dark:border-zinc-800">
                    <th className="py-2 pr-4 font-medium">邮箱</th>
                    <th className="py-2 pr-4 font-medium">昵称</th>
                    <th className="py-2 pr-4 font-medium">角色</th>
                    <th className="py-2 pr-4 font-medium">订单</th>
                    <th className="py-2 pr-4 font-medium">沙盘项目</th>
                    <th className="py-2 pr-4 font-medium">邮箱验证</th>
                    <th className="py-2 font-medium">注册时间</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => (
                    <tr key={u.id} className="border-b border-zinc-100 dark:border-zinc-800/60">
                      <td className="py-2 pr-4 font-mono text-xs">{u.email}</td>
                      <td className="py-2 pr-4">{u.name ?? "—"}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={ROLE_LABEL[u.role] ?? "neutral"} compact>
                          {ROLE_TEXT[u.role] ?? u.role}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{u._count.orders}</td>
                      <td className="py-2 pr-4 tabular-nums">{u._count.projects}</td>
                      <td className="py-2 pr-4">{u.emailVerified ? "已验证" : "未验证"}</td>
                      <td className="py-2 whitespace-nowrap tabular-nums text-muted-foreground">{fmtDate(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              共 {items.length} 个用户（最多展示最近 200）。如需排查某用户数据，用 id 查询：
              <span className="font-mono"> {items.length > 0 ? items[0].id.slice(0, 8) : "—"}…</span>（完整 id 见数据库）。
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
