"use client";

/**
 * 免费诊断面板（M4 · P5）——公开漏斗的第一屏：**不注册、不建项目，也能拿到一句真结论**。
 *
 * 三条硬约束（决定了它为什么长这样）：
 * 1. **本组件不算任何数**。它只收集"用户真正知道的那几件事"（车队、里程、充电窗口、
 *    并网容量、打算收的服务费），发给 `/api/diagnose`，渲染服务端回来的结论。
 *    结论出自唯一生产引擎（`diagnoseScenario → runCalculation`），与登录后保存项目算出的
 *    数同源同版——所以"免费的数"不是玩具估算，是真结论的一个切面。
 * 2. **只给结论倾向 + 明显否证，不铺完整报告**。敏感性、逐参数归因、配置寻优、十四段报告
 *    是登录后/付费的深算（面板底部如实写明"留待深算"的内容，不藏着掖着，也不虚报全貌）。
 * 3. **不虚构联系方式**。出口只引导"存成项目继续"，不预设电话/微信/邮箱（由运营方在站点配置）。
 */

import { useState } from "react";
import type { DiagnosisOutcome, DiagnosisVerdict } from "@app/kernel/engine/diagnose";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
} from "@/components/ui";
import { mutateJson } from "@/components/admin/mutate";
import { MetricCard, fmtMoneyShort, fmtNum, fmtPct, fmtYears } from "@/components/decision/primitives";

/**
 * 情景模板下拉（id 必须与服务端 `SCENARIO_TEMPLATES` 一致）。
 * 这里只放"用户一看就懂"的三条主流路线 + 纯电网对照；换电类模板留给登录后的完整工作台。
 * 新增/改名模板时须与内核同步，否则服务端会以"未知情景模板"拒收（这是刻意的双保险）。
 */
const TEMPLATE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "grid-only", label: "纯电网充电（对照基准）" },
  { id: "grid-tou", label: "电网 + 分时电价引导" },
  { id: "pv-charging", label: "光伏 + 充电" },
  { id: "pv-bess-tou", label: "光伏 + 储能 + 有序充电" },
];

const VERDICT_BADGE: Record<DiagnosisVerdict, { text: string; variant: "success" | "warning" | "danger" | "neutral" }> = {
  promising: { text: "方向为正", variant: "success" },
  borderline: { text: "不划算", variant: "warning" },
  infeasible: { text: "当前不成立", variant: "danger" },
  not_computable: { text: "算不出可信结果", variant: "neutral" },
};

interface Resp {
  result: DiagnosisOutcome;
}

