"use client";

/**
 * 差异归因（M6）面板 —— 把"场景比较"从"并排摆两个数"升级成"差在哪、各差多少"。
 *
 * 三条与其它面板一致的底线：
 *  1. **本组件不算任何数**：只发请求、只渲染服务端返回。所有数字出自唯一生产引擎
 *     （`runCalculation`）驱动的 `attributeScenarioDelta`，与报告同源。
 *  2. **类型不手写**：读取字段直接来自内核契约 `ScenarioAttribution`（仅 import type，编译期擦除）。
 *  3. **诚实呈现残差与不可隔离项**：残差、`not_isolable` 原样列出，绝不为"看起来自洽"抹平。
 */

import { useCallback, useState } from "react";
import type { ScenarioAttribution } from "@app/kernel/engine/attribution";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from "@/components/ui";
import { mutateJson } from "@/components/admin/mutate";
import { MetricCard, SimpleTable, fmtMoneyShort, fmtNum, fmtPct, fmtYears } from "./primitives";

type Objective = "npv" | "equityNpv" | "payback";

interface ScenarioOption {
  id: string;
  name: string;
  isBaseline: boolean;
}

type CompareResponse =
  | { status: "ok"; attributed: true; result: ScenarioAttribution }
  | { status: "ok"; attributed: false; reason: string; detail: string };

const OBJECTIVE_LABEL: Record<Objective, string> = {
  npv: "全投资 NPV",
  equityNpv: "资本金 NPV",
  payback: "静态回收期",
};

const NO_ATTRIBUTION_REASON: Record<string, string> = {
  same_input: "两个情景参与计算的输入完全一致，没有可归因的差异。",
  invalid_input_a: "起点情景当前算不通，无法作为归因基线（请先修正并重算）。",
  invalid_input_b: "对照情景当前算不通，无法归因（请先修正并重算）。",
  no_input: "至少一个情景缺少可复算的输入快照。",
};

/** 按目标口径格式化金额/年。 */
function fmtByObjective(v: number | null, objective: Objective): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (objective === "payback") return fmtYears(v);
  return fmtMoneyShort(v);
}
function fmtSignedByObjective(v: number | null, objective: Objective): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v > 0 ? "+" : v < 0 ? "-" : "";
  return s + fmtByObjective(Math.abs(v), objective);
}
/** 指标表按单位选格式化器（这里展示用，不影响结论）。 */
function fmtMetric(unit: string, v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (unit === "元") return fmtMoneyShort(v);
  if (unit === "%") return fmtPct(v);
  if (unit === "年") return fmtYears(v);
  if (unit === "元/kWh") return `${v.toFixed(4)} 元/kWh`;
  if (unit === "kWh") return `${fmtNum(v, 0)} kWh`;
  return fmtNum(v, 2);
}

