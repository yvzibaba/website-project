/**
 * 沙盘「导出产业方案」面板（中途重构 R8.2 · 总控最高优先级「商业闭环」的 UI 兑现点）。
 *
 * 这是把 R0–R7 的沙盘结果**推进到「案例→方案→查看→购买」真闭环**的那一步：把 R8.1 纯映射桥
 * （`solution-draft.ts`）现算出的产业方案草案，连同**人亲自挑定的案例（caseId）**与拟定价格，
 * POST 到受「登录 + 属主 + CSRF」门禁的 `/api/workbench/solution`（V1.1 P4 买家闭环修复：不再要求
 * staff 角色；带来源情景/项目指针时服务端核验其归当前用户），落成一条真实 **DRAFT** `Solution`——
 * 随后可在方案后台补真实数据、经人工审核发布上架、进入查看→购买（Order）。
 *
 * 诚实与边界（宪法第 7/16/20/21 条 + 「AI 做劳动、人做关键决策」）：
 *   - **本组件只搬运、绝不本地算数**：草案由 `buildSolutionDraft`（确定性、无 DB/网络）现算，
 *     数字逐字来自引擎与视图模型；面板不重算、不改写任何指标。
 *   - **接案是人的决策**：`Solution.caseId` 是必填外键（R6.4 regionId 的 P2003 教训），故案例必须由人
 *     从公开案例清单（`GET /api/cases`，V1.1 P4 起买家可选池）里显式挑定，绝不自动挂/凭空造；没挑案例不让导出。
 *   - **只落 DRAFT、绝不自动发布**：草案 `needsProfessionalReview=true` 且带**发布阻塞清单**，面板把这些
 *     阻塞项如实回显（「还差这些才能发布」），是否/何时上架由人在后台决定。
 *   - **权限诚实**：端点要求登录（任意角色）+ 来源属主核验；未登录引导登录，越权/开关关闭如实提示。
 */

"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";
import type { CalcResult } from "@app/kernel/server/project-model";
import type { DecisionViewModel } from "@app/kernel/lib/decision-view";
import type { EnterpriseProfile } from "@app/kernel/server/profiles";
import { buildSolutionDraft, SOLUTION_VERSION } from "@app/kernel/lib/solution-draft";

interface CaseOption {
  id: string;
  title: string;
  industryName: string;
  stage: string;
}

interface ExportResult {
  solutionId: string;
  financialCount?: number;
  unknownCount?: number;
  warnings?: string[];
  publishBlockers?: string[];
  /** V1.1 P6：调用者是否 staff（服务端按会话角色注入）。决定成功提示里给不给 staff-only 的后台链接。 */
  isStaff?: boolean;
}

/**
 * 从 `GET /api/cases`（公开橱窗清单）回体里尽力挑出可展示的字段；字段缺失时回落（不因个别字段缺失而整表崩）。
 * V1.1 P4 #13：买家可选池 = 公开案例，字段与公开 API 保持一致（id/title/industryName/stage）。
 * 这里只做防御式收窄，不做业务判断。
 */
function toCaseOption(raw: unknown): CaseOption | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  if (!id) return null;
  return {
    id,
    title: typeof r.title === "string" ? r.title : id,
    industryName: typeof r.industryName === "string" ? r.industryName : "—",
    stage: typeof r.stage === "string" ? r.stage : "—",
  };
}

