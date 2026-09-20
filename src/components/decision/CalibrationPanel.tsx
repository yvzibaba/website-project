"use client";

/**
 * 校准建议 + 人工审核面板（R6 · M13 · §16–§20）。
 *
 * 这是整条分析链的**人工审核门**所在。系统只做两件事：
 *   ① 「检测」——把存档预测 vs 实测里方向一致、样本够、超阈值的系统性偏差，落成**校准候选（建议）**；
 *   ② 「呈现」——把每条候选的证据（样本数、方向、偏差区间、金额影响、建议）摆清楚，供人判断。
 *
 * 是否采纳完全由人决定（UNDER_REVIEW → ACCEPTED / REJECTED），且**采纳也不代表系统自动改了基准/引擎**：
 * ACCEPTED 只是「人认可了这条建议」，真正落地改财务/技术口径仍另需人工流程（宪法：财务口径留创始人）。
 *
 * 反「平均到 0 就没事」（§20）：这里刻意展示正/负计数与偏差区间，而不仅是均值。
 */

import { useCallback, useEffect, useState } from "react";
import { mutateJson } from "@/components/admin/mutate";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { fmtMoney, fmtNum, SimpleTable } from "./primitives";

/** 与 store 的 CalibrationCandidateView 对齐（本地声明：client 不 import server-only 模块）。 */
interface Candidate {
  id: string;
  metric: string;
  metricLabel: string;
  parameter: string | null;
  parameterLabel: string | null;
  measurementBasis: string;
  unit: string;
  periodKind: string;
  regionId: string | null;
  direction: string; // over_forecast | under_forecast
  forecastValue: number | null;
  actualValue: number | null;
  biasPct: number | null;
  meanAbsPct: number | null;
  sampleCount: number;
  impactYuan: number | null;
  impactEvidenceKind: string;
  evidence: unknown;
  suggestion: string;
  status: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EvidenceShape {
  comparableCount?: number;
  positiveCount?: number;
  negativeCount?: number;
  rangePct?: { min: number; max: number } | null;
  note?: string;
}

const STATUS_META: Record<string, { text: string; variant: "info" | "warning" | "success" | "danger" | "neutral" }> = {
  CANDIDATE: { text: "待复核", variant: "warning" },
  UNDER_REVIEW: { text: "复核中", variant: "info" },
  ACCEPTED: { text: "已采纳", variant: "success" },
  REJECTED: { text: "已驳回", variant: "neutral" },
};

const DIRECTION_LABEL: Record<string, string> = {
  over_forecast: "预测系统性偏高",
  under_forecast: "预测系统性偏低",
};

function StatusBadge({ status }: { status: string }) {
  const hit = STATUS_META[status] ?? { text: status, variant: "neutral" as const };
  return <Badge variant={hit.variant}>{hit.text}</Badge>;
}

function num(v: number | null, suffix = ""): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${fmtNum(v, 1)}${suffix}`;
}

export function CalibrationPanel({ projectId, scenarioId }: { projectId: string; scenarioId: string | null }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await mutateJson(`/api/workbench/decision/projects/${projectId}/calibration-candidates`, "GET");
    if (!res.ok) {
      setCandidates([]);
      setError(res.message ?? "校准候选载入失败");
      return;
    }
    setCandidates(((res.data ?? {}).candidates as Candidate[]) ?? []);
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    mutateJson(`/api/workbench/decision/projects/${projectId}/calibration-candidates`, "GET").then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setCandidates([]);
        setError(res.message ?? "校准候选载入失败");
        return;
      }
      setCandidates(((res.data ?? {}).candidates as Candidate[]) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function onDetect() {
    setError(null);
    setNotice(null);
    setDetectBusy(true);
    try {
      const res = await mutateJson(
        `/api/workbench/decision/projects/${projectId}/calibration-candidates`,
        "POST",
        scenarioId ? { scenarioId } : {},
      );
      if (!res.ok) {
        setError(res.message ?? "检测失败");
        return;
      }
      const data = (res.data ?? {}) as { detected?: number; created?: number };
      setNotice(
        `检测完成：本轮识别 ${data.detected ?? 0} 条系统性偏差建议，其中新增 ${data.created ?? 0} 条。已复核过的建议状态不会被覆盖。`,
      );
      await load();
    } finally {
      setDetectBusy(false);
    }
  }

  async function onReview(id: string, to: "UNDER_REVIEW" | "ACCEPTED" | "REJECTED") {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { to };
      const note = (noteDraft[id] ?? "").trim();
      if (note) body.note = note;
      const res = await mutateJson(`/api/workbench/decision/calibration-candidates/${id}`, "PATCH", body);
      if (!res.ok) {
        setError(res.message ?? "审核操作失败");
        return;
      }
      const label = to === "ACCEPTED" ? "已采纳（不代表系统已自动改基准，落地仍走人工流程）" : to === "REJECTED" ? "已驳回" : "已标记为复核中";
      setNotice(`该建议${label}。`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info" title="这是「建议」不是「改模」">
        系统只把「方向一致、样本足够、偏差超阈值」的预测指出为待复核候选；是否采纳由你决定。
        即便标记「已采纳」，也不会自动改动任何基准参数或引擎——那属于财务/技术口径调整，另需人工确认。
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onDetect} disabled={detectBusy}>
          {detectBusy ? "检测中…" : "检测偏差 → 生成校准建议"}
        </Button>
        <span className="text-sm text-muted-foreground">对照情景：{scenarioId ? "当前所选" : "默认基线"}</span>
      </div>

      {error ? <Alert variant="danger" title="操作失败">{error}</Alert> : null}
      {notice ? <Alert variant="success" title="提示">{notice}</Alert> : null}

      {!candidates ? (
        <p className="text-sm text-muted-foreground">载入中…</p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">尚无校准建议。录入实测数据后点「检测偏差」即可生成。</p>
      ) : (
        candidates.map((c) => {
          const ev = (c.evidence ?? {}) as EvidenceShape;
          const terminal = c.status === "ACCEPTED" || c.status === "REJECTED";
          return (
            <Card key={c.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {c.metricLabel}
                    {c.parameterLabel ? ` · 关联参数「${c.parameterLabel}」` : ""}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" compact>{DIRECTION_LABEL[c.direction] ?? c.direction}</Badge>
                    <StatusBadge status={c.status} />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{c.suggestion}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <SimpleTable
                  columns={["预测", "实测", "符号偏差均值", "平均绝对偏差", "样本数", "金额影响", "证据"]}
                  align={["right", "right", "right", "right", "right", "right", "left"]}
                  rows={[
                    [
                      num(c.forecastValue, c.unit === "元" ? " 元" : c.unit === "kWh" ? " kWh" : ""),
                      num(c.actualValue, c.unit === "元" ? " 元" : c.unit === "kWh" ? " kWh" : ""),
                      c.biasPct == null ? "—" : `${c.biasPct > 0 ? "+" : ""}${c.biasPct.toFixed(1)}%`,
                      num(c.meanAbsPct, "%"),
                      fmtNum(c.sampleCount),
                      c.impactYuan == null ? "—" : fmtMoney(c.impactYuan),
                      c.impactEvidenceKind === "FACT" ? "已核实" : "假设",
                    ],
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  口径：{c.measurementBasis}
                  {c.regionId ? ` · 地区 ${c.regionId}` : ""} · 分布：实测高于预测 {ev.positiveCount ?? 0} 次 / 低于 {ev.negativeCount ?? 0} 次
                  {ev.rangePct ? ` · 偏差区间 ${ev.rangePct.min.toFixed(1)}%~${ev.rangePct.max.toFixed(1)}%` : ""}
                  {ev.note ? ` · ${ev.note}` : ""}
                </p>
                {c.reviewedBy || c.reviewNote ? (
                  <p className="text-xs text-muted-foreground">
                    {c.reviewedBy ? `审核人 ${c.reviewedBy} · ` : ""}
                    {c.reviewedAt ? `${c.reviewedAt.slice(0, 10)} · ` : ""}
                    {c.reviewNote ? `备注：${c.reviewNote}` : ""}
                  </p>
                ) : null}

                {terminal ? (
                  <p className="text-xs text-muted-foreground">该建议已定论（{STATUS_META[c.status]?.text ?? c.status}），不再回退为待办。</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Field label="审核备注（可选）">
                      <Input
                        value={noteDraft[c.id] ?? ""}
                        onChange={(e) => setNoteDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        placeholder="记录判断依据，便于复盘"
                      />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      {c.status === "CANDIDATE" ? (
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onReview(c.id, "UNDER_REVIEW")}>
                          标记复核中
                        </Button>
                      ) : null}
                      <Button size="sm" disabled={busy} onClick={() => onReview(c.id, "ACCEPTED")}>
                        采纳建议
                      </Button>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onReview(c.id, "REJECTED")}>
                        驳回
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