export function ScenarioAttributionPanel({
  scenarios,
  defaultAId,
  defaultBId,
}: {
  scenarios: ScenarioOption[];
  defaultAId?: string | null;
  defaultBId?: string | null;
}) {
  const computable = scenarios;
  const baseline = computable.find((s) => s.isBaseline);
  const [aId, setAId] = useState<string>(defaultAId ?? baseline?.id ?? computable[0]?.id ?? "");
  const [bId, setBId] = useState<string>(defaultBId ?? computable.find((s) => s.id !== (defaultAId ?? baseline?.id ?? computable[0]?.id))?.id ?? "");
  const [objective, setObjective] = useState<Objective>("npv");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!aId || !bId) {
      setError("请先分别选择「基线情景」和「对照情景」。");
      return;
    }
    if (aId === bId) {
      setError("基线与对照是同一个情景，没有可归因的差异。");
      return;
    }
    setBusy(true);
    setError(null);
    setRes(null);
    const r = await mutateJson("/api/workbench/decision/compare", "POST", {
      scenarioAId: aId,
      scenarioBId: bId,
      objective,
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.message ?? "归因失败");
      return;
    }
    setRes(r.data as unknown as CompareResponse);
  }, [aId, bId, objective]);

  const result = res && res.attributed ? res.result : null;
  const nameOf = (id: string) => scenarios.find((s) => s.id === id)?.name ?? id;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">参数级差异归因（差在哪、各差多少）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">基线情景（A）</span>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={aId}
              onChange={(e) => setAId(e.target.value)}
            >
              {computable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.isBaseline ? "（基线）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">对照情景（B）</span>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={bId}
              onChange={(e) => setBId(e.target.value)}
            >
              <option value="">— 选择 —</option>
              {computable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.isBaseline ? "（基线）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">归因目标口径</span>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={objective}
              onChange={(e) => setObjective(e.target.value as Objective)}
            >
              {(Object.keys(OBJECTIVE_LABEL) as Objective[]).map((k) => (
                <option key={k} value={k}>
                  {OBJECTIVE_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" onClick={run} disabled={busy || computable.length < 2}>
            {busy ? <Spinner className="h-4 w-4" /> : null}
            {busy ? "归因中…" : "开始归因"}
          </Button>
          {computable.length < 2 ? (
            <span className="text-xs text-muted-foreground">至少需要两个已算通的情景才能归因。</span>
          ) : null}
        </div>

        {error ? <Alert variant="danger">{error}</Alert> : null}

        {res && !res.attributed ? (
          <Alert variant="info">{NO_ATTRIBUTION_REASON[res.reason] ?? res.detail}</Alert>
        ) : null}

        {result ? (
          <div className="space-y-5">
            {/* 头部三卡：总变化 / 可归因 / 残差 */}
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricCard
                label={`${OBJECTIVE_LABEL[result.objective as Objective]} 总变化（A→B）`}
                value={fmtSignedByObjective(result.totalDelta, result.objective as Objective)}
                hint={`A ${fmtByObjective(result.baseValue, result.objective as Objective)} → B ${fmtByObjective(result.targetValue, result.objective as Objective)}`}
                tone={
                  result.totalDelta === 0
                    ? "muted"
                    : (result.objective === "payback" ? result.totalDelta < 0 : result.totalDelta > 0)
                      ? "good"
                      : "bad"
                }
              />
              <MetricCard
                label="可逐参数拆出的贡献"
                value={fmtSignedByObjective(result.attributableDelta, result.objective as Objective)}
                hint={`${result.rows.filter((r) => r.status === "ok").length} 项可单独归因`}
              />
              <MetricCard
                label="残差（交互 / 耦合）"
                value={fmtSignedByObjective(result.residual, result.objective as Objective)}
                hint="参数间非线性与无法单独隔离的组合，原样给出"
                tone={Math.abs(result.residual) > Math.abs(result.totalDelta) * 0.25 ? "bad" : "muted"}
              />
            </div>

            {/* 解释 */}
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <div className="font-medium">{result.explanation.summary}</div>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                {result.explanation.paragraphs.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>

            {/* 逐参数归因表 */}
            <div>
              <div className="mb-2 text-sm font-medium">逐参数边际贡献（按路径字典序，一阶反事实）</div>
              <SimpleTable
                columns={["参数", "A → B", "本步边际", "状态"]}
                align={["left", "left", "right", "left"]}
                rows={result.rows.map((r) => [
                  r.label,
                  `${fmtLeafShort(r.from)} → ${fmtLeafShort(r.to)}`,
                  r.status === "ok" ? fmtSignedByObjective(r.marginalDelta, result.objective as Objective) : "—",
                  r.status === "ok"
                    ? r.path === result.topDriver?.path
                      ? "可归因 · 影响最大"
                      : "可归因"
                    : `不可单独归因（${r.reason ?? "耦合"}）`,
                ])}
              />
            </div>

            {/* 指标对照表 */}
            <div>
              <div className="mb-2 text-sm font-medium">关键指标对照（A · B · 差值）</div>
              <SimpleTable
                columns={["指标", "基线 A", "对照 B", "差值（B−A）"]}
                align={["left", "right", "right", "right"]}
                rows={result.metrics.map((m) => [
                  `${m.label}（${m.unit}）`,
                  fmtMetric(m.unit, m.a),
                  fmtMetric(m.unit, m.b),
                  m.delta === null ? "—" : fmtSignedMetric(m.unit, m.delta),
                ])}
              />
            </div>

            {/* 可复现脚注 */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="neutral">{result.attributionRef}</Badge>
              <Badge variant="neutral">引擎 {result.engineVersion}</Badge>
              <span>
                A 指纹 {result.sideA.inputHash.slice(0, 12)}… · B 指纹 {result.sideB.inputHash.slice(0, 12)}… · 共改动{" "}
                {result.changedInputs.length} 项 · 归因顺序已固定（路径相关分解，见上）
              </span>
            </div>
          </div>
        ) : null}

        {result ? (
          <p className="text-xs text-muted-foreground">
            说明：基线取「{nameOf(aId)}」，对照取「{nameOf(bId)}」。逐参数贡献依赖替换顺序，此处按参数路径字典序固定，
            以保证同一对输入在任何时候得到同一份分解；各步贡献不宣称为唯一公正的拆分。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function fmtSignedMetric(unit: string, v: number): string {
  const s = v > 0 ? "+" : v < 0 ? "-" : "";
  return s + fmtMetric(unit, Math.abs(v));
}
function fmtLeafShort(v: unknown): string {
  if (v === null || v === undefined) return "空";
  if (Array.isArray(v)) return `[${v.join("、")}]`;
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") return v.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
  return String(v);
}
