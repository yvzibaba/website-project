import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { NewCaseForm } from "@/components/admin/NewCaseForm";
import { INDUSTRIES } from "@/server/industries";
import { listAdminCases } from "@/server/admin-cases";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin/cases — 案例管理（Phase 13 M2，最小后台写 UI 的第一块竖切）。
 *
 * 双层门禁（沿用 Phase 6 M2 教训）：layout 挡可见 UI，本页取任何数据前**再自鉴权**，
 * 越权直接 `return null`——否则 Next 会为 leaf page 段生成 RSC flight 泄露后台数据。
 *
 * 组成：① 全量案例列表（含候选态 / DEMO 夹具，`listAdminCases`，非公开橱窗）；
 *       ② `NewCaseForm` 客户端表单，POST 到 Phase 13 M1 的 `/api/admin/cases`（唯一写门禁）。
 *   刻意只做「列表 + 新建」这一条闭环；详情/证据/删除/方案编辑留 M3+（简单优先，一次一个明确任务）。
 * force-dynamic（依赖会话 + 实时数据）+ noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "案例管理",
  robots: { index: false, follow: false },
};

const STAGE_LABEL: Record<string, string> = {
  CANDIDATE: "候选",
  KEY_RESEARCH: "重点研究",
  DEEP_CASE: "深度案例",
  KEY_SOLUTION: "重点方案",
  PREMIUM_SOLUTION: "精品方案",
};
const STAGE_ORDER = ["CANDIDATE", "KEY_RESEARCH", "DEEP_CASE", "KEY_SOLUTION", "PREMIUM_SOLUTION"] as const;

const STAGE_VARIANT: Record<string, "neutral" | "info" | "success" | "warning"> = {
  CANDIDATE: "neutral",
  KEY_RESEARCH: "info",
  DEEP_CASE: "success",
  KEY_SOLUTION: "success",
  PREMIUM_SOLUTION: "success",
};

function fmtDate(d: Date): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return "";
  }
}

export default async function AdminCasesPage() {
  // 页面自守：越权时 listAdminCases 根本不被调用，敏感数据不进响应。
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const [list] = await Promise.all([listAdminCases()]);

  const industryOptions = INDUSTRIES.map((i) => ({ value: i.enum, label: i.name }));
  const stageOptions = STAGE_ORDER.map((s) => ({ value: s, label: STAGE_LABEL[s] ?? s }));

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title="案例管理"
        description="录入与浏览全部案例（含候选态与研究中间态）。写入经服务端角色与 CSRF 校验，操作记入审计流水。"
      />

      <div className="text-sm">
        <Link href="/admin" className="text-muted-foreground hover:underline">
          ← 返回运行概览
        </Link>
      </div>

      <NewCaseForm industries={industryOptions} stages={stageOptions} defaultStage="CANDIDATE" />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">案例列表</h2>
          <span className="text-sm text-muted-foreground">
            共 {list.total} 条{list.truncated ? `（首屏最多显示 ${list.items.length} 条）` : ""}
          </span>
        </div>

        {!list.ok ? (
          <Alert variant="danger" title="加载失败">
            {list.error || "案例数据暂时不可用，请稍后重试。"}
          </Alert>
        ) : list.items.length === 0 ? (
          <Alert variant="info" title="还没有案例">
            用上方表单创建第一条真实案例。DEMO 夹具（若有）也会在此列出以便区分。
          </Alert>
        ) : (
          <div className="flex flex-col gap-2">
            {list.items.map((c) => (
              <Card key={c.id}>
                <CardContent className="flex flex-col gap-2 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.title}</span>
                    {c.isDemo ? <Badge variant="warning">DEMO</Badge> : null}
                    <Badge variant={STAGE_VARIANT[c.stage] ?? "neutral"}>{STAGE_LABEL[c.stage] ?? c.stage}</Badge>
                    <Badge variant="neutral">{c.industryName}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">v{c.version} · {fmtDate(c.updatedAt)}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span>证据 {c.evidenceCount}</span>
                    <span>方案 {c.solutionCount}</span>
                    <span>机会分 {c.opportunityScore ?? "—"}</span>
                    <span>可信度 {c.evidenceConfidence ?? "—"}</span>
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
