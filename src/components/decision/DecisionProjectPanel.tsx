"use client";

/**
 * V2 决策平台 · 九段式项目工作台（客户端组件）。
 *
 * ## 数字从哪里来（这段说明是本文件最该先读的部分）
 * 界面**不自己算任何东西**。载入时：
 *   1. `GET  /projects/[id]`           → 项目头 + 各情景摘要（摘要指标读落库的派生列）
 *   2. `GET  /scenarios/[sid]`         → 该情景**存档的输入**（`scenarioInput`）与输入指纹
 *   3. `POST /projects/[id]/calculate` → 把存档输入交回**唯一的生产计算入口**，拿回完整结果
 * 由于引擎确定性，第 3 步算出来的数必须与当初保存时逐位一致；界面会把拿回的 `inputHash`
 * 与存档指纹做**显式比对**，一旦不一致就直接报错，而不是把某一份数字画出去。
 * 这样既避免了把 3.5 万个时间步的曲线塞进数据库，又保证了「页面上的数」与「留档的数」
 * 在结构上不可能分叉。
 *
 * ## 段
 *   1 项目概览 · 2 用能需求 · 3 充换电方案 · 4 能源配置 · 5 能量平衡
 *   6 项目经济性 · 7 场景比较 · 8 决策结果 · 9 决策报告 · 10 实测回填
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CalculationResult } from "@app/kernel/engine/types";
import { mutateJson } from "@/components/admin/mutate";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui";
import {
  CalcStatusBadge,
  MetricCard,
  Section,
  SimpleTable,
  fmtMoney,
  fmtMoneyShort,
  fmtNum,
  fmtPct,
  fmtYears,
} from "./primitives";
import { DecisionReportView, type DecisionReportData } from "./DecisionReportView";
import { DecisionExportPanel } from "./DecisionExportPanel";
import { ActualsPanel } from "./ActualsPanel";
import { RecommendPanel } from "./RecommendPanel";
import { ScenarioAttributionPanel } from "./ScenarioAttributionPanel";
import { ScenarioVersionsPanel } from "./ScenarioVersionsPanel";
import { DeviationPanel } from "./DeviationPanel";
import { CalibrationPanel } from "./CalibrationPanel";
import { BenchmarkSourcesPanel } from "./BenchmarkSourcesPanel";

/* ── 服务端返回结构（只声明本组件真正读取的字段；类型即文档） ── */

interface ScenarioSummary {
  id: string;
  name: string;
  isBaseline: boolean;
  calcStatus: string;
  calcRef: string | null;
  engineVersion: string | null;
  benchmarkVersion: string | null;
  inputHash: string | null;
  capexNetYuan: number | null;
  npvYuan: number | null;
  irrPct: number | null;
  paybackYears: number | null;
  lcoeYuanPerKwh: number | null;
  npvEquityYuan: number | null;
  irrEquityPct: number | null;
  scenarioIdLabel: string | null;
  updatedAt: string;
}

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  scenarios: ScenarioSummary[];
}

/**
 * 引擎结果类型**直接取自内核契约**，不在这里按"我用到了哪些字段"重新手写一遍。
 *
 * 为什么必须这样（本文件修过的一个真实缺陷）：此前这里手写了一份 `EngineResult`。
 * 于是当内核把 `keyDrivers[].swingYuan` 定名、把 `RiskItem.title` 定名、把敏感性字段定成
 * `npvAtLow/npvAtHigh` 时，**TypeScript 一声不吭**——因为页面读的是自己那份类型，
 * 两边各自自洽。真实后果是页面上「关键驱动 / 敏感性 / 风险」三张表每个单元格都渲染成
 * `undefined`（表格组件把空值渲染成空白）:不报错、不白屏，只是决策内容静默消失。
 *
 * 结论：跨边界的类型只允许有一个真源。前端**只 import 类型**（编译期擦除、不进 bundle），
 * 因此这份"跟内核对齐"是零成本的。
 */
type EngineResult = CalculationResult;

const KIND_LABEL: Record<string, string> = {
  SCENARIO_INPUT_MISSING: "输入缺口",
  EVIDENCE_MISSING: "证据不足",
  CONSTRAINT_VIOLATION: "约束不满足",
  CALCULATION_ERROR: "计算异常",
  MODEL_LIMITATION: "模型边界",
};

const COMPONENT_LABEL: Record<string, string> = {
  PV: "光伏", BESS: "储能", GRID: "电网", CHARGING: "充电",
  SWAP: "换电", TOU: "分时电价", DEMAND_CHARGE: "需量电费",
};

