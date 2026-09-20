"use client";

/**
 * 预测 vs 实测偏差面板（R6 · M13 · §21）。
 *
 * 只做**只读展示**：把「当初存档的预测」和「后来回填的实测」逐指标对齐摆在一起，
 * 让偏差、方向、影响一目了然——但**不改任何模型、不生成候选**（那是 CalibrationPanel 的事）。
 *
 * 四类对象刻意用不同视觉标记区分（§22）：
 *   预测 FORECAST（中性） · 实测 ACTUAL（信息蓝） · 偏差 DEVIATION（按方向着色） · 影响 IMPACT（金额，按正负着色）。
 *
 * 诚实纪律：
 *   - 没测（null）显示「未测」而不是 0；预测为 0 时百分比不可算显示「—（除零）」而非 -100%；
 *   - 口径/单位不一致或该期没有同口径预测，如实标「不可比」，绝不硬凑一个偏差数出来。
 */

import { useCallback, useEffect, useState } from "react";
import type {
  DeviationAnalysis,
  DeviationPoint,
  ImpactEstimate,
  MetricAnalysis,
} from "@app/kernel/engine/deviation";
import { mutateJson } from "@/components/admin/mutate";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { fmtMoney, fmtNum, SimpleTable } from "./primitives";

/** 年度偏差状态 → 徽章（人话 + 颜色）。逐月复用同一映射，保证同状态同色不漂移。 */
const STATUS_BADGE: Record<string, { text: string; variant: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  COMPARABLE: { text: "可比", variant: "neutral" },
  MATCH: { text: "吻合", variant: "success" },
  ZERO_FORECAST: { text: "预测为0", variant: "warning" },
  MISSING_FORECAST: { text: "无同口径预测", variant: "info" },
  MISSING_ACTUAL: { text: "未实测", variant: "info" },
  NOT_COMPARABLE: { text: "不可比", variant: "danger" },
};

function StatusBadge({ status }: { status: string }) {
  const hit = STATUS_BADGE[status] ?? { text: status, variant: "neutral" as const };
  return <Badge variant={hit.variant} compact>{hit.text}</Badge>;
}

/** 有符号百分比：正=实测高于预测（预测低估）标绿，负=实测低于预测（预测高估）标红。缺值→「—」。 */
function PctText({ v }: { v: number | null }) {
  if (v == null || !Number.isFinite(v)) return <span className="text-muted-foreground">—</span>;
  const cls = v > 0 ? "text-success" : v < 0 ? "text-danger" : "text-foreground";
  return <span className={`tabular-nums font-medium ${cls}`}>{`${v > 0 ? "+" : ""}${v.toFixed(1)}%`}</span>;
}

/** 金额影响：正=比预测多花的钱（红，成本上升），负=省下的钱（绿）。 */
function ImpactText({ v }: { v: number | null }) {
  if (v == null || !Number.isFinite(v)) return <span className="text-muted-foreground">—</span>;
  const cls = v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-foreground";
  return <span className={`tabular-nums font-medium ${cls}`}>{fmtMoney(v)}</span>;
}

/** 单点值 + 单位（kWh/元）；空值一律「—」，绝不显示 0 冒充。 */
function valueCell(p: DeviationPoint | null, field: "forecast" | "actual"): string {
  const v = p ? p[field] : null;
  if (v == null) return p?.status === "MISSING_ACTUAL" ? "未测" : "—";
  return fmtNum(v, 2);
}

