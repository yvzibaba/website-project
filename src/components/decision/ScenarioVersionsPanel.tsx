"use client";

/**
 * V2 决策平台 · 情景「版本历史与溯源」面板（R5 版本治理，客户端组件）。
 *
 * ## 这块界面回答的唯一问题
 * 「眼前这个结论，是在哪个项目版本、哪个引擎版本、哪个基准版本、哪份输入之下算出来的，
 *   以及它之前是怎么一步步来的。」
 *
 * ## 铁律（为什么这里绝不做多余的事）
 *   - **纯读展示**：数据全部来自 `GET /api/workbench/decision/scenarios/[id]/versions`，
 *     那是从 `ProjectVersion` 里**原样提取**的不可变切片。面板**不重算**、不"按今天的模型刷新历史"——
 *     历史上那一版是按它**当时**的 engine/benchmark/schema 算的，就必须永远显示那一套指纹。
 *   - 空值如实显示「—」，绝不拿 0 或当下常量冒充（与 primitives 同一口径）。
 *   - 唯一的写动作是「把当前情景存为一个不可变新版本」（打里程碑），它**不改当前态、不重算**，
 *     只是把已经算好并留档的当前结果冻结一条快照。
 */

import { useCallback, useEffect, useState } from "react";
import { mutateJson } from "@/components/admin/mutate";
import { Alert, Button, Field, Input } from "@/components/ui";
import { SimpleTable, fmtMoneyShort, fmtPct, fmtYears } from "./primitives";

interface VersionProvenance {
  engineVersion: string | null;
  benchmarkVersion: string | null;
  scenarioSchemaVersion: string | null;
  inputHash: string | null;
  calculatedAt: string | null; // ISO
}

interface VersionSummary {
  calcStatus: string;
  feasible: boolean | null;
  recommended: boolean | null;
  capexNetYuan: number | null;
  npvYuan: number | null;
  irrPct: number | null;
  paybackYears: number | null;
  lcoeYuanPerKwh: number | null;
  npvEquityYuan: number | null;
  irrEquityPct: number | null;
}

interface VersionRow {
  id: string;
  seq: number;
  label: string | null;
  note: string | null;
  savedBy: string | null;
  frozenAt: string; // 冻结（存版）时刻 ISO
  provenance: VersionProvenance;
  summary: VersionSummary | null;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
}

/** 布尔三态：true→是 / false→否 / null→未评估（绝不把"没算"折成"否"）。 */
function tri(v: boolean | null | undefined): string {
  if (v === true) return "是";
  if (v === false) return "否";
  return "—";
}

export function ScenarioVersionsPanel({ scenarioId, onSaved }: { scenarioId: string; onSaved?: () => void }) {
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const res = await mutateJson(`/api/workbench/decision/scenarios/${scenarioId}/versions`, "GET");
    if (!res.ok) {
      if (res.status === 401) {
        setRows([]);
        setError("请先登录后查看版本历史。");
        return;
      }
      setRows([]);
      setError(res.message ?? "版本历史载入失败");
      return;
    }
    setRows(((res.data ?? {}).versions as VersionRow[]) ?? []);
  }, [scenarioId]);

  /**
   * 载入。刻意**不**在 effect 体内同步 setState（本项目 lint 明令禁止，会引发级联渲染）——
   * 所有状态更新都在 promise 回调里；「载入中」由 `rows === null` 兜住。
   */
  useEffect(() => {
    let alive = true;
    mutateJson(`/api/workbench/decision/scenarios/${scenarioId}/versions`, "GET").then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setRows([]);
        setError(res.status === 401 ? "请先登录后查看版本历史。" : res.message ?? "版本历史载入失败");
        return;
      }
      setRows(((res.data ?? {}).versions as VersionRow[]) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [scenarioId]);

  async function onSaveVersion() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      if (label.trim()) payload.label = label.trim();
      if (note.trim()) payload.note = note.trim();
      const res = await mutateJson(`/api/workbench/decision/scenarios/${scenarioId}/versions`, "POST", payload);
      if (!res.ok) {
        setError(res.message ?? "存版失败");
        return;
      }
      const seq = (res.data ?? {}).seq as number | undefined;
      setNotice(seq != null ? `已把当前结果冻结为不可变版本 v${seq}（当前态未被改写）。` : "已存为新版本。");
      setLabel("");
      setNote("");
      await load();
      onSaved?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info" title="历史只回看、不被今天的模型改写">
        每一次「重算」都会先把上一版**成功**结果冻结成这里的一条不可变版本，再写当前态——
        所以 V1→V2→V3 可逐版回看：各版**当时**用的引擎、基准、输入指纹、以及为什么变，都原样保留，
        不会因为你升级了模型就悄悄变成今天的数。下面这些数字是**提取**出来的，不是现算的。
      </Alert>

      {error ? <Alert variant="danger" title="提示">{error}</Alert> : null}
      {notice ? <Alert variant="success" title="已存版">{notice}</Alert> : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold">版本时间线（最新在前）</h3>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">载入中…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有历史版本。当你第一次重算（改动参数）或点下方「存为不可变新版本」时，会在此留下第一条。
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <SimpleTable
              columns={["版本", "状态", "净投资", "NPV", "IRR", "回收期", "度电成本", "可行性", "推荐"]}
              align={["left", "left", "right", "right", "right", "right", "right", "left", "left"]}
              rows={rows.map((r) => [
                `v${r.seq}${r.label ? ` · ${r.label}` : ""}`,
                r.summary?.calcStatus === "ok" ? "已算通" : (r.summary?.calcStatus ?? "—"),
                fmtMoneyShort(r.summary?.capexNetYuan ?? null),
                fmtMoneyShort(r.summary?.npvYuan ?? null),
                fmtPct(r.summary?.irrPct ?? null),
                fmtYears(r.summary?.paybackYears ?? null),
                r.summary?.lcoeYuanPerKwh == null ? "—" : `${r.summary.lcoeYuanPerKwh.toFixed(4)}`,
                tri(r.summary?.feasible),
                tri(r.summary?.recommended),
              ])}
            />

            <h3 className="mt-2 mb-2 text-sm font-semibold">各版溯源（这一版当时是怎么算出来的）</h3>
            <SimpleTable
              columns={["版本", "引擎版本", "基准版本", "输入Schema", "输入指纹", "计算时刻", "存版时刻", "存版人", "变更说明"]}
              align={["left", "left", "left", "left", "left", "left", "left", "left", "left"]}
              rows={rows.map((r) => [
                `v${r.seq}`,
                r.provenance.engineVersion ?? "—",
                r.provenance.benchmarkVersion ?? "—",
                r.provenance.scenarioSchemaVersion ?? "—",
                r.provenance.inputHash ?? "—",
                fmtDateTime(r.provenance.calculatedAt),
                fmtDateTime(r.frozenAt),
                r.savedBy ?? "—",
                r.note ?? "—",
              ])}
            />
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="mb-2 text-sm font-medium">把当前结果存为不可变新版本（打里程碑，不重算、不改当前态）</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="版本名称（可选）">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：电价上调后定稿" maxLength={100} />
          </Field>
          <Field label="说明（可选）">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="这一版为什么值得留档" maxLength={2000} />
          </Field>
        </div>
        <div className="mt-3">
          <Button onClick={onSaveVersion} disabled={busy}>{busy ? "存版中…" : "存为不可变新版本"}</Button>
        </div>
      </div>
    </div>
  );
}
