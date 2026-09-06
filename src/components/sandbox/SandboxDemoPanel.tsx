/**
 * R8.8a「示范项目参数模型」面板（客户端 · 用户操作层简化入口）。
 *
 * 这是《R8.8 最小实施方案》§8 的落地：普通用户只看到 ~10 个核心参数（地区 + 车队/光伏/储能/充电/电价），
 * 每个参数带「用户输入 / 系统默认 / 计算值 / 外部数据」来源徽标 + 更新时间/来源；「项目总投资」作为**醒目计算结果**
 * 展示（不作输入）。全部计算/图表/报告/保存**复用既有纯函数与组件**（`computeDemoScenario` → 既有引擎链 +
 * `SandboxCharts` + `SandboxReportPanel` + `SandboxSavePanel`），本文件**不做任何经济计算、不新增 API 路由、零 schema 迁移**。
 *
 * 高级用户点「展开完整参数工作台」即切到既有 `SandboxWorkbench`（40 参数全量），R8.8a 不因此扩展开发范围。
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
import {
  computeDemoScenario,
  defaultDemoState,
  serializeDemoLayers,
  DEMO_MODEL_VERSION,
  DEMO_HEADLINE_SPECS,
  type DemoFieldId,
  type DemoHeadlineState,
  type DemoTouched,
  type ParamSourceCategory,
} from "@/server/sandbox-demo";
import { DEFAULT_REGION_ID, getRegionPack, listRegionOptions } from "@/server/sandbox-regions";
import type { Tone } from "@/lib/sandbox-view";
import type { MetricCard } from "@/lib/sandbox-view";
import { formatMoney } from "@/lib/sandbox-view";
import { SandboxReportPanel } from "./SandboxReportPanel";
import { SandboxSavePanel } from "./SandboxSavePanel";
import {
  BreakdownBar,
  CashFlowChart,
  TornadoChart,
  Year1MoneyChart,
} from "./SandboxCharts";

const TONE_CLASS: Record<Tone, string> = {
  pos: "border-emerald-200 bg-emerald-50 text-emerald-700",
  neg: "border-rose-200 bg-rose-50 text-rose-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  muted: "border-zinc-200 bg-zinc-50 text-zinc-600",
};

/** 四类来源认知标签的配色（用户输入蓝 / 系统默认灰 / 计算值青 / 外部数据紫）。 */
const CATEGORY_CLS: Record<ParamSourceCategory, string> = {
  USER_INPUT: "border-blue-200 bg-blue-50 text-blue-700",
  SYSTEM_DEFAULT: "border-zinc-200 bg-zinc-50 text-zinc-600",
  CALCULATED: "border-teal-200 bg-teal-50 text-teal-700",
  EXTERNAL_DATA: "border-violet-200 bg-violet-50 text-violet-700",
};

const REGION_OPTIONS = listRegionOptions();

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

/** 来源徽标行：类别 + （外部数据）子类 + 更新时间/来源 + 是否已核实/已裁剪。 */
function OriginBadges({
  category,
  categoryLabel,
  externalKind,
  userModified,
  clamped,
  verified,
  asOf,
  sourceType,
}: {
  category: ParamSourceCategory;
  categoryLabel: string;
  externalKind?: "地区" | "政策";
  userModified: boolean;
  clamped: boolean;
  verified: boolean;
  asOf?: string;
  sourceType?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]">
      <span className={`rounded border px-1.5 py-0.5 ${CATEGORY_CLS[category]}`}>{categoryLabel}</span>
      {externalKind ? (
        <span className="rounded border border-violet-200 bg-white px-1.5 py-0.5 text-violet-600">
          {externalKind}
        </span>
      ) : null}
      {clamped ? <Badge variant="neutral" className="text-[10px]">已裁剪到边界</Badge> : null}
      {category === "EXTERNAL_DATA" ? (
        verified ? (
          <Badge variant="outline" className="text-[10px] text-emerald-700">已核实外部数据</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-amber-700">示例假设·待核实</Badge>
        )
      ) : null}
      {asOf ? <span className="text-zinc-400">数据时点 {asOf}</span> : null}
      {sourceType ? <span className="text-zinc-400">· {sourceType}</span> : null}
      {!userModified && category !== "EXTERNAL_DATA" && category !== "CALCULATED" ? null : null}
    </div>
  );
}