export function DeviationPanel({ projectId, scenarioId }: { projectId: string; scenarioId: string | null }) {
  const [analysis, setAnalysis] = useState<DeviationAnalysis | null>(null);
  const [impacts, setImpacts] = useState<ImpactEstimate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    const qs = scenarioId ? `?scenarioId=${encodeURIComponent(scenarioId)}` : "";
    const res = await mutateJson(`/api/workbench/decision/projects/${projectId}/deviation${qs}`, "GET");
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? "偏差分析载入失败");
      return;
    }
    const data = (res.data ?? {}) as { analysis?: DeviationAnalysis; impacts?: ImpactEstimate[] };
    setAnalysis(data.analysis ?? null);
    setImpacts(data.impacts ?? []);
  }, [projectId, scenarioId]);

  useEffect(() => {
    let alive = true;
    const qs = scenarioId ? `?scenarioId=${encodeURIComponent(scenarioId)}` : "";
    mutateJson(`/api/workbench/decision/projects/${projectId}/deviation${qs}`, "GET").then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setError(res.message ?? "偏差分析载入失败");
        return;
      }
      const data = (res.data ?? {}) as { analysis?: DeviationAnalysis; impacts?: ImpactEstimate[] };
      setAnalysis(data.analysis ?? null);
      setImpacts(data.impacts ?? []);
    });
    return () => {
      alive = false;
    };
  }, [projectId, scenarioId]);

  if (error) {
    return (
      <Alert variant="danger" title="无法载入偏差分析">
        {error}
        <div className="mt-2">
          <Button size="sm" variant="secondary" onClick={load} disabled={busy}>
            {busy ? "载入中…" : "重试"}
          </Button>
        </div>
      </Alert>
    );
  }
  if (!analysis) return <p className="text-sm text-muted-foreground">正在对照预测与实测…</p>;

  const identity = analysis.identity;
  const metricsWithAnnual = analysis.metrics.filter((m) => m.annual != null) as Array<MetricAnalysis & { annual: DeviationPoint }>;
  const metricsWithMonthly = analysis.metrics.filter((m) => m.monthly.length > 0 && m.monthly.some((p) => p.forecast != null));

  return (
    <div className="flex flex-col gap-4">
      {/* 四类对象图例（§22：视觉上区分预测/实测/偏差/影响） */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>对照四类对象：</span>
        <Badge variant="neutral" compact>预测 FORECAST</Badge>
        <Badge variant="info" compact>实测 ACTUAL</Badge>
        <Badge variant="success" compact>偏差（实测高于预测）</Badge>
        <Badge variant="danger" compact>偏差（实测低于预测）</Badge>
        <Badge variant="outline" compact>影响 IMPACT（元）</Badge>
      </div>

      {identity ? (
        <Card>
          <CardContent className="grid gap-2 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><span className="text-muted-foreground">预测所依据引擎：</span><span className="tabular-nums">{identity.engineVersion ?? "—"}</span></div>
            <div><span className="text-muted-foreground">基准版本：</span><span className="tabular-nums">{identity.benchmarkVersion ?? "—"}</span></div>
            <div><span className="text-muted-foreground">输入指纹：</span><span className="tabular-nums">{identity.inputHash ?? "—"}</span></div>
            <div><span className="text-muted-foreground">地区：</span>{identity.regionId ?? "未标注"}</div>
          </CardContent>
        </Card>
      ) : null}

      <Alert variant={analysis.anyComparable ? "info" : "warning"} title="对照结论">
        {analysis.headline}
        {!analysis.forecastAvailable ? "（该项目还没有可对照的存档预测——偏差分析必须有当初冻结的预测做基准，不会用今天的模型回头编一个预测。）" : null}
      </Alert>

      {/* 完整度概览（§10） */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="text-xs text-muted-foreground">实测行 / 年度</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{analysis.completeness.actualRowCount} / {analysis.completeness.annualActualCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="text-xs text-muted-foreground">可比较点</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{analysis.completeness.comparablePoints}</div>
        </div>
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="text-xs text-muted-foreground">未实测 / 无预测</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{analysis.completeness.missingActualPoints} / {analysis.completeness.missingForecastPoints}</div>
        </div>
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="text-xs text-muted-foreground">不可比（口径/单位）</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{analysis.completeness.notComparablePoints}</div>
        </div>
      </div>

      {/* 年度：逐指标预测 vs 实测 vs 偏差 */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">逐指标对照（年度）</h3>
        <SimpleTable
          columns={["指标", "口径", "预测", "实测", "绝对偏差", "百分比偏差", "方向", "状态"]}
          align={["left", "left", "right", "right", "right", "right", "left", "left"]}
          rows={metricsWithAnnual.map((m) => {
            const a = m.annual;
            const dir = a.direction === "actual_above" ? "实测更高" : a.direction === "actual_below" ? "实测更低" : a.direction === "match" ? "吻合" : "—";
            return [
              m.label,
              m.basis,
              valueCell(a, "forecast") + (m.unit === "元" ? " 元" : m.unit === "kWh" ? " kWh" : ""),
              valueCell(a, "actual") + (m.unit === "元" ? " 元" : m.unit === "kWh" ? " kWh" : ""),
              a.absoluteDeviation == null ? "—" : (a.absoluteDeviation > 0 ? "+" : "") + fmtNum(a.absoluteDeviation, 1),
              <PctText key="p" v={a.percentageDeviation} />,
              dir,
              <StatusBadge key="s" status={a.status} />,
            ];
          })}
        />
      </div>

      {/* 逐月：仅对有同口径逐月预测的指标（当前=光伏）展开 */}
      {metricsWithMonthly.map((m) => (
        <div key={m.metricKey}>
          <h3 className="mb-2 text-sm font-semibold">逐月对照 · {m.label}（仅此指标有同口径逐月预测）</h3>
          <SimpleTable
            columns={["月份", "预测", "实测", "绝对偏差", "百分比偏差", "状态"]}
            align={["left", "right", "right", "right", "right", "left"]}
            rows={m.monthly.map((p) => [
              `${p.periodMonth} 月`,
              valueCell(p, "forecast"),
              valueCell(p, "actual"),
              p.absoluteDeviation == null ? "—" : (p.absoluteDeviation > 0 ? "+" : "") + fmtNum(p.absoluteDeviation, 1),
              <PctText key="p" v={p.percentageDeviation} />,
              <StatusBadge key="s" status={p.status} />,
            ])}
          />
        </div>
      ))}

      {/* 影响（§14：同量纲换算，钱=FACT、电量×预测隐含单价=ASSUMPTION，绝不重算 NPV） */}
      <Card>
        <CardHeader>
          <CardTitle>偏差的金额影响（同量纲换算，非重算 NPV）</CardTitle>
          <p className="text-sm text-muted-foreground">
            金额为实测−预测（FACT）；电量按<strong>预测自身隐含单价</strong>折算为量级参考（ASSUMPTION）。要重估 NPV 请走「新建情景重算」这条唯一引擎路径，而非在此改数。
          </p>
        </CardHeader>
        <CardContent>
          {impacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无可换算的金额影响（缺同口径预测或尚无实测）。</p>
          ) : (
            <SimpleTable
              columns={["指标", "金额影响（元）", "证据等级", "口径说明"]}
              align={["left", "right", "left", "left"]}
              rows={impacts.map((im) => [
                im.label,
                <ImpactText key="v" v={im.amountYuan} />,
                im.evidenceKind === "FACT" ? "已核实" : "假设",
                im.note,
              ])}
            />
          )}
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">
        面板只读，不产生任何改模动作；确认要复核的参数请切到下方「校准建议」。
      </div>
    </div>
  );
}
