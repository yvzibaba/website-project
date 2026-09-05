/**
 * 沙盘交互工作台（中途重构 R4 · 可视化 + §4 命脉端到端交互层）。
 *
 * 这里是《项目中途重构总控》§4「改参数→模型重算→技术/经济/图表/风险全变」的**用户可感知兑现点**：
 *   - **纯前端即时重算**：`runSandboxModel`/`computeTechModel`/`computeTornado` 都是无 DB、无网络的纯函数
 *     （见 sandbox-model.ts 依赖分析），因此直接打进浏览器 bundle、随参数状态 `useMemo` 重跑整条链，
 *     拖动滑杆即看经济/图表变化——不是「只改页面上的数字」，而是真的把能量与价格参数重新撮合成钱。
 *   - **参数驱动 UI**（第 5 条「一切关键变量皆参数」）：控件不是硬编码字段，而是从 `SANDBOX_PARAMS` 的
 *     `exposure` 层级（basic / advanced）自动渲染，改模板即改界面，单一真源。
 *   - **派生量实时联动**：只读展示 `derived.*`（日充电总量 / 充电总功率 / 储能时长），改上游即变，§4 显性化。
 *   - **诚实贯穿**（第 16/20 条）：顶部横幅声明「全部为占位假设 + 需专业人工确认 + E2E 主链未通不得当决策依据」，
 *     每个参数标 `ASSUMPTION` 置信度，被裁剪到边界如实标注，指标算不出显示「—」而非 0。
 *
 * 边界（截至 R6.2）：本页已接入**确定性动态报告**（`buildSandboxReport` + `SandboxReportPanel`，改参数即整份重写）
 *   与**AI 解释**（`SandboxExplainPanel` → 受登录门禁的 `POST /api/sandbox/explain`，LLM 只解读报告、绝不算数、成本入 ModelCall）。
 *   项目保存/版本（R3 `sandbox-store`，R6.3）尚未接到本页。
 */

"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import { SANDBOX_PARAMS, resolveSandbox } from "@/server/sandbox-params";
import { runSandboxModel } from "@/server/sandbox-model";
import { computeTechModel } from "@/server/sandbox-tech";
import { computeTornado } from "@/server/sandbox-sensitivity";
import {
  DEFAULT_REGION_ID,
  buildSandboxLayers,
  getRegionPack,
  listRegionOptions,
  SANDBOX_REGIONS_VERSION,
} from "@/server/sandbox-regions";
import { buildSandboxViewModel } from "@/lib/sandbox-view";
import type { MetricCard, Tone } from "@/lib/sandbox-view";
import { buildSandboxReport } from "@/lib/sandbox-report";
import type { ChangedParamView } from "@/lib/sandbox-report";
import { SandboxReportPanel } from "./SandboxReportPanel";
import { SandboxExplainPanel } from "./SandboxExplainPanel";
import {
  BreakdownBar,
  CashFlowChart,
  TornadoChart,
  Year1MoneyChart,
} from "./SandboxCharts";

type Override = Record<string, number | boolean>;

const TONE_CLASS: Record<Tone, string> = {
  pos: "border-emerald-200 bg-emerald-50 text-emerald-700",
  neg: "border-rose-200 bg-rose-50 text-rose-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  muted: "border-zinc-200 bg-zinc-50 text-zinc-600",
};

/** 参数来源徽章文案（§5/§6：让用户看见「这个值是从哪层来的」）。 */
const ORIGIN_BADGE: Record<string, { label: string; cls: string } | null> = {
  region: { label: "地区默认", cls: "border-sky-200 bg-sky-50 text-sky-700" },
  policy: { label: "政策", cls: "border-violet-200 bg-violet-50 text-violet-700" },
};

const REGION_OPTIONS = listRegionOptions();

