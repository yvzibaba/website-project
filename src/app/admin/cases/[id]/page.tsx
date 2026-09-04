import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { EditCaseMetaForm } from "@/components/admin/EditCaseMetaForm";
import { AdminCaseEvidences } from "@/components/admin/AdminCaseEvidences";
import { DeleteCaseButton } from "@/components/admin/DeleteCaseButton";
import { CaseOpportunityScoreForm } from "@/components/admin/CaseOpportunityScoreForm";
import { getAdminCaseDetail } from "@/server/admin-cases";
import { OPPORTUNITY_DIMENSIONS } from "@/server/scoring";
import { INDUSTRIES } from "@/server/industries";
import { requireRole, STAFF_ROLES } from "@/server/authz";

/**
 * /admin/cases/[id] — 案例「内容编辑台」（Phase 13 M5）。
 *
 * 为什么：Phase 13 M2 只能「列表 + 新建」案例，M1 早备好 PATCH/DELETE/证据增删的写端点却**没有 UI 消费**——
 * 想补一条证据、改个阶段、删个录错的候选案例，都得裸调 API。案例是「案例发现→拆解」闭环的源头数据，
 * 缺编辑台直接卡住证据可信度与机会分的积累（宪法最高优先级：商业闭环 > 用户价值）。本页把一份案例的
 * 可编辑面（基本信息 / 证据逐条增删 / 删除）收敛到一处，**零 schema、零新数据层写逻辑**，全复用 M1 已测端点
 * （第 16 条单一真源）。证据增删在数据层内联动复算 evidenceConfidence，保存后 router.refresh 拉回服务端标量。
 *
 * 有意延后：regionId / businessModelId 的关联选择器留后续（需额外数据源，V1 简单优先）。
 *
 * M5b 补齐：本页新增 10 维度机会评分录入台（`CaseOpportunityScoreForm`）。机会分**一律由服务端复算**
 * （`updateCase` → `recomputeCaseScores`，程序计算 > 前端口算，且前端可被绕过），客户端只做即时校验与预览；
 * 保存后 `router.refresh()` 拉回服务端复算结果，渲染到下方只读「评分明细」审计卡（区分事实/假设/推断/预测的证据可信度联动）。
 *
 * 双层门禁：layout 挡可见 UI，本页取数据前**再自鉴权** requireRole(STAFF)、越权 return null——否则 Next 会为
 * leaf page 段生成 RSC flight 泄露未公开案例（含 CANDIDATE/KEY_RESEARCH 中间态与 DEMO 夹具）。
 * force-dynamic + noindex（后台数据，绝不进搜索引擎）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "编辑案例",
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
const STAGE_VARIANT: Record<string, "neutral" | "info" | "success"> = {
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

export default async function AdminCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // 先自鉴权，越权 → 直接 null，getAdminCaseDetail 根本不被调用、案例内容不进响应。
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const { id } = await params;
  const detail = await getAdminCaseDetail(id);
  if (detail.notFound) notFound();
  if (!detail.ok || !detail.data) {
    return (
      <Container className="py-10">
        <Alert variant="danger" title="加载失败">
          {detail.error || "案例数据暂时不可用，请稍后重试。"}
        </Alert>
      </Container>
    );
  }

  const c = detail.data;
  const industryOptions = INDUSTRIES.map((i) => ({ value: i.enum, label: i.name }));
  const stageOptions = STAGE_ORDER.map((s) => ({ value: s, label: STAGE_LABEL[s] ?? s }));

  return (
    <Container className="flex flex-col gap-6 py-8">
      <div className="text-sm">
        <Link href="/admin/cases" className="text-muted-foreground hover:underline">
          ← 返回案例管理
        </Link>
      </div>

      <PageHeader title={`编辑案例：${c.title}`} description="维护基本信息与逐条证据；证据的类型 / 来源 / 置信度联动决定证据可信度。删除前须先下架该案例下的已发布方案。" />

      <div className="flex flex-wrap items-center gap-2">
        {c.isDemo ? <Badge variant="warning">DEMO</Badge> : null}
        <Badge variant={STAGE_VARIANT[c.stage] ?? "neutral"}>{STAGE_LABEL[c.stage] ?? c.stage}</Badge>
        <Badge variant="neutral">{c.industryName}</Badge>
        <span className="text-xs text-muted-foreground tabular-nums">v{c.version}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">更新于 {fmtDate(c.updatedAt)}</span>
        <Link href={`/cases/${c.id}${c.isDemo ? "?demo=1" : ""}`} className="text-xs text-muted-foreground underline">
          公开橱窗预览 →
        </Link>
      </div>

      {/* 只读评分快照（服务端复算标量）：此处仅展示，权威机会分从不来自客户端计算。 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
          <span>
            机会分：<span className="font-semibold tabular-nums">{c.opportunityScore ?? "—"}</span>
          </span>
          <span>
            证据可信度：<span className="font-semibold tabular-nums">{c.evidenceConfidence ?? "—"}</span>
          </span>
          <span>
            证据数：<span className="tabular-nums">{c.evidenceCount}</span>
          </span>
          <span>
            关联方案：<span className="tabular-nums">{c.solutionCount}</span>（已发布 {c.publishedSolutionCount}）
          </span>
          <span className="text-xs text-muted-foreground">
            {c.hasScoreBreakdown ? "机会分由服务端复算，明细见下方审计卡；改分请用下方录入台。" : "尚未评分——用下方录入台填全 10 维度后自动复算。"}
          </span>
        </CardContent>
      </Card>

      {/* M5b：10 维度机会评分录入台（保存 → updateCase → recomputeCaseScores → router.refresh 回显明细）。 */}
      <CaseOpportunityScoreForm
        caseId={c.id}
        dimensions={OPPORTUNITY_DIMENSIONS.map((d) => ({ key: d.key, label: d.label, max: d.max, polarity: d.polarity }))}
        initial={c.scoreInput}
        currentScore={c.opportunityScore}
      />

      {/* 只读评分明细审计卡：仅当已复算落库且有逐维度拆解时渲染（结构漂移则诚实缺省，不渲染半截数据）。 */}
      {c.scoreBreakdown?.opportunityBreakdown ? (
        <Card>
          <CardContent className="py-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">评分明细（服务端复算 · 只读）</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                公式版本 v{c.scoreBreakdown.rubricVersion}
              </span>
            </div>
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">维度</th>
                    <th className="px-3 py-2 font-medium text-right">录入 / 满分</th>
                    <th className="px-3 py-2 font-medium text-right">计入总分</th>
                  </tr>
                </thead>
                <tbody>
                  {c.scoreBreakdown.opportunityBreakdown.map((row) => (
                    <tr key={row.key} className="border-t border-border">
                      <td className="px-3 py-2">
                        {row.label}
                        {row.polarity === "inverse" ? <span className="ml-1 text-xs text-muted-foreground">（反向）</span> : null}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{`${row.raw} / ${row.max}`}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{row.contribution}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border bg-muted/30 font-semibold">
                    <td className="px-3 py-2">合计</td>
                    <td className="px-3 py-2 text-right tabular-nums">{` / ${c.scoreBreakdown.opportunityMax}`}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.scoreBreakdown.opportunityScore ?? "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>{`证据可信度 ${c.scoreBreakdown.evidenceConfidence}（${c.scoreBreakdown.evidenceCount} 条证据）`}</span>
              <span>{`事实 ${c.scoreBreakdown.evidenceByType.FACT} · 假设 ${c.scoreBreakdown.evidenceByType.ASSUMPTION} · 推断 ${c.scoreBreakdown.evidenceByType.INFERENCE} · 预测 ${c.scoreBreakdown.evidenceByType.PREDICTION}`}</span>
              <span>{`关键未知变量 ${c.scoreBreakdown.unknownVariableCount}（非事实类证据）`}</span>
            </div>
            {c.scoreBreakdown.issues.length > 0 ? (
              <Alert variant="warning" className="mt-3 py-2">
                {`复算提示：${c.scoreBreakdown.issues.join("；")}`}
              </Alert>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">
              机会分仅表达相对优先级，与证据可信度、关键未知变量数一并解读——综合评分 ≠ 项目一定成功。
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-end">
        <DeleteCaseButton caseId={c.id} title={c.title} publishedSolutionCount={c.publishedSolutionCount} />
      </div>

      <EditCaseMetaForm
        caseId={c.id}
        industries={industryOptions}
        stages={stageOptions}
        initial={{
          title: c.title,
          titleEn: c.titleEn,
          summary: c.summary,
          summaryEn: c.summaryEn,
          sourceUrl: c.sourceUrl,
          sourceType: c.sourceType,
          industry: c.industry,
          stage: c.stage,
        }}
      />

      <AdminCaseEvidences caseId={c.id} items={c.evidences} />

      <Card>
        <CardContent className="py-4 text-xs text-muted-foreground">
          本页所有写操作经服务端 CSRF 同源 + 角色门禁（`requireStaffWrite`），并逐条写入审计流水（`ChangeLog`，宪法第 13 条）。
          证据增删会在数据层联动复算证据可信度（区分事实 / 假设 / 推断 / 预测，来源可追溯）；删除案例仍挂已发布方案时会被服务端拒绝。
        </CardContent>
      </Card>
    </Container>
  );
}