export function FreeDiagnosePanel() {
  const [templateId, setTemplateId] = useState("pv-bess-tou");
  const [truckCount, setTruckCount] = useState("30");
  const [dailyMileageKm, setDailyMileageKm] = useState("300");
  const [fee, setFee] = useState("");
  const [gridCapacityKw, setGridCapacityKw] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<Resp | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRes(null);

    const feeNum = Number(fee);
    if (!Number.isFinite(feeNum) || feeNum <= 0) {
      setError("请填写充电服务费单价（元/kWh）——它是这门生意的主要收入，也是唯一没有官方定价的输入，必须由你填你打算收的价。");
      return;
    }

    const body: Record<string, number | string> = {
      templateId,
      chargingServiceFeeYuanPerKwh: feeNum,
    };
    const tc = Number(truckCount);
    if (Number.isFinite(tc) && tc >= 1) body.truckCount = Math.floor(tc);
    const dm = Number(dailyMileageKm);
    if (Number.isFinite(dm) && dm >= 1) body.dailyMileageKm = dm;
    const gc = Number(gridCapacityKw);
    if (Number.isFinite(gc) && gc > 0) body.existingGridCapacityKw = gc;

    setBusy(true);
    const r = await mutateJson("/api/diagnose", "POST", body);
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.message ?? "诊断失败，请稍后再试");
      return;
    }
    setRes(r.data as unknown as Resp);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>先免费看一眼：这个场站大方向上成不成立？</CardTitle>
          <CardDescription>
            不用注册。填你真正知道的几件事——车队、里程、服务费、现有并网容量——平台用**同一台决策引擎**
            当场跑一套配置，给你一句结论倾向和一眼就该否决的问题。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={run} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dg-template">补能路线</Label>
                <select
                  id="dg-template"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {TEMPLATE_OPTIONS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dg-fee">
                  充电服务费（元/kWh）<span className="text-danger"> *</span>
                </Label>
                <Input
                  id="dg-fee"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="10"
                  inputMode="decimal"
                  placeholder="例如 0.45"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dg-trucks">车队规模（辆）</Label>
                <Input id="dg-trucks" type="number" min="1" max="5000" step="1" value={truckCount} onChange={(e) => setTruckCount(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dg-mileage">单车日均里程（km/运营日）</Label>
                <Input id="dg-mileage" type="number" min="1" max="2000" step="1" value={dailyMileageKm} onChange={(e) => setDailyMileageKm(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="dg-grid">现有并网容量（kW，选填）</Label>
                <Input id="dg-grid" type="number" min="1" max="2000000" step="1" placeholder="留空 = 按默认基准" value={gridCapacityKw} onChange={(e) => setGridCapacityKw(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              其余参数（电价、造价、设备规格等）先用平台默认基准，多为待核实的假设；结论仅供方向判断，需专业人工确认后方可作决策依据。
            </p>
            <div>
              <Button type="submit" disabled={busy}>
                {busy ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" /> 正在跑模型…
                  </>
                ) : (
                  "免费诊断一下"
                )}
              </Button>
            </div>
          </form>

          {error ? (
            <Alert variant="danger" className="mt-4">
              {error}
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {res ? <DiagnosisResult out={res.result} /> : null}
    </div>
  );
}

function DiagnosisResult({ out }: { out: DiagnosisOutcome }) {
  const vb = VERDICT_BADGE[out.verdict];
  const k = out.keyNumbers;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={vb.variant}>{vb.text}</Badge>
          <CardTitle className="text-base">{out.headline}</CardTitle>
        </div>
        <CardDescription>
          结论由生产决策引擎现算，可复算校验：诊断 {out.diagnoseRef} · 引擎 {out.engineVersion} · 模型 {out.modelVersion} · 基准 {out.benchmarkVersion}
          {out.inputHash ? ` · 输入指纹 ${out.inputHash.slice(0, 12)}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* 关键数字（算不通时全部显示为「—」，不是 0） */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="全投资 NPV" value={fmtMoneyShort(k.npvYuan)} tone={k.npvSign === "positive" ? "good" : k.npvSign === "non_positive" ? "bad" : "muted"} hint={k.npvSign === "positive" ? "为正" : k.npvSign === "non_positive" ? "不大于零" : undefined} />
          <MetricCard label="静态回收期" value={k.simplePaybackYears == null ? "未回本" : fmtYears(k.simplePaybackYears)} />
          <MetricCard label="全投资 IRR" value={k.irrPct == null ? "—" : fmtPct(k.irrPct)} />
          <MetricCard label="净投资（CAPEX）" value={fmtMoneyShort(k.capexNetYuan)} />
        </div>

        {/* 明显否证：一眼就该否决 / 必须先解决 */}
        {out.falsifications.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">需要先解决（明显否证）</h3>
            <ul className="flex flex-col gap-1.5">
              {out.falsifications.map((f) => (
                <li key={f.code} className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm">
                  {f.message}
                  {f.value != null && f.unit ? <span className="ml-1 tabular-nums text-muted-foreground">（{fmtNum(f.value)} {f.unit}）</span> : null}
                  {f.suggestion ? <span className="mt-0.5 block text-xs text-muted-foreground">建议：{f.suggestion}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Alert variant="success">没有发现一眼就该否决的硬问题。</Alert>
        )}

        {/* 判读信号 */}
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">怎么读这个结论</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {out.signals.map((s) => (
              <div key={s.label} className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
                <span className={s.tone === "good" ? "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-success" : s.tone === "bad" ? "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-danger" : "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warning"} />
                <span>
                  <span className="font-medium">{s.label}：</span>
                  {s.detail}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 诚实披露：免费层是切面，深算在登录后/付费 */}
        <div className="rounded-lg border border-border bg-background p-4">
          <h3 className="text-sm font-semibold">这一步免费看到的是切面，下面这些要存成项目才能解锁</h3>
          <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">
            {out.deepWorkWithheld.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button href="/workbench">存成项目，继续做完整决策</Button>
            <span className="text-xs text-muted-foreground">{out.paidNextStep}</span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{out.confidenceNote}</p>
      </CardContent>
    </Card>
  );
}
