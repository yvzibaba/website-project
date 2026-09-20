"use client";

/**
 * 自动推荐（M5 · 配置寻优）面板 —— 本产品的**灵魂功能**落在界面上的一层。
 *
 * ## 它替用户做了什么（以及为什么这决定产品定位）
 *
 * 在此之前，界面的用法是「你填一套配置 → 我给你一套数字」。想把配置调好，用户得自己
 * 在脑子里做搜索：12 台 240 kW 还是 8 台 480 kW？要不要 4 MWh 储能？要不要增容到 4,000 kW？
 * 组合上千，人肉比不了几套，而且三个月后没人记得当时比过什么。
 *
 * 本面板把这项搜索拿回来：**只把"用户真正知道的事"（车队、里程、充电窗口、服务费、现有容量）
 * 交给服务端，由内核在配置空间里逐套跑同一个生产引擎，给出推荐 + 每个维度的增量账 + 落选原因。**
 *
 * ## 三条不妥协
 *
 * 1. **本组件不算任何数**。它只发请求、只渲染服务端回来的结果。所有数字都出自
 *    唯一生产计算入口（`runCalculation`）——界面上出现的数与报告里的数只有一个来源。
 * 2. **类型不手写**。本组件读取的字段类型直接来自内核契约 `RecommendationResult`。
 *    手写一份"我用到了哪些字段"是这个仓库真实踩过的坑：字段改名后类型检查不会报错，
 *    表格静默渲染成空白（见 `DecisionProjectPanel` 的类型注释）。
 * 3. **一键落档用的是服务端给的输入**。保存新情景时提交的是 `result.recommendedInput`——
 *    它由内核里构造候选输入的**同一个函数**产出，因此"保存后再打开"算出来的数
 *    与此刻页面上看到的推荐数字**逐位相同**（输入指纹一致，可交叉校验）。
 */

import { useCallback, useState } from "react";
import type { ScenarioInput } from "@app/kernel/engine/types";
import type { RecommendationResult } from "@app/kernel/engine/recommend";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner } from "@/components/ui";
import { mutateJson } from "@/components/admin/mutate";
import { MetricCard, SimpleTable, fmtMoneyShort, fmtNum, fmtPct, fmtYears } from "./primitives";

/** 服务端 `/decision/recommend` 的判别联合（只声明本组件真正读取的字段）。 */
type RecommendResponse =
  | { recommended: true; result: RecommendationResult }
  | {
      recommended: false;
      reason: string;
      detail: string;
      diagnostics: Array<{ code: string; message: string; suggestion?: string }>;
    };

const REASON_LABEL: Record<string, string> = {
  invalid_input: "输入不完整",
  no_candidate_evaluated: "没有候选被成功评估",
  calculation_error: "搜索过程异常",
};