export function SandboxDemoPanel({ onOpenFull }: { onOpenFull?: () => void }) {
  const [state, setState] = useState<DemoHeadlineState>(defaultDemoState());
  const [touched, setTouched] = useState<DemoTouched>({});
  const [showReport, setShowReport] = useState(false);
  const [showSave, setShowSave] = useState(false);

  // 一次推演：映射层 → 既有引擎链 → 视图模型 + 动态报告（本组件零计算，全复用）。
  const scn = useMemo(() => computeDemoScenario(state, touched), [state, touched]);
  const { vm, report, outputs, resolved, tornado } = scn;
  const pack = getRegionPack(state.regionId);
  const savedLayers = useMemo(
    () => serializeDemoLayers(scn) as unknown as Record<string, unknown>,
    [scn],
  );

  const sliderSpecs = DEMO_HEADLINE_SPECS.filter((s) => s.id !== "region");

  function setField(id: DemoFieldId, v: number) {
    setState((prev) => ({ ...prev, [id]: v }));
    setTouched((prev) => ({ ...prev, [id]: true }));
  }
  function setRegion(id: string) {
    setState((prev) => ({ ...prev, regionId: id }));
  }
  function reset() {
    setState(defaultDemoState());
    setTouched({});
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert variant="warning">
        <strong>示范项目参数模型（新能源重卡 + 光伏 + 储能 + 充电）。</strong>
        这里只露出最关键的几个参数，改任一项即调用既有沙盘引擎**整链重算**——技术能耗、经济评价（NPV/IRR/回收期/ROI）、
        图表、敏感性与动态报告同步变化。下方默认数字均为<span className="font-medium">占位假设（未经逐条核实）</span>，
        经济口径为透明简化 E1–E8，结果恒「需专业人工确认」，<span className="font-medium">不得作为投资或并网决策依据</span>。
      </Alert>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        {/* ─────────── 左：10 参数简化控制台 ─────────── */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">核心参数（简化）</CardTitle>
            <CardDescription>选地区载入默认电价 / 光照 / 补贴，再改下面几项；右侧全链即时重算。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* 选地区 */}
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-zinc-500">选地区（载入默认参数）</div>
              <div className="flex flex-wrap gap-2">
                {REGION_OPTIONS.map((r) => {
                  const active = r.id === state.regionId;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRegion(r.id)}
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
              {state.regionId !== DEFAULT_REGION_ID ? (
                <p className="text-[11px] leading-tight text-zinc-500">{pack.summary}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-between">
              <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={Object.keys(touched).length === 0}>
                重置{Object.keys(touched).length ? `（已改 ${Object.keys(touched).length}）` : ""}
              </Button>
              {onOpenFull ? (
                <Button type="button" variant="secondary" size="sm" onClick={onOpenFull}>
                  展开完整参数工作台 →
                </Button>
              ) : null}
            </div>

            {/* headline 滑块（含来源徽标） */}
            {sliderSpecs.map((spec) => {
              const info = scn.headlines.find((h) => h.spec.id === spec.id)!;
              const o = info.origin;
              const raw = state[spec.id as keyof DemoHeadlineState] as unknown as number;
              const step = niceStep(spec.min, spec.max);
              const isInt = spec.max >= 100 && spec.unit !== "元/kWh";
              return (
                <div key={spec.id} className="flex flex-col gap-1" title={spec.note}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="truncate pr-2" title={spec.note}>
                      {spec.label}
                      {spec.unit ? <span className="text-zinc-400">（{spec.unit}）</span> : null}
                    </span>
                    <input
                      type="number"
                      value={Number.isFinite(raw) ? raw : ""}
                      min={spec.min}
                      max={spec.max}
                      step={isInt ? 1 : step}
                      onChange={(e) => {
                        const n = e.target.valueAsNumber;
                        if (Number.isFinite(n)) setField(spec.id, n);
                      }}
                      className="w-28 rounded-md border border-input bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                    />
                  </div>
                  <input
                    type="range"
                    value={Number.isFinite(raw) ? raw : spec.min}
                    min={spec.min}
                    max={spec.max}
                    step={isInt ? 1 : step}
                    onChange={(e) => setField(spec.id, e.target.valueAsNumber)}
                    className="w-full accent-blue-600"
                  />
                  <div className="flex items-center justify-between">
                    <OriginBadges
                      category={o.category}
                      categoryLabel={o.categoryLabel}
                      externalKind={o.externalKind}
                      userModified={o.userModified}
                      clamped={o.clamped}
                      verified={o.verified}
                      asOf={o.asOf}
                      sourceType={o.sourceType}
                    />
                    <span className="text-[10px] text-zinc-400">默认 {spec.id === "elecPrice" ? (0.7).toFixed(2) : raw === undefined ? "" : defaultHint(spec.id)}</span>
                  </div>
                </div>
              );
            })}

            {/* 计算输出：项目总投资等"结果而非输入"，一律计算值 */}
            <div className="mt-1 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-500">
                计算结果（随上面参数即时重算，只读）
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${CATEGORY_CLS.CALCULATED}`}>计算值</span>
              </div>
              <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                <div className="text-[11px] text-blue-700/80">项目总投资（毛，自下而上算出）</div>
                <div className="text-lg font-semibold tabular-nums text-blue-800">{outputs.totalInvestmentGrossLabel}</div>
              </div>
              <dl className="flex flex-col gap-1 text-sm">
                <Row k="净投资（补贴后）" v={formatMoney(outputs.totalInvestmentNet)} />
                <Row k="年充电量（车队口径）" v={`${outputs.annualChargeEnergyKwh.toLocaleString("zh-CN")} kWh`} />
                <Row k="日充电总量" v={`${Math.round(outputs.dailyChargeEnergyKwh).toLocaleString("zh-CN")} kWh/日`} />
                <Row k="充电总装机功率" v={`${Math.round(resolved.numeric["derived.chargerTotalPower"] ?? 0).toLocaleString("zh-CN")} kW`} />
                <Row k="储能时长" v={`${(resolved.numeric["derived.storageDuration"] ?? 0).toFixed(2)} h`} />
              </dl>
            </div>

            <div className="flex flex-col gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowReport((v) => !v)} aria-pressed={showReport}>
                {showReport ? "收起动态报告" : "生成动态报告"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowSave((v) => !v)}
                aria-pressed={showSave}
                disabled={!vm.ok}
              >
                {showSave ? "收起保存面板" : "保存 / 版本"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ─────────── 右：结果与图表 ─────────── */}
        <div className="flex flex-col gap-6">
          {!vm.ok ? (
            <Alert variant="danger">
              <div className="font-medium">当前参数不足以出图</div>
              <div className="mt-1 text-sm">原因：{vm.error?.reason} · {vm.error?.detail}</div>
            </Alert>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {vm.cards?.map((c) => <MetricTile key={c.key} card={c} />)}
              </div>
              {vm.needsProfessionalReview ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <Badge variant="warning">需专业人工确认</Badge>
                  <span>总投资（毛）{outputs.totalInvestmentGrossLabel} · 净 {formatMoney(outputs.totalInvestmentNet)} · 计算期 {vm.meta?.projectLifeYears} 年</span>
                </div>
              ) : null}
              {vm.cashFlow ? <CashFlowChart data={vm.cashFlow} /> : null}
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                {vm.year1Money ? <Year1MoneyChart data={vm.year1Money} /> : null}
                {vm.capex ? <BreakdownBar title="初始投资 CAPEX 构成" desc="补贴前各实物分量（元）。" data={vm.capex} color="#3b82f6" /> : null}
                {vm.revenue ? <BreakdownBar title="首年收入构成" desc="充电 / 余电上网 / 运营补贴（元）。" data={vm.revenue} color="#16a34a" /> : null}
                {vm.opex ? <BreakdownBar title="首年运维成本 OPEX" desc="四类运维（元）。" data={vm.opex} color="#f97316" /> : null}
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
              <div className="text-[11px] text-zinc-400">
                溯源 {vm.calcRef} · model@{vm.engineVersions?.model} / tech@{vm.engineVersions?.tech} / finance@{vm.engineVersions?.finance} / params@{vm.engineVersions?.params} · 示范模型 demo@{DEMO_MODEL_VERSION}（映射层，不改经济内核）
              </div>
            </>
          )}

          {showReport ? <SandboxReportPanel report={report} /> : null}
          {showSave && vm.ok ? (
            <SandboxSavePanel layers={savedLayers} regionId={state.regionId} regionName={`${pack.name}（示范项目）`} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="truncate pr-2 text-zinc-500">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}

/** 各 headline 字段的系统默认值文本（供"默认 X"提示，与 defaultDemoState 单一真源）。 */
function defaultHint(id: DemoFieldId): string {
  const d = defaultDemoState();
  const v = d[id as keyof DemoHeadlineState] as unknown as number;
  if (!Number.isFinite(v)) return "";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
