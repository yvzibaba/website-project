"use client";

/**
 * V2 决策报告 · 「导出为商业方案草案」面板（R7-A · 商业闭环最小加性桥）。
 *
 * ## 这个面板只做一件事，且刻意保守
 * 把当前展示的**已算通的决策报告**，通过 `POST /api/workbench/decision/scenarios/[id]/export`
 * 导出成一条 **DRAFT** `Solution`（挂上财务条目与关键未知），交进平台既有的
 * 「后台发布 → 定价 → Order → 已付费解锁」商品链。**绝不自动发布、绝不自动定价、绝不重算**。
 *
 * ## 铁律
 *   - **不产任何数字**：溯源条（引擎/模型/基准/输入指纹/生成时刻）**逐字取自** `report.provenance`；
 *     面板不本地拼接、不本地格式化、不做任何参与结论的运算。若这里出现"顺手换算一下"，
 *     报告与商品就会各说一套——那正是本项目最不能接受的失败方式。
 *   - **未算通 = 不可导**：`calcStatus !== "ok"` 或 `report == null` 直接禁用按钮 + 明说为什么。
 *     服务端也会二次拒（映射函数 `ok:false`），双保险，绝不给脏数据编一份看起来能卖的商品。
 *   - **恒 DRAFT，不冒充可售**：导出成功后回显服务端带来的 `publishBlockers`——那是一份**机器可校验**
 *     的"还差这些才能发布"清单，让创始人 / 专业复核人一眼看清离上架还缺什么。
 *   - **两类调用者不同出口**：staff 直达 `/admin/solutions`；买家只回显 solutionId 与人工跟进引导，
 *     **绝不给只对 staff 开放的 /admin 链接**（点了必撞 403，V1.1 P6 老坑）。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { mutateJson } from "@/components/admin/mutate";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import type { DecisionReportData } from "./DecisionReportView";

interface CaseLite {
  id: string;
  title: string;
}

interface ExportOkPayload {
  solutionId?: string;
  financialCount?: number;
  unknownCount?: number;
  warnings?: string[];
  publishBlockers?: string[];
  isStaff?: boolean;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

export function DecisionExportPanel({
  scenarioId,
  scenarioName,
  scenarioVersion,
  calcStatus,
  report,
}: {
  scenarioId: string;
  scenarioName: string;
  scenarioVersion?: number;
  calcStatus: string;
  report: DecisionReportData | null;
}) {
  const [cases, setCases] = useState<CaseLite[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<"CNY" | "USD">("CNY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportOkPayload | null>(null);

  const loadCases = useCallback(async () => {
    setCasesLoading(true);
    setCasesError(null);
    try {
      const res = await mutateJson(`/api/cases?limit=50`, "GET");
      if (!res.ok) {
        setCases([]);
        setCasesError(res.message ?? "案例列表载入失败");
        return;
      }
      const items = ((res.data ?? {}).items as Array<Record<string, unknown>> | undefined) ?? [];
      setCases(items.map((c) => ({ id: String(c.id), title: String(c.title) })));
    } finally {
      setCasesLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      setCasesLoading(true);
      return mutateJson(`/api/cases?limit=50`, "GET").then((res) => {
        if (!alive) return;
        if (!res.ok) {
          setCases([]);
          setCasesError(res.message ?? "案例列表载入失败");
        } else {
          const items = ((res.data ?? {}).items as Array<Record<string, unknown>> | undefined) ?? [];
          setCases(items.map((c) => ({ id: String(c.id), title: String(c.title) })));
        }
        setCasesLoading(false);
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  const exportable = calcStatus === "ok" && report != null;

  async function onExport() {
    setError(null);
    setResult(null);
    if (!caseId) {
      setError("请先选择一个用于挂靠的产业案例（Case）—— Solution.caseId 是必填外键。");
      return;
    }
    if (price && !/^\d+(\.\d{1,6})?$/.test(price.trim())) {
      setError("价格必须是不含负号的十进制数字（最多 6 位小数），留空表示未定价。");
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { caseId, currency };
      if (price.trim()) body.price = price.trim();
      const res = await mutateJson(
        `/api/workbench/decision/scenarios/${encodeURIComponent(scenarioId)}/export`,
        "POST",
        body,
      );
      if (!res.ok) {
        if (res.status === 401) {
          setError("请先登录后再导出。");
        } else if (res.status === 403) {
          setError(res.message ?? "无权导出（该情景不属于你、或导出功能暂未开放）。");
        } else {
          const fields = res.fields ? Object.values(res.fields).flat().filter(Boolean).join("；") : "";
          setError(fields || res.message || "导出失败");
        }
        return;
      }
      setResult((res.data ?? {}) as ExportOkPayload);
    } finally {
      setBusy(false);
    }
  }

  const p = report?.provenance;

  return (
    <Card>
      <CardHeader>
        <CardTitle>导出为商业方案草案</CardTitle>
        <p className="text-sm text-muted-foreground">
          把这份报告投成一条 <strong>DRAFT</strong> 产业方案（挂财务 + 关键未知 + 溯源），接进既有的
          后台发布 → 定价 → 购买闭环。<strong>不重算、不自动发布、不自动定价</strong>；下面每个数字都是
          报告里那一份，导出只是搬运。
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!exportable ? (
          <Alert variant="warning" title="当前情景不可导出">
            只有 <code>calcStatus=ok</code> 且已有决策报告的情景才能导出为商品。若本报告缺失，请先重算通过。
          </Alert>
        ) : null}

        {p ? (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              将随草案一起落库的溯源（逐字取自 <code>report.provenance</code>，前端不拼接、不换算）
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">情景</dt>
                <dd className="font-mono">
                  {scenarioName}
                  {scenarioVersion != null ? ` · v${scenarioVersion}` : ""}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">情景 ID</dt>
                <dd className="font-mono">{p.scenarioId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">引擎</dt>
                <dd className="font-mono">{p.engineVersion}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">模型</dt>
                <dd className="font-mono">{p.modelVersion}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">基准参数</dt>
                <dd className="font-mono">{p.benchmarkVersion ?? "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">输入指纹</dt>
                <dd className="font-mono">{p.inputHash ?? "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">生成时刻</dt>
                <dd className="font-mono">{fmtDateTime(p.generatedAtIso)}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="挂靠案例（必填外键）" className="sm:col-span-3">
            <div className="flex flex-col gap-1">
              <select
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
                disabled={!exportable || busy || casesLoading}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">
                  {casesLoading ? "载入案例中…" : cases.length === 0 ? "暂无可选案例（请先在 /admin/cases 建一条）" : "请选择一个案例…"}
                </option>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              {casesError ? (
                <span className="text-xs text-destructive">
                  {casesError}（也可以
                  <button
                    type="button"
                    className="mx-1 underline decoration-dotted hover:decoration-solid"
                    onClick={() => void loadCases()}
                  >
                    重试载入
                  </button>
                  ）
                </span>
              ) : null}
            </div>
          </Field>

          <Field label="对外价格（可空 = 未定价）">
            <Input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="留空表示未定价（会记入发布阻塞项）"
              inputMode="decimal"
              maxLength={20}
              disabled={!exportable || busy}
            />
          </Field>

          <Field label="币种">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value === "USD" ? "USD" : "CNY")}
              disabled={!exportable || busy}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="CNY">CNY 人民币</option>
              <option value="USD">USD 美元</option>
            </select>
          </Field>
        </div>

        {error ? <Alert variant="danger" title="导出未成功">{error}</Alert> : null}

        <div>
          <Button
            onClick={() => void onExport()}
            disabled={!exportable || busy || !caseId}
          >
            {busy ? "导出中…" : "导出为 DRAFT 商业方案草案"}
          </Button>
          {!exportable ? (
            <span className="ml-3 text-xs text-muted-foreground">未算通 / 无报告，禁用导出。</span>
          ) : !caseId ? (
            <span className="ml-3 text-xs text-muted-foreground">请先选择挂靠案例。</span>
          ) : null}
        </div>

        {result?.solutionId ? (
          <Alert variant="success" title="导出成功 · 尚未发布">
            <div className="flex flex-col gap-2">
              <div>
                已生成 DRAFT Solution：<code className="font-mono">{result.solutionId}</code>
                {result.financialCount != null ? ` · 财务条目 ${result.financialCount} 条` : ""}
                {result.unknownCount != null ? ` · 关键未知 ${result.unknownCount} 条` : ""}。
              </div>
              <div className="text-xs text-muted-foreground">
                {result.isStaff ? (
                  <>
                    你是 staff：可到
                    <Link className="mx-1 underline decoration-dotted hover:decoration-solid" href="/admin/solutions">
                      /admin/solutions
                    </Link>
                    补齐真实数据 / 定价并走 publishGuard 发布。
                  </>
                ) : (
                  <>
                    你是买家：草案已挂在你名下，进入正式上架 / 购买需平台方补齐真实数据与定价；
                    可在工作台联系入口留个话，人工跟进。
                  </>
                )}
              </div>
              {result.warnings?.length ? (
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Alert>
        ) : null}

        {result?.publishBlockers?.length ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">发布前仍需处理（服务端回显，非工程侧决定）</div>
            <ul className="list-disc pl-5 text-xs">
              {result.publishBlockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