/** 由区间推一个「好看」的滑杆步长（避免 1e-15 级细碎步进）。 */
function niceStep(min: number, max: number): number {
  const raw = (max - min) / 100;
  if (!Number.isFinite(raw) || raw <= 0) return 0.01;
  if (raw >= 100) return Math.round(raw);
  if (raw >= 1) return Math.round(raw * 10) / 10;
  return Number(raw.toPrecision(1));
}

function MetricTile({ card }: { card: MetricCard }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${TONE_CLASS[card.tone]}`}>
      <div className="text-xs opacity-80">{card.label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{card.value}</div>
      {card.hint ? <div className="mt-1 text-[11px] leading-tight opacity-80">{card.hint}</div> : null}
    </div>
  );
}

export function SandboxWorkbench() {
  const [overrides, setOverrides] = useState<Override>({});
  const [advanced, setAdvanced] = useState(false);
  const [regionId, setRegionId] = useState<string>(DEFAULT_REGION_ID);
  const [showReport, setShowReport] = useState(false);
  const [showExplain, setShowExplain] = useState(false);

  // 分层情景 = 地区包(region+policy) 垫底 + 用户覆写在上（§6 优先级）。切地区即换整份默认。
  const layers = useMemo(() => buildSandboxLayers(regionId, overrides), [regionId, overrides]);
  const pack = getRegionPack(regionId);

  // 参数分层解析（含派生）→ 经济编排 → 技术能量 → 敏感性（锚定「当前情景」，随地区/参数变）。
  const resolved = useMemo(() => resolveSandbox(layers), [layers]);
  const calc = useMemo(() => runSandboxModel(layers), [layers]);
  const tech = useMemo(
    () => (calc.ok ? computeTechModel(resolved.numeric) : null),
    [calc, resolved],
  );
  const tornado = useMemo(() => computeTornado({ layers }), [layers]);
  const discountRate = (resolved.numeric["finance.discountRate"] ?? 8) / 100;

  const vm = useMemo(
    () =>
      buildSandboxViewModel({
        calc,
        tech: tech && tech.ok ? tech.firstYear : null,
        tornado,
        discountRate,
      }),
    [calc, tech, tornado, discountRate],
  );

  const editable = SANDBOX_PARAMS.filter(
    (s) => s.editable && !s.derived && (s.exposure === "basic" || (advanced && s.exposure === "advanced")),
  );
  const derivedView = SANDBOX_PARAMS.filter((s) => s.derived).map((s) => ({
    spec: s,
    value: resolved.params[s.key]?.value ?? s.defaultValue,
  }));
  const changedCount = Object.keys(overrides).length;

  // 用户改动清单（§9 报告来路叙述用）：键排序保证确定性，标签/单位取自参数模板单一真源。
  const changedParams = useMemo<ChangedParamView[]>(() => {
    return Object.keys(overrides)
      .sort()
      .map((key) => {
        const spec = SANDBOX_PARAMS.find((s) => s.key === key);
        const raw = overrides[key];
        const value =
          typeof raw === "boolean" ? (raw ? "开" : "关") : String(raw);
        return { key, label: spec?.label ?? key, value, unit: spec?.unit };
      });
  }, [overrides]);

  // 动态报告：吃「当前」视图模型，改任参数/切地区即整份重写（§9「读最新 CalcResult」，无 AI/无网络/无重算）。
  const report = useMemo(
    () =>
      buildSandboxReport({
        vm,
        regionName: pack.name,
        changedParams,
        discountRatePct: discountRate * 100,
      }),
    [vm, pack.name, changedParams, discountRate],
  );

  function setVal(key: string, v: number | boolean) {
    setOverrides((prev) => ({ ...prev, [key]: v }));
  }
  function reset() {
    setOverrides({});
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert variant="warning">
        <strong>这是「产业项目可视化决策沙盘」演示（V1）。</strong>
        下方全部默认数字都是<span className="font-medium">占位假设（未经逐条核实）</span>
        ，经济口径为透明简化的 E1–E8 而非可研级，结果恒「需专业人工确认」；且 §17 端到端主链（报告 /
        AI 解释 / 落库）尚未全接通，<span className="font-medium">不得作为投资或并网决策依据</span>。
        拖动左侧参数即可看到技术 / 经济 / 图表 / 敏感性即时重算——这才是沙盘的命脉，而非页面数字游戏。
      </Alert>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
        {/* ─────────── 左：参数控制台 ─────────── */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">参数控制台</CardTitle>
            <CardDescription>
              先选地区载入默认电价 / 光照 / 补贴（§6），再改任一项，右侧全链即时重算。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* 选地区（§6：地区/政策层垫底，用户覆写在上；切地区即换整份默认） */}
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-zinc-500">选地区（载入默认参数）</div>
              <div className="flex flex-wrap gap-2">
                {REGION_OPTIONS.map((r) => {
                  const active = r.id === regionId;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRegionId(r.id)}
                      aria-pressed={active}
                      title={r.summary}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        active
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-input bg-transparent text-zinc-600 hover:bg-zinc-50"
                      }`}
                    >
                      {r.name}
                    </button>
                  );
                })}
              </div>
              {regionId !== DEFAULT_REGION_ID ? (
                <p className="text-[11px] leading-tight text-zinc-500">{pack.summary}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setAdvanced((a) => !a)}
              >
                {advanced ? "收起高级参数" : "展开高级参数"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={changedCount === 0}>
                重置{changedCount ? `（已改 ${changedCount}）` : ""}
              </Button>
            </div>

            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowReport((v) => !v)}
              aria-pressed={showReport}
            >
              {showReport ? "收起动态报告" : "生成动态报告"}
            </Button>

            {vm.ok ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowExplain((v) => !v)}
                aria-pressed={showExplain}
              >
                {showExplain ? "收起 AI 解释" : "AI 解释此结果"}
              </Button>
            ) : null}

            {editable.map((s) => {
              const rp = resolved.params[s.key];
              const min = rp?.allowedMin ?? s.min ?? 0;
              const max = rp?.allowedMax ?? s.max ?? 100;
              const raw = overrides[s.key] ?? (rp?.value ?? s.defaultValue);
              const step = niceStep(min, max);

              if (s.kind === "boolean") {
                const on = raw === true || raw === 1;
                return (
                  <label key={s.key} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      {s.label}
                      <span className="ml-1 align-middle">
                        <Badge variant="outline" className="text-[10px]">
                          假设
                        </Badge>
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setVal(s.key, e.target.checked)}
                      className="h-4 w-4 accent-blue-600"
                    />
                  </label>
                );
              }

              const value = typeof raw === "number" ? raw : Number(raw);
              const userTouched = overrides[s.key] !== undefined;
              const originBadge = !userTouched ? ORIGIN_BADGE[rp?.origin ?? ""] : null;
              return (
                <div key={s.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="truncate pr-2" title={s.label}>
                      {s.label}
                      {s.unit ? <span className="text-zinc-400">（{s.unit}）</span> : null}
                    </span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={Number.isFinite(value) ? value : ""}
                        min={min}
                        max={max}
                        step={step}
                        onChange={(e) => {
                          const n = e.target.valueAsNumber;
                          if (Number.isFinite(n)) setVal(s.key, n);
                        }}
                        className="w-24 rounded-md border border-input bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                      />
                    </div>
                  </div>
                  <input
                    type="range"
                    value={Number.isFinite(value) ? value : min}
                    min={min}
                    max={max}
                    step={step}
                    onChange={(e) => setVal(s.key, e.target.valueAsNumber)}
                    className="w-full accent-blue-600"
                  />
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>
                      区间 {min}–{max}
                    </span>
                    {rp?.clamped ? (
                      <Badge variant="neutral" className="text-[10px]">
                        已裁剪到边界
                      </Badge>
                    ) : userTouched ? (
                      <Badge variant="neutral" className="text-[10px]">
                        已改
                      </Badge>
                    ) : originBadge ? (
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${originBadge.cls}`}
                      >
                        {originBadge.label}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}

            <div className="mt-2 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3">
              <div className="mb-2 text-xs font-medium text-zinc-500">派生量（随上游即时重算，只读）</div>
              <dl className="flex flex-col gap-1 text-sm">
                {derivedView.map(({ spec, value }) => (
                  <div key={spec.key} className="flex items-center justify-between">
                    <dt className="truncate pr-2 text-zinc-500" title={spec.label}>
                      {spec.label}
                    </dt>
                    <dd className="tabular-nums">
                      {typeof value === "number" ? value.toLocaleString("zh-CN") : String(value)}
                      {spec.unit ? <span className="text-zinc-400"> {spec.unit}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </CardContent>
        </Card>

        {/* ─────────── 右：结果与图表 ─────────── */}
        <div className="flex flex-col gap-6">
          {!vm.ok ? (
            <Alert variant="danger">
              <div className="font-medium">当前参数不足以出图</div>
              <div className="mt-1 text-sm">
                原因：{vm.error?.reason} · {vm.error?.detail}
              </div>
              {vm.error?.missingInputs?.length ? (
                <div className="mt-1 text-xs">缺少的输入：{vm.error.missingInputs.join("、")}</div>
              ) : null}
              {vm.error?.invalidInputs?.length ? (
                <div className="mt-1 text-xs">非法的输入：{vm.error.invalidInputs.join("、")}</div>
              ) : null}
            </Alert>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {vm.cards?.map((c) => (
                  <MetricTile key={c.key} card={c} />
                ))}
              </div>

              {vm.needsProfessionalReview ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <Badge variant="warning">需专业人工确认</Badge>
                  <span>
                    净 CAPEX {vm.meta?.capexNetLabel} · 毛 {vm.meta?.capexGrossLabel} · 补贴{" "}
                    {vm.meta?.subsidyLabel} · 计算期 {vm.meta?.projectLifeYears} 年
                  </span>
                </div>
              ) : null}

              {vm.cashFlow ? <CashFlowChart data={vm.cashFlow} /> : null}

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                {vm.year1Money ? <Year1MoneyChart data={vm.year1Money} /> : null}
                {vm.capex ? (
                  <BreakdownBar title="初始投资 CAPEX 构成" desc="补贴前各实物分量（元）。" data={vm.capex} color="#3b82f6" />
                ) : null}
                {vm.revenue ? (
                  <BreakdownBar title="首年收入构成" desc="充电 / 余电上网 / 运营补贴（元）。" data={vm.revenue} color="#16a34a" />
                ) : null}
                {vm.opex ? (
                  <BreakdownBar title="首年运维成本 OPEX" desc="四类运维（元）。" data={vm.opex} color="#f97316" />
                ) : null}
                {vm.energyBalance ? (
                  <BreakdownBar
                    title="首年能量平衡"
                    desc={`光伏自用率 ${vm.meta?.pvSelfConsumptionLabel ?? "—"} · 绿电占比 ${vm.meta?.renewableFractionLabel ?? "—"}（kWh）。`}
                    data={vm.energyBalance}
                    color="#0ea5e9"
                    money={false}
                  />
                ) : null}
                {vm.tornado ? <TornadoChart data={vm.tornado} base={tornado.baseValue} /> : null}
              </div>

              {vm.notes && vm.notes.length ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">模型口径提示</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-zinc-500">
                      {vm.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}

              <div className="text-[11px] text-zinc-400">
                溯源 {vm.calcRef} · 版本 model@{vm.engineVersions?.model} / tech@{vm.engineVersions?.tech} /
                finance@{vm.engineVersions?.finance} / params@{vm.engineVersions?.params} ·
                regions@{SANDBOX_REGIONS_VERSION} · 视图 v{vm.viewVersion}
              </div>
            </>
          )}

          {showReport ? <SandboxReportPanel report={report} /> : null}
          {showExplain && vm.ok ? <SandboxExplainPanel report={report} /> : null}
        </div>
      </div>
    </div>
  );
}
