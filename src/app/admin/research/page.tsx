import type { Metadata } from "next";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import {
  listCandidates,
  CANDIDATE_STORE_VERSION,
  type CandidateRow,
} from "@app/kernel/server/candidate-store";
import {
  CANDIDATE_SCREENING_VERSION,
  SCREENING_THRESHOLDS,
  type ScreeningOutcome,
  type ScreeningVerdict,
} from "@app/kernel/lib/candidate-screening";
import { CandidateCreateForm } from "@/components/admin/CandidateCreateForm";
import { ReScreenButton } from "@/components/admin/ReScreenButton";

/**
 * /admin/research —— R8「上游产业项目池 · Research Workspace」骨架（mandate §八–§十一）。
 *
 * 边界（宪法「V1 只做核心闭环、能派生就不新增表」+ §十一「不做六行业页」）：
 *   - **一张表 / 一个视图 / 一条筛选流水线**：所有草料统一进 CandidateProject，按 verdict 四态分列，
 *     行业只是过滤项，**绝不为新能源 / 工业 / 交通 / 农林 / 教育 / 房产各造一份专属页**；
 *     首垂直是**新能源重卡**，但那是内容聚焦而非导航分叉（§十一）。
 *   - **裁决来自纯函数 `screenCandidate` 六闸留痕，非 LLM 打分**（§九「不要一个漂亮的 AI 分数」）。
 *   - **AI 产出恒为候选 · 人工核验不可跳过**（§十）：本 workspace 展示 `sourceType=AI_RESEARCH` 时
 *     显式挂"须人工核验"标；顶栏附一条流水线说明「Research → Evidence → Candidate → Human Verification
 *     → Benchmark/Project」，并钉死"AI 输出不得直接改基准/引擎"这条禁令（守卫测试同源）。
 *   - **表未 apply → 显式"CODE COMPLETE / REAL-WORLD INPUT PENDING"**（mandate §二十六）：
 *     生产迁移是创始人域，本文件遇到 P2021 时**不假装能列 / 不静默空数组**，而是渲染一条诚实提示。
 *
 * 双层门禁：layout 挡 UI + 本页自鉴权 `requireRole(STAFF_ROLES)`；越权 return null（不泄露"存在此页"）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "研究台 · 候选项目池",
  robots: { index: false, follow: false },
};

const VERDICT_LABEL: Record<ScreeningVerdict, string> = {
  CANDIDATE: "候选",
  REJECT: "拒绝",
  NEED_MORE_EVIDENCE: "待补证据",
  READY_FOR_PROJECT: "可立项",
};

const VERDICT_VARIANT: Record<ScreeningVerdict, "neutral" | "success" | "warning" | "danger" | "info"> = {
  CANDIDATE: "info",
  REJECT: "danger",
  NEED_MORE_EVIDENCE: "warning",
  READY_FOR_PROJECT: "success",
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  MANUAL: "人工",
  AI_RESEARCH: "AI 研究 · 须人工核验",
  IMPORT: "批量导入",
};

function readSnapshot(row: CandidateRow): ScreeningOutcome | null {
  const sr = row.screeningResult;
  if (!sr || typeof sr !== "object" || Array.isArray(sr)) return null;
  const o = sr as Record<string, unknown>;
  if (typeof o.verdict !== "string" || !Array.isArray(o.gates)) return null;
  return {
    verdict: o.verdict as ScreeningVerdict,
    gates: o.gates as ScreeningOutcome["gates"],
    reasons: Array.isArray(o.reasons) ? (o.reasons as string[]) : [],
    thresholds: SCREENING_THRESHOLDS, // 展示阈值常量以让审计一眼看懂
  };
}

function fmtDate(d: Date): string {
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

export default async function ResearchWorkspacePage() {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const res = await listCandidates({ limit: 100 });
  const tableMissing = !res.ok && "tableMissing" in res && res.tableMissing;
  const failed = !res.ok && !tableMissing;
  const rows: CandidateRow[] = res.ok ? res.data : [];

  return (
    <Container size="lg" className="py-8 space-y-6">
      <PageHeader
        title="研究台 · 上游产业项目池"
        description="广泛发现，极度聚焦。草料入池即由程序六闸筛查（非 AI 分数），AI 产出须人工核验方可提升。"
      />

      {/* §十 流水线说明（刻意常驻，不让用户忘记"AI 不得直改基准/引擎"这条硬约束） */}
      <Card>
        <CardContent className="pt-5 space-y-2">
          <div className="text-sm font-semibold">研究流水线（§十 · 不可跳步）</div>
          <div className="text-sm text-zinc-600 leading-6">
            Research → Evidence → Candidate → <b>Human Verification</b> → Benchmark / Project。
            AI 只做大量劳动，<b>不直接写基准 / 不直接改引擎</b>（守卫测试
            <code className="mx-1 px-1 rounded bg-zinc-100">tests/unit/r8-candidate-guard.test.ts</code>
            钉死 candidate 层连读都不读计算真源）。首垂直：<b>新能源重卡</b>（不建六行业分叉页）。
          </div>
          <div className="text-xs text-zinc-500">
            筛查版本 <code>screening@{CANDIDATE_SCREENING_VERSION}</code> · 持久层{" "}
            <code>store@{CANDIDATE_STORE_VERSION}</code> · 阈值：证据 ≥{" "}
            {SCREENING_THRESHOLDS.MIN_EVIDENCE_ITEMS} 条（置信 ≥ {SCREENING_THRESHOLDS.EVIDENCE_CONF_FLOOR}）·
            参数完整度 ≥ {Math.round(SCREENING_THRESHOLDS.PARAM_COMPLETENESS_FLOOR * 100)}%。
          </div>
        </CardContent>
      </Card>

      <CandidateCreateForm />

      {tableMissing ? (
        <Alert variant="warning">
          <div className="font-semibold mb-1">CODE COMPLETE / REAL-WORLD INPUT PENDING</div>
          <div className="text-sm leading-6">
            <code>CandidateProject</code> 表已在 <code>prisma/schema.prisma</code> 定义、迁移 SQL 已离线生成
            （<code>prisma/migrations/20260921160000_add_candidate_project/migration.sql</code>），但
            <b>尚未应用到数据库</b>。生产部署·迁移应用属创始人域（mandate §二十三 STOP），本页在应用后自动可用；
            纯函数六闸裁决与后端路由代码均已交付并通过单元测试。
          </div>
        </Alert>
      ) : null}

      {failed ? (
        <Alert variant="danger">读取失败：{"error" in res ? res.error : "未知"}</Alert>
      ) : null}

      {res.ok && rows.length === 0 ? (
        <Alert variant="info">
          池子还空。点右上「新增草料」录一条发现期项目——提交即由程序跑六闸给出 Candidate / Need More Evidence
          / Reject / Ready for Project 中的一种裁决（不产生「漂亮的 AI 分数」）。
        </Alert>
      ) : null}

      {rows.length > 0 ? (
        <div className="space-y-3">
          {rows.map((row) => {
            const snap = readSnapshot(row);
            const verdict = snap?.verdict ?? "CANDIDATE";
            return (
              <Card key={row.id}>
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={VERDICT_VARIANT[verdict]}>{VERDICT_LABEL[verdict]}</Badge>
                        <Badge variant="outline">{SOURCE_TYPE_LABEL[row.sourceType] ?? row.sourceType}</Badge>
                        <span className="text-xs text-zinc-500">v{row.version} · {fmtDate(row.createdAt)}</span>
                      </div>
                      <div className="mt-1 text-base font-semibold">{row.title}</div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        {row.industry} · {row.region || "未标地区"} · 来源：{row.source}
                      </div>
                      {row.description ? (
                        <div className="text-sm text-zinc-700 mt-2 whitespace-pre-wrap">{row.description}</div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <ReScreenButton candidateId={row.id} />
                    </div>
                  </div>

                  {snap && snap.reasons.length > 0 ? (
                    <details className="mt-3 text-xs text-zinc-600">
                      <summary className="cursor-pointer select-none">
                        逐闸留痕（{snap.gates.filter((g) => g.passed).length}/{snap.gates.length} 通过 · 点开看差什么）
                      </summary>
                      <ol className="mt-2 space-y-1">
                        {snap.gates.map((g, i) => (
                          <li key={i} className="flex gap-2">
                            <span className={g.passed ? "text-emerald-600" : "text-rose-600"}>
                              {g.passed ? "✓" : "✗"}
                            </span>
                            <span className="font-medium">{g.label}</span>
                            <span className="text-zinc-500">— {g.reason}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}

                  {snap && snap.reasons.length === 0 ? (
                    <div className="mt-2 text-xs text-emerald-700">全六闸通过 · 可交人工核验决定是否 PROMOTED 为 Case / Project</div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}
    </Container>
  );
}