export function RecommendPanel({
  base,
  projectId,
  onSaved,
}: {
  /** 当前情景（推荐以它为底座：除被搜索的规模档外，一切原样保留）。 */
  base: ScenarioInput;
  /** 用于把推荐结果保存为新情景的项目 id。 */
  projectId: string;
  /** 保存成功后通知父组件刷新（父组件负责重新拉取情景列表）。 */
  onSaved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [res, setRes] = useState<RecommendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setRes(null);
    setSaveMsg(null);
    const r = await mutateJson("/api/workbench/decision/recommend", "POST", {
      base,
      // 现有并网容量 = 当前情景的并网容量（"不增容"的基准线由用户当前设定决定）
      existingGridCapacityKw: base.grid.capacityKw,
    });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.message ?? "推荐失败");
      return;
    }
    setRes(r.data as unknown as RecommendResponse);
  }, [base]);

  const save = useCallback(async () => {
    if (!res || !res.recommended) return;
    setSaving(true);
    setSaveMsg(null);
    const r = await mutateJson(`/api/workbench/decision/projects/${projectId}/scenarios`, "POST", {
      name: `自动推荐：${res.result.best.candidate.key}`,
      scenarioInput: res.result.recommendedInput,
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.message ?? "保存失败");
      return;
    }
    setSaveMsg("已保存为新情景（服务端已用同一引擎重算并留档，数字与上方推荐一致）。");
    onSaved?.();
  }, [res, projectId, onSaved]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>自动推荐（配置寻优）</CardTitle>
        <CardDescription>
          不用自己猜配置：服务端会在「桩数 × 单桩功率 × 储能规模 × 光伏规模 × 并网容量 × 有序充电」
          这个配置空间里逐套跑同一个生产引擎，按「净现值最大」给出推荐，并附上每一步的增量账与落选原因。
          搜索需要数秒（每套候选都是一次完整年度仿真）。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {base.charging.mode !== "charging" ? (
          <Alert variant="warning" title="当前情景以换电为主">
            本版推荐只搜索**充电桩路线**（桩数 / 功率 / 储能 / 光伏 / 并网），不搜索换电规模。
            当前情景的补能方式不是纯充电，推荐结果的适用性因此下降——请对照阅读。
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={run} disabled={busy}>
            {busy ? "正在搜索…" : "开始自动推荐"}
          </Button>
          {busy ? <Spinner /> : null}
          <span className="text-xs text-muted-foreground">
            默认最多评估 300 个候选（超出会在结论里明确标注「已触顶」）。
          </span>
        </div>

        {error ? (
          <Alert variant="danger" title="请求失败">
            {error}
          </Alert>
        ) : null}

        {res && !res.recommended ? (
          <Alert variant="danger" title={`未能给出推荐（${REASON_LABEL[res.reason] ?? res.reason}）`}>
            <p>{res.detail}</p>
            {res.diagnostics.length ? (
              <ul className="mt-2 list-disc pl-5 text-sm">
                {res.diagnostics.map((d, i) => (
                  <li key={i}>
                    [{d.code}] {d.message}
                    {d.suggestion ? ` —— ${d.suggestion}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}

        {res && res.recommended ? <RecommendResultView result={res.result} /> : null}

        {res && res.recommended ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={save} disabled={saving}>
              {saving ? "保存中…" : "把推荐配置保存为新情景"}
            </Button>
            <span className="text-xs text-muted-foreground">
              保存的是服务端给出的 `recommendedInput`，与本次评估用的是同一份输入，因此数字必然一致。
            </span>
          </div>
        ) : null}

        {saveMsg ? (
          <Alert variant="success" title="已落档">
            {saveMsg}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 推荐结果视图（拆出来只为让主组件短一点，不引入任何状态）。 */
function RecommendResultView({ result }: { result: RecommendationResult }) {
  const { best, runnerUp, baseline, stats } = result;
  return (
    <div className="flex flex-col gap-4">
      <Alert variant={best.meetsObjective ? "success" : "warning"} title={best.meetsObjective ? "推荐方案" : "没有达标方案"}>
        {result.headline}
      </Alert>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="推荐配置" value={`${fmtNum(best.candidate.chargerCount)} × ${fmtNum(best.candidate.chargerPowerKw)} kW`} hint={best.candidate.label} />
        <MetricCard
          label="全投资 NPV"
          value={fmtMoneyShort(best.npvYuan)}
          tone={(best.npvYuan ?? 0) > 0 ? "good" : "bad"}
          hint={`资本金 NPV ${fmtMoneyShort(best.equityNpvYuan)}`}
        />
        <MetricCard label="静态回收期" value={fmtYears(best.simplePaybackYears)} hint="分析期内未回本显示为「—」" />
        <MetricCard label="净投资" value={fmtMoneyShort(best.netCapexYuan)} hint={`目标：${result.objectiveLabel}`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="未满足需求" value={`${fmtNum(best.unservedEnergyKwh ?? 0)} kWh`} tone={(best.unservedEnergyKwh ?? 0) > 0 ? "bad" : "good"} hint="全年交付缺口" />
        <MetricCard label="站级利用率" value={fmtPct(best.chargerUtilizationPct ?? 0, 1)} hint={`有效功率 ${fmtNum(best.candidate.effectivePowerKw)} kW`} />
        <MetricCard label="最大下网需量" value={`${fmtNum(best.maxImportKw ?? 0)} kW`} hint={`并网容量 ${fmtNum(best.candidate.gridCapacityKw)} kW${best.candidate.needsGridUpgrade ? "（需增容）" : "（沿用现有）"}`} />
        <MetricCard label="可行性 / 达标" value={best.feasible ? "通过" : "未通过"} tone={best.meetsObjective ? "good" : "bad"} hint={best.meetsObjective ? "已过全部门槛" : best.unmetReasons.join("；")} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="搜索空间" value={`${fmtNum(stats.spaceSize)} 组`} hint={`实际评估 ${fmtNum(stats.evaluated)} 个（覆盖 ${fmtNum(stats.coveragePct, 1)}%）`} tone="muted" />
        <MetricCard label="解析剪枝" value={`${fmtNum(stats.prunedByAnalytic)} 组`} hint={`判定"数学上不可能交付"；另有 ${fmtNum(stats.collapsedByPareto)} 组被帕累托合并`} tone="muted" />
        <MetricCard
          label="搜索过程"
          value={`${fmtNum(stats.anchorEvaluations)} 角点 + ${fmtNum(stats.passes)} 轮${stats.refined ? " + 精修" : ""}`}
          hint={`收敛 ${stats.converged ? "是" : "否"}${stats.truncated ? "；预算已触顶" : ""}`}
          tone={stats.truncated ? "bad" : "muted"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">为什么是它</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed">
            {result.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">需要注意</h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-muted-foreground">
            {result.concerns.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      </div>

      {result.improvementTrace.length ? (
        <>
          <h3 className="text-sm font-semibold">增量账（从基准方案出发，每一步换来了多少）</h3>
          <SimpleTable
            columns={["步", "维度", "改动", "净现值 前 → 后"]}
            align={["left", "left", "left", "right"]}
            rows={result.improvementTrace.map((s) => [
              String(s.order),
              s.dimensionLabel,
              `${s.from} → ${s.to}`,
              `${fmtMoneyShort(s.scoreBefore)} → ${fmtMoneyShort(s.scoreAfter)}`,
            ])}
          />
        </>
      ) : (
        <Alert variant="info" title="增量账为空">
          从基准方案（{baseline.candidate.label}）出发，逐维度单独调整均无改进——
          在本情景假设下，「不上光伏、不上储能、不增容」本身就是最优解。
          各项增值措施的负价值可直接看下方候选表里的次优方案。
        </Alert>
      )}

      <h3 className="text-sm font-semibold">候选排名（前 {Math.min(result.table.length, 15)} / 共 {result.table.length}）</h3>
      <SimpleTable
        columns={["#", "配置", "NPV", "回收期", "净投资", "结论"]}
        align={["left", "left", "right", "right", "right", "left"]}
        rows={result.table.slice(0, 15).map((r) => [
          String(r.rank),
          r.config,
          r.npvWanYuan == null ? "—" : `${fmtNum(r.npvWanYuan, 1)} 万`,
          fmtYears(r.paybackYears),
          r.netCapexWanYuan == null ? "—" : `${fmtNum(r.netCapexWanYuan, 1)} 万`,
          r.note,
        ])}
      />

      <h3 className="text-sm font-semibold">为什么不推荐别的（代表性落选）</h3>
      <SimpleTable
        columns={["配置", "落选原因", "NPV"]}
        align={["left", "left", "right"]}
        rows={result.rejected.map((r) => [
          r.config,
          r.reason,
          r.npvWanYuan == null ? "—" : `${fmtNum(r.npvWanYuan, 1)} 万`,
        ])}
      />

      <h3 className="text-sm font-semibold">各维度探索过的档位</h3>
      <SimpleTable
        columns={["维度", "探索档位", "最终取值"]}
        rows={result.dimensionTrace.map((d) => [d.label, d.explored.join(" / "), d.chosen])}
      />

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="neutral">引擎 {result.engineVersion}</Badge>
        <Badge variant="neutral">推荐模型 {result.recommendModelVersion}</Badge>
        <Badge variant="neutral">基准 {result.benchmarkVersion}</Badge>
        <Badge variant="neutral">输入指纹 {best.inputHash}</Badge>
        {runnerUp ? <Badge variant="neutral">次优 {runnerUp.candidate.key}</Badge> : null}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{result.disclaimer}</p>
    </div>
  );
}
