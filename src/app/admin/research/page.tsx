import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import {
  listCandidatesPage,
  CANDIDATE_STORE_VERSION,
  CANDIDATE_INDUSTRIES,
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
import { pageHref, sortHref, isSortedBy, paginationInfo } from "@/server/research-workspace-model";

/**
 * /admin/research —— R8「上游产业项目池 · Research Workspace」（mandate §六–§十一）。
 *
 * 分页 / 筛选 / 排序（§六）：全部走**同一** store 查询（`listCandidatesPage`，无第二套系统）；筛选支持
 *   verdict / industry / region，排序支持 createdAt / updatedAt（asc/desc），分页带 page/pageSize/total
 *   与上一页 / 下一页。**用纯 GET 表单 + Link 驱动 URL**（服务端组件读 searchParams），零客户端状态。
 *
 * 诚实与边界（§七 / §十 / §十一 / §二十六）：
 *   - 一行草料只显**事实**：verdict、逐闸通过数（=证据/参数缺口来自哪道闸）、unknowns 计数、创建时间——
 *     **绝不合成「综合分」**（mandate §七明令）；
 *   - 一张表 / 一个视图 / 一条筛选流水线，行业只是过滤项，**不为六行业各造页**（§十一，首垂直=新能源重卡）；
 *   - 裁决来自纯函数六闸留痕（非 AI 打分），AI 产出恒标「须人工核验」（§十）；
 *   - 表未 apply（P2021）→ 显式「CODE COMPLETE / REAL-WORLD INPUT PENDING」，不假装能列、不静默空数组。
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

type SearchParams = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

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

function countUnknowns(row: CandidateRow): number {
  return Array.isArray(row.unknowns) ? (row.unknowns as unknown[]).length : 0;
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

export default async function ResearchWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) return null;

  const sp = await searchParams;
  const filters: Record<string, string | undefined> = {
    verdict: one(sp.verdict) || one(sp.status), // status 与 verdict 同列，UI 统一按 verdict 呈现
    industry: one(sp.industry),
    region: one(sp.region),
    sortBy: one(sp.sortBy),
    sortDir: one(sp.sortDir),
  };
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const pageSize = Math.max(1, Math.min(Number(one(sp.pageSize)) || 20, 100));

  const res = await listCandidatesPage({ ...filters, page, pageSize });
  const tableMissing = !res.ok && "tableMissing" in res && res.tableMissing;
  const failed = !res.ok && !tableMissing;
  const rows: CandidateRow[] = res.ok ? res.data.rows : [];
  const total = res.ok ? res.data.total : 0;
  const pg = paginationInfo(total, pageSize, page);
  // 供分页/排序链接保留既有筛选（只覆盖页码/排序键）。
  const navBase: Record<string, string | undefined> = { ...filters, pageSize: String(pageSize) };
  delete navBase.status; // 已并入 verdict，避免重复键

  const sortLink = (field: string) => sortHref(navBase, field);
  const sortMark = (field: string) => {
    const dir = isSortedBy({ sortBy: filters.sortBy, sortDir: filters.sortDir }, field);
    return dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : "";
  };

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
            纯函数六闸裁决、分页/筛选后端与 UI 骨架均已交付并通过单元测试（下表为空因真实库尚无此表，非代码缺陷）。
          </div>
        </Alert>
      ) : null}

      {failed ? (
        <Alert variant="danger">读取失败：{"error" in res ? res.error : "未知"}</Alert>
      ) : null}

      {/* 筛选栏（§六/§七）：纯 GET 表单驱动 URL，无客户端状态、无综合分数。 */}
      {!tableMissing ? (
        <Card>
          <CardContent className="pt-5">
            <form method="get" action="/admin/research" className="flex flex-wrap items-end gap-3 text-sm">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Verdict</span>
                <select name="verdict" defaultValue={filters.verdict ?? ""} className="rounded border border-zinc-300 px-2 py-1">
                  <option value="">全部</option>
                  <option value="READY_FOR_PROJECT">可立项</option>
                  <option value="CANDIDATE">候选</option>
                  <option value="NEED_MORE_EVIDENCE">待补证据</option>
                  <option value="REJECT">拒绝</option>
                  <option value="PROMOTED">已提升</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">行业</span>
                <select name="industry" defaultValue={filters.industry ?? ""} className="rounded border border-zinc-300 px-2 py-1">
                  <option value="">全部</option>
                  {CANDIDATE_INDUSTRIES.map((ind) => (
                    <option key={ind} value={ind}>{ind}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">地区</span>
                <input
                  name="region"
                  defaultValue={filters.region ?? ""}
                  placeholder="如 山西"
                  className="rounded border border-zinc-300 px-2 py-1"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">每页</span>
                <select name="pageSize" defaultValue={String(pageSize)} className="rounded border border-zinc-300 px-2 py-1">
                  {[10, 20, 50, 100].map((n) => (
                    <option key={n} value={String(n)}>{n}</option>
                  ))}
                </select>
              </label>
              <input type="hidden" name="sortBy" value={filters.sortBy ?? "createdAt"} />
              <input type="hidden" name="sortDir" value={filters.sortDir ?? "desc"} />
              <button type="submit" className="rounded bg-zinc-900 text-white px-3 py-1.5">筛选</button>
              <Link href="/admin/research" className="rounded border border-zinc-300 px-3 py-1.5 text-zinc-600">
                重置
              </Link>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {res.ok && rows.length === 0 ? (
        <Alert variant="info">
          池子在此筛选下为空。点上方「新增草料」录一条发现期项目——提交即由程序跑六闸给出 Candidate /
          Need More Evidence / Reject / Ready for Project 中的一种裁决（不产生「漂亮的 AI 分数」）。
        </Alert>
      ) : null}

      {rows.length > 0 ? (
        <>
          {/* 排序表头 + 总数 */}
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>共 {total} 条 · 第 {pg.safePage}/{pg.pageCount} 页</span>
            <span className="flex gap-3">
              <Link href={sortLink("createdAt")} className="underline decoration-dotted">
                创建时间{sortMark("createdAt")}
              </Link>
              <Link href={sortLink("updatedAt")} className="underline decoration-dotted">
                更新时间{sortMark("updatedAt")}
              </Link>
            </span>
          </div>

          <div className="space-y-3">
            {rows.map((row) => {
              const snap = readSnapshot(row);
              const verdict = snap?.verdict ?? "CANDIDATE";
              const passed = snap ? snap.gates.filter((g) => g.passed).length : 0;
              const gateCount = snap ? snap.gates.length : 0;
              const evidenceGap = snap ? gateCount - passed : null;
              return (
                <Card key={row.id}>
                  <CardContent className="pt-5">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={VERDICT_VARIANT[verdict]}>{VERDICT_LABEL[verdict]}</Badge>
                          <Badge variant="outline">{SOURCE_TYPE_LABEL[row.sourceType] ?? row.sourceType}</Badge>
                          <span className="text-xs text-zinc-500">
                            v{row.version} · 创建 {fmtDate(row.createdAt)} · 更新 {fmtDate(row.updatedAt)}
                          </span>
                        </div>
                        <div className="mt-1 text-base font-semibold">{row.title}</div>
                        <div className="text-xs text-zinc-500 mt-0.5">
                          {row.industry} · {row.region || "未标地区"} · 来源：{row.source}
                        </div>
                        {/* §七 逐条显事实：闸通过数 / 缺口 / unknowns 计数（不合成综合分） */}
                        <div className="text-xs text-zinc-600 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>六闸通过：{passed}/{gateCount}</span>
                          {evidenceGap != null && evidenceGap > 0 ? (
                            <span className="text-amber-700">未过闸（缺口）：{evidenceGap}</span>
                          ) : null}
                          <span>Unknown 数量：{countUnknowns(row)}</span>
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
                          逐闸留痕（{passed}/{gateCount} 通过 · 点开看差什么）
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

          {/* 分页条（page/pageSize/total + prev/next + 页码窗口 · mandate §六） */}
          {pg.pageCount > 1 ? (
            <nav className="flex items-center justify-center gap-1 pt-2 text-sm" aria-label="分页">
              {pg.hasPrev ? (
                <Link href={pageHref(navBase, pg.safePage - 1)} className="px-2 py-1 rounded border border-zinc-300">
                  上一页
                </Link>
              ) : (
                <span className="px-2 py-1 rounded border border-zinc-200 text-zinc-400">上一页</span>
              )}
              {pg.pages.map((p) =>
                p === pg.safePage ? (
                  <span key={p} className="px-3 py-1 rounded bg-zinc-900 text-white">{p}</span>
                ) : (
                  <Link key={p} href={pageHref(navBase, p)} className="px-3 py-1 rounded border border-zinc-300">
                    {p}
                  </Link>
                ),
              )}
              {pg.hasNext ? (
                <Link href={pageHref(navBase, pg.safePage + 1)} className="px-2 py-1 rounded border border-zinc-300">
                  下一页
                </Link>
              ) : (
                <span className="px-2 py-1 rounded border border-zinc-200 text-zinc-400">下一页</span>
              )}
            </nav>
          ) : null}
        </>
      ) : null}
    </Container>
  );
}