const SEVERITY_LABEL: Record<string, string> = {
  high: "高", medium: "中", low: "低",
};

/** 无购电量时不显示 0 元/kWh（那是"没有数据"，不是"免费"）。 */
function wapText(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(4)} 元/kWh`;
}

export function DecisionProjectPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [archivedHash, setArchivedHash] = useState<string | null>(null);
  const [calc, setCalc] = useState<EngineResult | null>(null);
  const [report, setReport] = useState<DecisionReportData | null>(null);
  const [engineFailure, setEngineFailure] = useState<{ reason: string; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);

  const loadProject = useCallback(async (): Promise<ProjectDetail | null> => {
    const res = await mutateJson(`/api/workbench/decision/projects/${projectId}`, "GET");
    if (!res.ok) {
      if (res.status === 401) {
        router.push(`/login?callbackUrl=${encodeURIComponent(`/workbench/projects/${projectId}`)}`);
        return null;
      }
      setError(res.message ?? "项目载入失败");
      return null;
    }
    const p = (res.data ?? {}).project as ProjectDetail;
    setProject(p);
    return p;
  }, [projectId, router]);

  const runScenario = useCallback(
    async (scenarioId: string) => {
      setError(null);
      setEngineFailure(null);
      try {
        const detail = await mutateJson(`/api/workbench/decision/scenarios/${scenarioId}`, "GET");
        if (!detail.ok) {
          setError(detail.message ?? "情景载入失败");
          return;
        }
        const scenario = (detail.data ?? {}).scenario as {
          scenarioInput: unknown;
          inputHash: string | null;
        } | null;
        setArchivedHash(scenario?.inputHash ?? null);

        if (!scenario?.scenarioInput) {
          setCalc(null);
          setReport(null);
          setError("这个情景没有可用的输入存档，无法重算。");
          return;
        }

        const out = await mutateJson(
          `/api/workbench/decision/projects/${projectId}/calculate`,
          "POST",
          scenario.scenarioInput,
        );
        if (!out.ok) {
          setError(out.message ?? "计算失败");
          return;
        }
        if ((out.data ?? {}).calculated !== true) {
          setCalc(null);
          setReport(null);
          setEngineFailure({
            reason: String((out.data ?? {}).reason ?? "unknown"),
            detail: String((out.data ?? {}).detail ?? "引擎未能算出结果"),
          });
          return;
        }
        const result = (out.data ?? {}).result as EngineResult;
        setCalc(result);
        setReport(((out.data ?? {}).report as DecisionReportData) ?? null);

        // 交叉校验：重算结果必须与存档指纹一致，否则说明存档被改过或不完整，页面数字不可信
        if (scenario.inputHash && result.inputHash !== scenario.inputHash) {
          setError(
            `复算校验未通过：本次重算的输入指纹（${result.inputHash}）与存档指纹（${scenario.inputHash}）不一致。`,
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  /**
   * 首次载入与「切回本页」。
   *
   * 注意：这里刻意**不**在 effect 体内同步 setState（本项目 lint 明令禁止，会引发级联渲染），
   * 所有状态更新都发生在 promise 回调 / 异步函数体内。因此 `loading` 的置位也放在回调里，
   * 首屏的「载入中」由 `project === null` 兜住，不会出现空白。
   */
  useEffect(() => {
    let alive = true;
    mutateJson(`/api/workbench/decision/projects/${projectId}`, "GET")
      .then((res) => {
        if (!alive) return;
        if (!res.ok) {
          if (res.status === 401) {
            router.push(`/login?callbackUrl=${encodeURIComponent(`/workbench/projects/${projectId}`)}`);
            return;
          }
          setError(res.message ?? "项目载入失败");
          return;
        }
        const p = (res.data ?? {}).project as ProjectDetail;
        setProject(p);
        const firstId = p.scenarios[0]?.id ?? null;
        setActiveId(firstId);
        if (firstId) {
          setLoading(true);
          void runScenario(firstId);
        }
      })
      .catch(() => {
        if (alive) setError("项目载入失败（网络异常）");
      });
    return () => {
      alive = false;
    };
  }, [projectId, router, runScenario]);

  async function onSwitchTemplate(templateId: string) {
    if (!activeId) return;
    setRecalcBusy(true);
    setError(null);
    setLoading(true);
    try {
      const res = await mutateJson(`/api/workbench/decision/scenarios/${activeId}/recalculate`, "POST", { templateId });
      if (!res.ok) {
        setLoading(false);
        setError(res.message ?? "切换情景失败");
        return;
      }
      await loadProject();
      await runScenario(activeId);
    } catch {
      setLoading(false);
      setError("切换情景失败（网络异常）");
    } finally {
      setRecalcBusy(false);
    }
  }

  const active = useMemo(() => project?.scenarios.find((s) => s.id === activeId) ?? null, [project, activeId]);

  if (error && !calc) {
    return (
      <Alert variant="danger" title="无法载入">
        {error}
      </Alert>
    );
  }
  if (!project) return <p className="text-sm text-muted-foreground">载入中…</p>;

  const inputs = calc?.inputSnapshot;
  const constructionYears = inputs?.economics.constructionYears ?? 0;
  const opYearLabel = (i: number) => (i < constructionYears ? `建设期第 ${i + 1} 年` : `运营第 ${i - constructionYears + 1} 年`);
  const peakImportKw = calc && calc.grid.monthlyPeakImportKw.length > 0 ? Math.max(...calc.grid.monthlyPeakImportKw) : null;

  return (
    <div className="flex flex-col gap-8">
      {/* 情景切换条 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">情景：</span>
        {project.scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setActiveId(s.id);
              setLoading(true);
              void runScenario(s.id);
            }}
            className={`rounded-full border px-3 py-1 text-sm ${
              s.id === activeId ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted/50"
            }`}
          >
            {s.name}
            {s.isBaseline ? "（基线）" : ""}
          </button>
        ))}
        {active ? <CalcStatusBadge status={active.calcStatus} /> : null}
      </div>

      {error ? (
        <Alert variant="danger" title="提示">
          {error}
        </Alert>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">正在按存档输入复算…</p> : null}
      {engineFailure ? (
        <Alert variant="danger" title="这个情景当前算不出来">
          {engineFailure.detail || engineFailure.reason}
        </Alert>
      ) : null}

      {calc && inputs ? (
        <>
          {/* ── 1 项目概览 ── */}
          <Section index={1} title="项目概览" description="这一屏的数字全部由生产计算引擎现算，并与留档的输入指纹交叉校验。">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="项目名称" value={project.name} hint={project.description ?? undefined} tone="muted" />
              <MetricCard label="当前情景" value={calc.scenarioLabel} hint={inputs.definition.intent} tone="muted" />
              <MetricCard label="计算引擎" value={calc.engineVersion} hint={calc.calcRef} tone="muted" />
              <MetricCard label="时间粒度" value={`${calc.timeStepMinutes} 分钟`} hint={`${fmtNum(calc.stepsPerYear)} 步/年`} tone="muted" />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <MetricCard
                label="输入指纹（复算校验）"
                value={calc.inputHash}
                hint={archivedHash ? (calc.inputHash === archivedHash ? `与存档一致（${archivedHash}）` : `与存档不一致（存档 ${archivedHash}）`) : "存档无指纹"}
                tone={archivedHash && calc.inputHash === archivedHash ? "good" : "bad"}
              />
              <MetricCard label="参与组件" value={inputs.definition.components.map((c) => COMPONENT_LABEL[c] ?? c).join(" + ")} hint={inputs.definition.managedCharging ? "启用有序充电" : "未启用有序充电"} tone="muted" />
              <MetricCard label="模型构成" value={`${calc.modelComposition.split("+").length} 个子模型`} hint={calc.modelComposition} tone="muted" />
            </div>
            {calc.needsProfessionalReview ? (
              <Alert variant="warning" className="mt-3" title="结论需专业人工复核">
                本结果是基于当前参数与所引用基准的工程经济测算，涉及投资决策，请由专业人员复核后再使用。
              </Alert>
            ) : null}
            {inputs.unknowns && Object.keys(inputs.unknowns).length > 0 ? (
              <Alert variant="info" className="mt-3" title="声明为「未核实」的参数">
                以下参数未取得可靠来源，引擎**未**用任何默认值顶替，相关结论的确定性因此下降：
                {Object.keys(inputs.unknowns).join("、")}
              </Alert>
            ) : null}
          </Section>

          <Separator />

          {/* ── 2 用能需求 ── */}
          <Section index={2} title="用能需求" description="由车队规模、里程与工况推导的能源需求，是后面一切配置的出发点。">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="车队规模" value={`${fmtNum(inputs.truck.truckCount)} 辆`} />
              <MetricCard label="单车日均里程" value={`${fmtNum(inputs.truck.dailyMileageKm)} km`} hint={`单位能耗 ${inputs.truck.energyConsumptionKwhPerKm} kWh/km`} />
              <MetricCard label="年运营天数" value={`${calc.truckDemand.operatingDays} 天`} hint={`设定 ${inputs.truck.operatingDaysPerYear} 天`} />
              <MetricCard label="充电窗口" value={`${calc.truckDemand.chargingWindowHours} 小时/日`} hint={`${inputs.truck.chargingWindowStartHour}:00 → ${inputs.truck.chargingWindowEndHour}:00`} />
              <MetricCard label="年电量需求（电网侧）" value={`${fmtNum(calc.truckDemand.annualEnergyDemandKwh)} kWh`} hint="含充电与换电链路损耗" />
              <MetricCard label="年电量需求（电池侧）" value={`${fmtNum(calc.truckDemand.annualEnergyAtBatteryKwh)} kWh`} hint="实际充入车辆的电量" />
              <MetricCard label="日均需求" value={`${fmtNum(calc.truckDemand.dailyEnergyDemandKwh)} kWh/日`} />
              <MetricCard label="年末切边量" value={`${fmtNum(calc.truckDemand.yearBoundarySpillKwh)} kWh`} hint="跨年那一段会在次年交付，属口径差异而非能力不足" tone="muted" />
            </div>
            <h3 className="mt-4 mb-2 text-sm font-semibold">逐月电量需求（kWh）</h3>
            <SimpleTable
              columns={["月份", "电网侧需求", "电池侧需求"]}
              align={["left", "right", "right"]}
              rows={calc.truckDemand.monthlyEnergyDemandKwh.map((v, i) => [
                `${i + 1} 月`,
                fmtNum(v),
                fmtNum(calc.truckDemand.monthlyEnergyAtBatteryKwh[i] ?? null),
              ])}
            />
          </Section>

          <Separator />

          {/* ── 3 充换电方案 ── */}
          <Section index={3} title="充换电方案" description="设施配置能不能在允许的时段里把需求交付出去。">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="年交付电量" value={`${fmtNum(calc.charging.annualDeliveredKwh)} kWh`} hint="电池侧交付合计" />
              <MetricCard label="其中充电交付" value={`${fmtNum(calc.charging.annualChargingDeliveredKwh)} kWh`} />
              <MetricCard label="其中换电交付" value={`${fmtNum(calc.charging.annualSwapDeliveredKwh)} kWh`} hint={calc.charging.annualSwapEvents > 0 ? `约 ${fmtNum(calc.charging.annualSwapEvents)} 次换电` : "本情景未配置换电"} />
              <MetricCard
                label="未交付电量"
                value={`${fmtNum(calc.charging.unservedEnergyKwh)} kWh`}
                tone={calc.charging.unservedEnergyKwh > 1 ? "bad" : "good"}
                hint={calc.charging.unservedEnergyKwh > 1 ? "设施能力不足，需调整配置" : "需求已全部交付"}
              />
              <MetricCard label="装机功率" value={`${fmtNum(calc.charging.installedPowerKw)} kW`} />
              <MetricCard label="有效并发功率" value={`${fmtNum(calc.charging.effectivePowerKw)} kW`} />
              <MetricCard label="站点峰值负荷" value={`${fmtNum(calc.charging.peakLoadKw)} kW`} />
              <MetricCard
                label="设施年利用率"
                value={fmtPct(calc.charging.utilizationPct, 1)}
                tone={calc.charging.utilizationPct < 10 ? "bad" : "default"}
                hint={calc.charging.utilizationPct < 10 ? "装机可能明显偏大" : undefined}
              />
            </div>
            <h3 className="mt-4 mb-2 text-sm font-semibold">逐月站点峰值负荷（kW）</h3>
            <SimpleTable
              columns={["月份", "峰值负荷"]}
              align={["left", "right"]}
              rows={calc.charging.monthlyPeakLoadKw.map((v, i) => [`${i + 1} 月`, fmtNum(v)])}
            />
          </Section>

          <Separator />

          {/* ── 4 能源配置 ── */}
          <Section index={4} title="能源配置" description="光伏、储能与电网的组合，以及它们各自在能量平衡里的角色。">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="光伏装机" value={`${fmtNum(inputs.pv.capacityKwp)} kWp`} hint={`等效小时 ${fmtNum(inputs.pv.specificYieldKwhPerKwp)} h/kWp`} />
              <MetricCard label="光伏年发电" value={`${fmtNum(calc.pv.annualGenerationKwh)} kWh`} />
              <MetricCard label="光伏自用" value={`${fmtNum(calc.pv.selfConsumedKwh)} kWh`} hint={`自用率 ${fmtPct(calc.pv.selfConsumptionPct, 1)}`} />
              <MetricCard label="光伏上网 / 弃光" value={`${fmtNum(calc.pv.exportedKwh)} / ${fmtNum(calc.pv.curtailedKwh)} kWh`} />
              <MetricCard label="储能功率 / 容量" value={`${fmtNum(inputs.bess.powerKw)} kW / ${fmtNum(inputs.bess.energyKwh)} kWh`} />
              <MetricCard label="储能年充 / 放" value={`${fmtNum(calc.bess.annualChargeKwh)} / ${fmtNum(calc.bess.annualDischargeKwh)} kWh`} hint={`等效循环 ${calc.bess.equivalentCycles.toFixed(1)} 次`} />
              <MetricCard
                label="储能套利收益"
                value={fmtMoney(calc.bess.arbitrageBenefitYuan)}
                tone={calc.bess.arbitrageBenefitYuan <= 0 ? "bad" : "good"}
                hint={
                  calc.bess.arbitrageBenefitYuan <= 0
                    ? "仅按峰谷价差（充放电搬移电量）测算：本口径下价差未覆盖往返损耗。此为储能价值的一条腿，未含辅助服务/保供/现货等价差；非正≠储能一定亏，属保守口径，须专业复核"
                    : "按峰谷价差与充放电损耗测算；此卡仅计储能「峰谷套利」一条价值流，未含辅助服务/保供/现货等价差"
                }
              />

              <MetricCard label="储能 SOC 越界" value={fmtNum(calc.bess.socViolations)} tone={calc.bess.socViolations > 0 ? "bad" : "good"} hint="充放电不得越过 SOC 上下限" />
              <MetricCard label="年购电 / 上网" value={`${fmtNum(calc.grid.annualImportKwh)} / ${fmtNum(calc.grid.annualExportKwh)} kWh`} />
              <MetricCard label="并网容量" value={`${fmtNum(inputs.grid.capacityKw)} kW`} hint={calc.grid.capacityConstrained ? "容量已成为约束" : "容量未成为约束"} />
              <MetricCard label="电网侧峰值需量" value={peakImportKw == null ? "—" : `${fmtNum(peakImportKw)} kW`} />
              <MetricCard label="加权购电均价" value={wapText(calc.grid.weightedAveragePriceYuanPerKwh)} hint="按电量加权；无购电时为「—」而不是 0" />
            </div>
          </Section>

          <Separator />

          {/* ── 5 能量平衡 ── */}
          <Section index={5} title="能量平衡" description="逐时段（15 分钟）守恒校验：光伏 + 储能放电 + 购电 = 负荷 + 储能充电 + 上网 + 弃电。">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="守恒校验"
                value={calc.invariant.ok ? "通过" : "不通过"}
                tone={calc.invariant.ok ? "good" : "bad"}
                hint={`违反时段 ${calc.invariant.violationCount} 个`}
              />
              <MetricCard label="最大单步偏差" value={`${calc.invariant.maxAbsDeviationKwh.toExponential(2)} kWh`} hint={`容差 ${calc.invariant.toleranceKwh.toExponential(2)} kWh`} />
              <MetricCard label="年度口径偏差" value={`${fmtNum(calc.invariant.annualDeviationKwh, 4)} kWh`} tone="muted" />
              <MetricCard label="年购电成本" value={fmtMoney(calc.grid.annualGridCostYuan)} />
            </div>
            <h3 className="mt-4 mb-2 text-sm font-semibold">电网侧成本分解（元）</h3>
            <SimpleTable
              columns={["项目", "金额", "说明"]}
              align={["left", "right", "left"]}
              rows={[
                ["电量电费", fmtMoney(calc.grid.annualEnergyCostYuan), "按分时电价与购电量测算"],
                ["需量电费", fmtMoney(calc.grid.annualDemandChargeYuan), calc.grid.annualDemandChargeYuan === 0 ? "本地区集中式充换电按政策免收" : "按计费需量 × 单价"],
                ["上网收入（减项）", fmtMoney(-calc.grid.annualExportRevenueYuan), "按上网电价与上网电量测算"],
                ["合计购电成本", fmtMoney(calc.grid.annualGridCostYuan), "= 电量电费 + 需量电费 − 上网收入"],
              ]}
            />
          </Section>

          <Separator />

          {/* ── 6 项目经济性 ── */}
          <Section index={6} title="项目经济性" description="同时给出「全投资」与「资本金」两条口径——它们回答的是两个不同的问题，不能混用。">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="净投资（全投资）" value={fmtMoneyShort(calc.economics.capex.netYuan)} hint={`建设期 ${constructionYears} 年 · 运营 ${inputs.economics.projectLifeYears} 年`} />
              <MetricCard
                label="净现值 NPV"
                value={fmtMoneyShort(calc.economics.metrics.npvYuan)}
                tone={calc.economics.metrics.npvYuan >= 0 ? "good" : "bad"}
                hint={`折现率 ${inputs.economics.discountRatePct}%`}
              />
              <MetricCard
                label="内部收益率 IRR"
                value={calc.economics.metrics.irr.ok ? fmtPct(calc.economics.metrics.irr.valuePct) : "不收敛"}
                tone={calc.economics.metrics.irr.ok ? "default" : "bad"}
                hint={calc.economics.metrics.irr.ok ? undefined : calc.economics.metrics.irr.reason}
              />
              <MetricCard label="投资回收期" value={fmtYears(calc.economics.metrics.discountedPaybackYears)} hint="折现口径；分析期内未回本显示为「—」" />
              <MetricCard
                label="度电成本（自有成本口径）"
                value={calc.economics.metrics.lcoeYuanPerKwh == null ? "—" : `${calc.economics.metrics.lcoeYuanPerKwh.toFixed(4)} 元/kWh`}
                hint={`可与服务费 ${inputs.economics.chargingServiceFeeYuanPerKwh} 元/kWh 直接比较`}
              />
              <MetricCard label="资本金投入" value={fmtMoneyShort((calc.economics.capex.netYuan * inputs.economics.equityRatioPct) / 100)} hint={`资本金比例 ${inputs.economics.equityRatioPct}%`} />
              <MetricCard label="资本金 NPV" value={fmtMoneyShort(calc.economics.metrics.equity.npvYuan)} hint="按融资方案，股东口径" />
              <MetricCard
                label="资本金 IRR"
                value={calc.economics.metrics.equity.irr.ok ? fmtPct(calc.economics.metrics.equity.irr.valuePct) : "不收敛"}
                hint={calc.economics.metrics.equity.irr.ok ? `贷款利率 ${inputs.economics.loanInterestPct}%` : calc.economics.metrics.equity.irr.reason}
              />
            </div>

            <h3 className="mt-4 mb-2 text-sm font-semibold">投资构成（元）</h3>
            <SimpleTable
              columns={["科目", "金额"]}
              align={["left", "right"]}
              rows={[
                ["光伏", fmtMoney(calc.economics.capex.pvYuan)],
                ["储能", fmtMoney(calc.economics.capex.bessYuan)],
                ["充电设施", fmtMoney(calc.economics.capex.chargerYuan)],
                ["换电站", fmtMoney(calc.economics.capex.swapYuan)],
                ["并网及配电", fmtMoney(calc.economics.capex.gridYuan)],
                ["土建", fmtMoney(calc.economics.capex.civilYuan)],
                ["不可预见费", fmtMoney(calc.economics.capex.contingencyYuan)],
                ["投资合计（含补贴前）", fmtMoney(calc.economics.capex.grossYuan)],
                ["建设期补贴（减项）", fmtMoney(-calc.economics.capex.subsidyYuan)],
                ["净投资合计", fmtMoney(calc.economics.capex.netYuan)],
              ]}
            />

            <h3 className="mt-4 mb-2 text-sm font-semibold">首年收支（元）</h3>
            <SimpleTable
              columns={["科目", "金额"]}
              align={["left", "right"]}
              rows={[
                ["充电服务费收入", fmtMoney(calc.economics.revenueY1.chargingServiceYuan)],
                ["换电服务费收入", fmtMoney(calc.economics.revenueY1.swapServiceYuan)],
                ["转供电费（过手，车队另付）", fmtMoney(calc.economics.revenueY1.electricityResaleYuan)],
                ["运营补贴", fmtMoney(calc.economics.revenueY1.operationSubsidyYuan)],
                ["其他收入", fmtMoney(calc.economics.revenueY1.otherYuan)],
                ["收入合计", fmtMoney(calc.economics.revenueY1.grossYuan)],
                ["运维成本", fmtMoney(calc.economics.opexY1.grossYuan)],
                ["首年运营成本合计（含购电）", fmtMoney(calc.economics.costY1Yuan)],
                ["首年税前净现金流", fmtMoney(calc.economics.netCashFlowY1PreTaxYuan)],
              ]}
            />

            <h3 className="mt-4 mb-2 text-sm font-semibold">逐年现金流（元，留档口径）</h3>
            <SimpleTable
              columns={["年", "全投资净现金流", "资本金净现金流", "全投资累计"]}
              align={["left", "right", "right", "right"]}
              rows={calc.economics.annualCashFlowYuan.map((v, i) => [
                opYearLabel(i),
                fmtMoney(v),
                fmtMoney(calc.economics.equityCashFlowYuan[i] ?? null),
                fmtMoney(calc.economics.cumulativeCashFlowYuan[i] ?? null),
              ])}
            />
          </Section>

          <Separator />

          {/* ── 7 场景比较 ── */}
          <Section index={7} title="场景比较" description="同一项目下各情景的关键指标并排比较；并可任选两个情景做参数级差异归因。同一台引擎、同一条路径，差别只来自输入。">
            <SimpleTable
              columns={["情景", "状态", "净投资", "NPV", "IRR", "回收期（折现）", "度电成本", "输入指纹"]}
              align={["left", "left", "right", "right", "right", "right", "right", "left"]}
              rows={project.scenarios.map((s) => [
                `${s.name}${s.isBaseline ? "（基线）" : ""}`,
                s.calcStatus === "ok" ? "已算通" : "未算通",
                fmtMoneyShort(s.capexNetYuan),
                fmtMoneyShort(s.npvYuan),
                fmtPct(s.irrPct),
                fmtYears(s.paybackYears),
                s.lcoeYuanPerKwh == null ? "—" : `${s.lcoeYuanPerKwh.toFixed(4)} 元/kWh`,
                s.inputHash ?? "—",
              ])}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">把当前情景换成另一个起点（会重算并重新留档）：</span>
              {(
                [
                  ["grid-only", "纯电网充电"],
                  ["pv-charging", "光伏 + 有序充电"],
                  ["pv-bess-tou", "光伏 + 储能 + 有序充电"],
                  ["full", "全能配置"],
                ] as const
              ).map(([id, label]) => (
                <Button key={id} size="sm" variant="secondary" disabled={recalcBusy} onClick={() => onSwitchTemplate(id)}>
                  {label}
                </Button>
              ))}
            </div>

            {project.scenarios.length >= 2 ? (
              <ScenarioAttributionPanel
                scenarios={project.scenarios.map((s) => ({ id: s.id, name: s.name, isBaseline: s.isBaseline }))}
                defaultAId={activeId}
              />
            ) : null}
          </Section>

          <Separator />

          {/* ── 8 决策结果 ── */}
          <Section index={8} title="决策结果" description="可行性判据、关键驱动、风险与关键假设——每一条都必须带得出具体数值。">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricCard
                label="可行性"
                value={calc.decision.feasibility.feasible ? "通过" : "未通过"}
                tone={calc.decision.feasibility.feasible ? "good" : "bad"}
                hint={`${calc.decision.feasibility.checks.filter((c) => c.passed).length}/${calc.decision.feasibility.checks.length} 条判据通过`}
              />
              <MetricCard
                label="推荐结论"
                value={calc.decision.recommendation.recommended ? "建议推进" : "暂不建议"}
                tone={calc.decision.recommendation.recommended ? "good" : "bad"}
                hint={calc.decision.recommendation.headline}
              />
            </div>

            {calc.decision.feasibility.blockers.length > 0 ? (
              <Alert variant="danger" className="mt-3" title="阻断项">
                {calc.decision.feasibility.blockers.join("；")}
              </Alert>
            ) : null}

            <h3 className="mt-4 mb-2 text-sm font-semibold">可行性判据</h3>
            <SimpleTable
              columns={["判据", "结果", "说明"]}
              rows={calc.decision.feasibility.checks.map((c) => [c.label, c.passed ? "通过" : "未通过", c.detail])}
            />

            <h3 className="mt-4 mb-2 text-sm font-semibold">关键驱动（NPV 摆幅，元）</h3>
            <SimpleTable
              columns={["变量", "NPV 摆幅"]}
              align={["left", "right"]}
              rows={calc.decision.keyDrivers.map((d) => [d.label, fmtMoney(d.swingYuan)])}
            />

            <h3 className="mt-4 mb-2 text-sm font-semibold">敏感性（NPV 区间，元）</h3>
            <SimpleTable
              columns={["变量", "下限 NPV", "基准 NPV", "上限 NPV"]}
              align={["left", "right", "right", "right"]}
              rows={calc.decision.sensitivity.map((s) => [
                s.label,
                fmtMoney(s.npvAtLow),
                fmtMoney(calc.economics.metrics.npvYuan),
                fmtMoney(s.npvAtHigh),
              ])}
            />

            <h3 className="mt-4 mb-2 text-sm font-semibold">风险</h3>
            <SimpleTable
              columns={["风险", "严重度", "数值依据", "应对"]}
              rows={calc.decision.risks.map((r) => [r.title, SEVERITY_LABEL[r.severity] ?? r.severity, r.basis, r.mitigation])}
            />

            <h3 className="mt-4 mb-2 text-sm font-semibold">关键假设（若不成立会怎样）</h3>
            <SimpleTable
              columns={["假设", "取值", "证据等级", "若不成立"]}
              rows={calc.decision.criticalAssumptions.map((a) => [
                a.label,
                `${a.value}${a.unit ? ` ${a.unit}` : ""}`,
                a.evidenceKind === "FACT" ? "已核实" : a.evidenceKind === "ASSUMPTION" ? "假设" : a.evidenceKind,
                a.impactIfWrong,
              ])}
            />

            <h3 className="mt-4 mb-2 text-sm font-semibold">结论说明</h3>
            <div className="flex flex-col gap-2">
              <p className="text-sm leading-relaxed">{calc.decision.explanation.summary}</p>
              {calc.decision.explanation.paragraphs.map((p, i) => (
                <p key={i} className="text-sm leading-relaxed text-muted-foreground">
                  {p}
                </p>
              ))}
            </div>
          </Section>

          <Separator />

          {/* ── 9 自动推荐 ── */}
          <Section
            index={9}
            title="自动推荐（配置寻优）"
            description="把「桩数 × 功率 × 储能 × 光伏 × 并网 × 有序充电」这上千种组合交给服务端逐套跑引擎，给出最优配置与落选原因——搜索不该由用户用脑子做。"
          >
            <RecommendPanel base={inputs} projectId={projectId} onSaved={() => void loadProject()} />
          </Section>

          <Separator />

          {/* ── 10 决策报告 ── */}
          <Section index={10} title="决策报告" description="可留档、可复算的完整报告；报告头的溯源信息齐全，凭它就能独立重算。">
            {report ? (
              <DecisionReportView report={report} />
            ) : (
              <Alert variant="warning" title="暂无报告">
                本次计算没有产出报告，可能因为计算未通过。
              </Alert>
            )}
            {activeId ? (
              <DecisionExportPanel
                scenarioId={activeId}
                scenarioName={active?.name ?? ""}
                calcStatus={active?.calcStatus ?? "unknown"}
                report={report}
              />
            ) : null}
          </Section>

          <Separator />

          {/* 诊断与基准 */}
          <Card>
            <CardHeader>
              <CardTitle>诊断与基准参数</CardTitle>
              <p className="text-sm text-muted-foreground">
                诊断按「输入缺口 / 证据不足 / 约束不满足 / 计算异常 / 模型边界」分类；基准参数逐条标注来源可信度。
              </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div>
                <h3 className="mb-2 text-sm font-semibold">诊断（{calc.diagnostics.length} 条）</h3>
                {calc.diagnostics.length === 0 ? (
                  <p className="text-sm text-muted-foreground">本次计算没有需要提示的问题。</p>
                ) : (
                  <SimpleTable
                    columns={["类别", "代码", "说明", "建议"]}
                    rows={calc.diagnostics.map((d) => [
                      KIND_LABEL[d.kind] ?? d.kind,
                      d.code,
                      d.message,
                      d.suggestion ?? "—",
                    ])}
                  />
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">基准参数快照 · 来源下钻</h3>
                <BenchmarkSourcesPanel snapshot={calc.benchmarkSnapshot} benchmarkVersion={calc.benchmarkVersion} />
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* 实测回填 */}
          <Section index={11} title="实测回填（Actuals）" description="项目落地后的真实数据回流，用于把「预测」与「实测」放在一起看。">
            <ActualsPanel projectId={projectId} scenarioId={activeId} />
          </Section>

          <Separator />

          {/* 版本历史与溯源 */}
          <Section index={12} title="版本历史与溯源" description="这个结论属于哪个版本、按哪套引擎与基准算的、之前怎么来的——逐版回看，历史不会被今天的模型悄悄改写。">
            {activeId ? (
              <ScenarioVersionsPanel scenarioId={activeId} />
            ) : (
              <p className="text-sm text-muted-foreground">请先选择一个情景。</p>
            )}
          </Section>

          <Separator />

          {/* ── 13 预测 vs 实测与校准（R6 · M13） ── */}
          <Section
            index={13}
            title="预测 vs 实测与校准"
            description="把「当初冻结的预测」与「回填的实测」放在一起对照：指出偏差、换算影响、识别需要人工复核的校准建议。系统只提建议，改不改基准/引擎永远发生在人工审核门之后——这是一条分析链，不是自动改模链。"
          >
            <div className="flex flex-col gap-8">
              <DeviationPanel projectId={projectId} scenarioId={activeId} />
              <Separator />
              <CalibrationPanel projectId={projectId} scenarioId={activeId} />
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );
}