export function SolutionExportPanel({
  calc,
  vm,
  regionName,
  profile,
  savedSource,
}: {
  /** 引擎对**当前**情景的 CalcResult；面板据此现算草案（§9 读最新结果）。 */
  calc: CalcResult;
  /** 与 calc 配套的视图模型（金额/百分比串的单一真源）。 */
  vm: DecisionViewModel;
  regionName: string;
  /** R7 企业画像（通用=undefined）。 */
  profile?: EnterpriseProfile;
  /** R8.6 反查关联：当前情景若已「保存为项目」，这里带上服务端派生的 {projectId, scenarioId}；未保存为 null。 */
  savedSource?: { projectId: string; scenarioId: string } | null;
}) {
  const [projectName, setProjectName] = useState("");
  const [scenarioName, setScenarioName] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<"CNY" | "USD">("CNY");

  // slug：默认跟随草案（中文标题会回落成稳定占位串），用户可显式改写；改过即固定不再被草案覆盖。
  const [slugOverride, setSlugOverride] = useState<string | null>(null);

  const [cases, setCases] = useState<CaseOption[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState("");
  const [casesLoaded, setCasesLoaded] = useState(false);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  // V1.1 P4：买家闭环——401→引导登录；403→服务端如实回传越权/开关原因，走通用 error 通道，
  // 不再单独维护 needStaff 状态（旧「审核员 / 管理员门禁」的语义在 P4 已不复存在）。

  // 客户端现算草案（无 DB/网络）；面板只在 vm.ok 时挂载（工作台已门禁），仍对 !ok 兜底显示原因。
  const draft = useMemo(
    () =>
      buildSolutionDraft({
        calc,
        vm,
        regionName,
        projectName,
        scenarioName,
        profile,
        price,
        currency,
      }),
    [calc, vm, regionName, projectName, scenarioName, profile, price, currency],
  );
  const draftOk = draft.ok ? draft : null;
  const effectiveSlug = slugOverride ?? draftOk?.slug ?? "";

  const loadCases = useCallback(async () => {
    // 先 await 外部请求，再在响应回调里 setState（避免在 effect 体内同步 setState 触发级联渲染）。
    // V1.1 P4 #13：买家可选案例池 = 公开橱窗清单（/api/cases，恒非 DEMO、仅公开阶段、免登录），
    // 不再走 staff-only 的 /api/admin/cases——否则普通登录买家根本拉不到可挂靠的案例。
    const res = await mutateJson("/api/cases?limit=50", "GET");
    if (!res.ok) {
      setCasesLoading(false);
      setCasesError(res.message ?? "案例清单加载失败");
      return;
    }
    const rawItems = (res.data as { items?: unknown[] })?.items;
    const list = Array.isArray(rawItems) ? rawItems.map(toCaseOption).filter((c): c is CaseOption => c !== null) : [];
    setCasesLoading(false);
    setCases(list);
    setCasesLoaded(true);
    setCasesError(null);
    setNeedLogin(false);
  }, []);

  async function exportSolution() {
    if (!draftOk) {
      setError("当前参数不足以生成方案草案，请先回到沙盘修正参数（引擎/视图未产出有效结果）。");
      return;
    }
    if (!caseId) {
      setError("请先从下拉里选择一个真实存在的案例（方案必须挂在一个已有案例下，不能凭空创建）。");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    const body = {
      caseId,
      title: draftOk.title,
      slug: effectiveSlug,
      summary: draftOk.summary,
      body: draftOk.body,
      riskDomains: draftOk.riskDomains,
      needsProfessionalReview: draftOk.needsProfessionalReview,
      price: draftOk.price,
      currency: draftOk.currency,
      financials: draftOk.financials,
      unknowns: draftOk.unknowns,
      publishBlockers: draftOk.publishBlockers,
      // R8.6：把来源情景指针随草案上行；未保存情景则 undefined（服务端亦会二次验存，绝不虚构关联）。
      sandboxSource: savedSource ?? undefined,
    };
    const res = await mutateJson("/api/workbench/solution", "POST", body);
    setBusy(false);
    if (res.status === 401) {
      setNeedLogin(true);
      setError(res.message ?? "导出产业方案需要登录");
      return;
    }
    if (res.status === 403) {
      // V1.1 P4：403 现在有两种来源——① 来源属主核验失败（导出了别人的项目/情景）；
      // ② 导出权益开关关闭（未来接计费/订阅时用）。服务端已回传具体原因，如实透出即可。
      setNeedLogin(false);
      setError(res.message ?? "当前账号无权导出该沙盘方案");
      return;
    }
    if (!res.ok) {
      setNeedLogin(false);
      const hint = fieldHints(res.fields).join("；");
      setError((res.message ?? "导出失败") + (hint ? `：${hint}` : ""));
      return;
    }
    const d = (res.data ?? {}) as Partial<ExportResult> & { solutionId?: string };
    if (d.solutionId) {
      setResult({
        solutionId: d.solutionId,
        financialCount: d.financialCount,
        unknownCount: d.unknownCount,
        warnings: d.warnings,
        publishBlockers: d.publishBlockers ?? draftOk.publishBlockers,
        isStaff: d.isStaff,
      });
    } else {
      setError("服务端未回传方案 id，请刷新方案后台确认是否已建成。");
    }
  }

  const canExport = draftOk != null && caseId !== "" && !busy;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">导出产业方案（进「案例 → 方案 → 购买」闭环）</CardTitle>
            <CardDescription>
              把当前沙盘结果（地区 / 画像 / 参数下的确定性经济与技术结论）导出成一条
              <span className="font-medium"> 草稿产业方案</span>，挂到你在下方选定的真实案例上。
              数字全部由引擎现算、逐字搬运，导出后仍需人工补真实数据、定价并经人工审核发布后方可上架售卖。
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-[10px]">
            草案口径 v{SOLUTION_VERSION}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {!draftOk ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            当前情景无法生成方案草案：{draft.ok ? "" : `${draft.error.reason} · ${draft.error.detail}`}
            <span className="mt-1 block text-xs">请先在沙盘左侧补齐必备参数、消除非法输入后重试。</span>
          </div>
        ) : (
          <>
            {/* 案例选择（人做接案决策 · 必填外键） */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-sol-case">
                  挂靠的真实案例（必填 · 方案须挂在一个已有案例下）
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCasesLoading(true);
                    void loadCases();
                  }}
                  disabled={casesLoading}
                >
                  {casesLoading ? "加载中…" : "刷新案例"}
                </Button>
              </div>
              {cases.length > 0 ? (
                <select
                  id="sbx-sol-case"
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                  className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
                >
                  <option value="">— 请选择一个已有案例 —</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}（{c.industryName} · {c.stage}）
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex flex-col gap-1">
                  {casesLoading ? (
                    <p className="inline-flex items-center gap-2 text-[11px] leading-snug text-zinc-500">
                      <Spinner className="h-3.5 w-3.5" /> 正在加载真实案例…
                    </p>
                  ) : casesError ? (
                    <p className="text-[11px] leading-snug text-rose-600">{casesError}</p>
                  ) : casesLoaded ? (
                    <p className="text-[11px] leading-snug text-zinc-500">
                      暂无可挂靠的案例。请先在案例后台创建一个真实案例，再回来（点右上「刷新案例」）导出产业方案。
                    </p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] leading-snug text-zinc-500">
                        导出前需挂靠一个真实存在的案例（方案必须挂在已有案例下，不能凭空创建）。
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setCasesLoading(true);
                          void loadCases();
                        }}
                      >
                        加载案例清单
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 项目 / 情景名（喂给草案标题；不改任何数字） */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-sol-name">
                  项目名称（默认「沙盘产业项目方案」）
                </label>
                <Input
                  id="sbx-sol-name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="例如：大同港电重卡补能场站"
                  maxLength={120}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-sol-scen">
                  情景名（默认「基准情景」）
                </label>
                <Input
                  id="sbx-sol-scen"
                  value={scenarioName}
                  onChange={(e) => setScenarioName(e.target.value)}
                  placeholder="例如：电价上调后"
                  maxLength={120}
                />
              </div>
            </div>

            {/* slug（可编辑，中文默认回落稳定串；撞唯一约束会回错并保留可改） */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-sol-slug">
                URL slug（小写字母 / 数字 / 连字符；默认由标题生成）
              </label>
              <Input
                id="sbx-sol-slug"
                value={effectiveSlug}
                onChange={(e) => setSlugOverride(e.target.value)}
                placeholder={draftOk.slug}
                maxLength={128}
              />
            </div>

            {/* 价格 + 币种（可空=未定价 → 记入发布阻塞；发布时才硬性要求） */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-sol-price">
                  拟定价格（可选，十进制正数；未定价仍可存为草稿，但不能发布上架）
                </label>
                <Input
                  id="sbx-sol-price"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="例如：18000.00"
                  inputMode="decimal"
                  maxLength={20}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-sol-currency">
                  币种
                </label>
                <select
                  id="sbx-sol-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as "CNY" | "USD")}
                  className="h-[38px] rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                >
                  <option value="CNY">CNY</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>

            {/* R8.6 来源关联的诚实提示：仅在已「保存为项目」时才挂反查指针，否则如实说明不挂。 */}
            {savedSource ? (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-snug text-sky-800">
                将同时记录<strong>来源关联</strong>：本方案会标注派生自当前已保存的沙盘情景（
                <code className="mx-0.5 rounded bg-sky-100 px-1">{savedSource.scenarioId.slice(0, 8)}…</code>），
                便于日后从该情景反查此方案。服务端会二次核验情景确实存在后才落库。
              </div>
            ) : (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] leading-snug text-zinc-500">
                当前情景<strong>尚未保存为项目</strong>，导出的方案不会挂来源关联（无从反查它出自哪版沙盘参数）。
                如需可追溯关联，先用「保存 / 版本」保存本情景再导出。
              </div>
            )}

            {/* 草案摘要（预览，逐字来自 draft） */}
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-600">
              <div className="mb-1 font-medium text-zinc-700">{draftOk.title}</div>
              <p>{draftOk.summary}</p>
            </div>

            {/* 发布阻塞清单（机器可校验，如实回显「还差这些才能发布」） */}
            {draftOk.publishBlockers.length > 0 ? (
              <div className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <div className="text-xs font-medium text-amber-800">发布前须解除的阻塞项（存为草稿不受影响）：</div>
                <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-snug text-amber-800">
                  {draftOk.publishBlockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <Button type="button" size="sm" onClick={exportSolution} disabled={!canExport}>
              {busy ? "导出中…" : "导出并保存为方案（草稿）"}
            </Button>
          </>
        )}

        {busy ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner className="h-4 w-4" /> 正在落库…
          </div>
        ) : null}

        {needLogin ? (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            导出产业方案需要登录后再操作。
            <Link href="/login?callbackUrl=%2Fworkbench" className="ml-1 underline">
              前往登录
            </Link>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        ) : null}

        {result ? (
          <div className="flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">已存为草稿方案</Badge>
              <span className="text-xs text-emerald-700">
                财务条目 {result.financialCount ?? 0} · 关键未知 {result.unknownCount ?? 0}
              </span>
            </div>
            {result.isStaff ? (
              <div>
                已生成方案 id
                <code className="mx-1 rounded bg-emerald-100 px-1 py-0.5 text-[11px]">{result.solutionId.slice(0, 10)}…</code>
                <Link href={`/admin/solutions/${result.solutionId}`} className="ml-1 underline">
                  到方案后台查看 / 编辑 / 发布
                </Link>
              </div>
            ) : (
              <div className="text-[12px] leading-snug text-emerald-800">
                已生成方案 id
                <code className="mx-1 rounded bg-emerald-100 px-1 py-0.5 text-[11px]">{result.solutionId.slice(0, 10)}…</code>
                ——已提交进入人工审核队列。这份方案目前是草稿：真实可核验数据、定价与是否发布都要由人来完成，
                你这边暂时不能自助查看或上架。
                <Link href="/enterprise" className="ml-1 font-medium underline">
                  在「企业咨询」留个联系方式
                </Link>
                ，我们会带着测算结果跟进你。
              </div>
            )}
            {result.warnings?.length ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-amber-700">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] leading-snug text-emerald-700/90">
              提示：方案当前是草稿、入参为未经核实的示例数据，尚不可对外售卖；请在后台以来源可追溯的真实数据替换、定价并
              经人工审核发布（高风险领域须专业人工确认）后再上架，接入「查看 → 购买」闭环。
            </p>
          </div>
        ) : null}

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
          导出的每一个数字均由确定性引擎现算、逐字搬运（面板与桥均不重算），全部继承「示例参数·未经核实 + 需专业人工确认」；
          「是否挂靠哪个案例、价格定多少、何时发布」属商业 / 法律责任，始终由人裁决（AI 只做劳动）。
        </div>
      </CardContent>
    </Card>
  );
}
