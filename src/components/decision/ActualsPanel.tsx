"use client";

/**
 * 实测回填面板（Actuals 骨架）。
 *
 * 两条铁律在这里落地：
 *   ① **没测 ≠ 为零**：输入框留空提交时不写 0，而是不传该字段，服务端落 `null`。
 *      用 0 顶替会让"预测 vs 实测"的偏差分析得出反向结论（例如把"尚未采集光伏数据"
 *      显示成"光伏一度没发"）。
 *   ② 幂等：同项目同期间重复提交即更新，不会堆出重复行；期间用「年度（0）」或「1–12 月」表达。
 *
 * 本面板只读写实测数据，不参与任何预测计算——两者放在一起看是要人来判断，
 * 不是让程序自动"修正"预测值。
 */

import { useCallback, useEffect, useState } from "react";
import { mutateJson } from "@/components/admin/mutate";
import { Alert, Button, Field, Input } from "@/components/ui";
import { SimpleTable, fmtNum } from "./primitives";

interface ActualRow {
  id: string;
  periodYear: number;
  periodMonth: number;
  gridImportKwh: number | null;
  pvGenerationKwh: number | null;
  bessDischargeKwh: number | null;
  deliveredKwh: number | null;
  exportKwh: number | null;
  gridCostYuan: number | null;
  revenueYuan: number | null;
  opexYuan: number | null;
  availabilityPct: number | null;
  source: string;
  note: string | null;
}

const SOURCE_LABEL: Record<string, string> = { manual: "人工录入", meter: "计量表", import: "系统导入" };

/** 空串 → undefined（"没填"），而不是 0。 */
function num(v: string): number | undefined {
  const t = v.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function ActualsPanel({ projectId, scenarioId }: { projectId: string; scenarioId: string | null }) {
  const [rows, setRows] = useState<ActualRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [year, setYear] = useState("2026");
  const [month, setMonth] = useState("0");
  const [gridImport, setGridImport] = useState("");
  const [pvGen, setPvGen] = useState("");
  const [bessDischarge, setBessDischarge] = useState("");
  const [delivered, setDelivered] = useState("");
  const [gridCost, setGridCost] = useState("");
  const [revenue, setRevenue] = useState("");
  const [opex, setOpex] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const res = await mutateJson(`/api/workbench/decision/projects/${projectId}/actuals`, "GET");
    if (!res.ok) {
      setRows([]);
      setError(res.message ?? "实测数据载入失败");
      return;
    }
    setRows(((res.data ?? {}).actuals as ActualRow[]) ?? []);
  }, [projectId]);

  /**
   * 首屏加载。刻意**不**在 effect 体内同步 setState（本项目 lint 明令禁止，会引发级联渲染）——
   * 所有状态更新都发生在 promise 回调里；「载入中」由 `rows === null` 兜住。
   */
  useEffect(() => {
    let alive = true;
    mutateJson(`/api/workbench/decision/projects/${projectId}/actuals`, "GET").then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setRows([]);
        setError(res.message ?? "实测数据载入失败");
        return;
      }
      setRows(((res.data ?? {}).actuals as ActualRow[]) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function onSave() {
    setError(null);
    setNotice(null);
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || y < 2000 || y > 2200) {
      setError("请填写合法的年份（2000–2200）");
      return;
    }
    if (!Number.isInteger(m) || m < 0 || m > 12) {
      setError("期间请选「年度」或 1–12 月");
      return;
    }

    const payload: Record<string, unknown> = {
      periodYear: y,
      periodMonth: m,
      source: "manual",
    };
    if (scenarioId) payload.scenarioId = scenarioId;
    // 只把真正填了的字段发出去——留空代表"没测"，不能变成 0
    const map: Array<[string, string]> = [
      ["gridImportKwh", gridImport],
      ["pvGenerationKwh", pvGen],
      ["bessDischargeKwh", bessDischarge],
      ["deliveredKwh", delivered],
      ["gridCostYuan", gridCost],
      ["revenueYuan", revenue],
      ["opexYuan", opex],
    ];
    for (const [k, v] of map) {
      const n = num(v);
      if (n !== undefined) payload[k] = n;
    }
    if (note.trim()) payload.note = note.trim();

    if (Object.keys(payload).length <= 3) {
      setError("至少要填一个实测数值再提交（全是空的记录没有意义）");
      return;
    }

    setBusy(true);
    try {
      const res = await mutateJson(`/api/workbench/decision/projects/${projectId}/actuals`, "POST", payload);
      if (!res.ok) {
        setError(res.message ?? "保存失败");
        return;
      }
      setNotice(`已保存 ${y} 年${m === 0 ? "（年度）" : `${m} 月`}的实测数据。留空的项按「未测」处理，不会写成 0。`);
      setGridImport("");
      setPvGen("");
      setBessDischarge("");
      setDelivered("");
      setGridCost("");
      setRevenue("");
      setOpex("");
      setNote("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    const res = await mutateJson(
      `/api/workbench/decision/actuals/${id}?projectId=${encodeURIComponent(projectId)}`,
      "DELETE",
    );
    if (!res.ok) {
      setError(res.message ?? "删除失败");
      return;
    }
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info" title="留空 = 未测（不会写成 0）">
        实测数据的意义在于和预测对照。留空的字段会被记为「未采集」而不是 0——
        「没测到」和「实测为零」在偏差分析里是完全相反的结论。
      </Alert>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Field label="年份"><Input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" /></Field>
        <Field label="期间">
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            <option value="0">年度汇总</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={String(i + 1)}>
                {i + 1} 月
              </option>
            ))}
          </select>
        </Field>
        <Field label="购电量（kWh）"><Input value={gridImport} onChange={(e) => setGridImport(e.target.value)} inputMode="decimal" placeholder="留空 = 未测" /></Field>
        <Field label="光伏发电量（kWh）"><Input value={pvGen} onChange={(e) => setPvGen(e.target.value)} inputMode="decimal" placeholder="留空 = 未测" /></Field>
        <Field label="储能放电量（kWh）"><Input value={bessDischarge} onChange={(e) => setBessDischarge(e.target.value)} inputMode="decimal" placeholder="留空 = 未测" /></Field>
        <Field label="交付给车辆的电量（kWh）"><Input value={delivered} onChange={(e) => setDelivered(e.target.value)} inputMode="decimal" placeholder="留空 = 未测" /></Field>
        <Field label="购电成本（元）"><Input value={gridCost} onChange={(e) => setGridCost(e.target.value)} inputMode="decimal" placeholder="留空 = 未测" /></Field>
        <Field label="充电收入（元）"><Input value={revenue} onChange={(e) => setRevenue(e.target.value)} inputMode="decimal" placeholder="留空 = 未测" /></Field>
        <Field label="运维支出（元）"><Input value={opex} onChange={(e) => setOpex(e.target.value)} inputMode="decimal" placeholder="留空 = 未测" /></Field>
        <Field label="备注"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="数据来源说明" /></Field>
      </div>

      {error ? <Alert variant="danger" title="无法保存">{error}</Alert> : null}
      {notice ? <Alert variant="success" title="已保存">{notice}</Alert> : null}

      <div>
        <Button onClick={onSave} disabled={busy}>{busy ? "保存中…" : "保存实测数据"}</Button>
      </div>

      <SimpleTable
        columns={["期间", "购电量", "光伏", "储能放电", "交付量", "购电成本", "收入", "运维", "来源", "备注", "操作"]}
        align={["left", "right", "right", "right", "right", "right", "right", "right", "left", "left", "left"]}
        rows={(rows ?? []).map((r) => [
          `${r.periodYear} 年${r.periodMonth === 0 ? "（年度）" : ` ${r.periodMonth} 月`}`,
          r.gridImportKwh == null ? "未测" : fmtNum(r.gridImportKwh, 1),
          r.pvGenerationKwh == null ? "未测" : fmtNum(r.pvGenerationKwh, 1),
          r.bessDischargeKwh == null ? "未测" : fmtNum(r.bessDischargeKwh, 1),
          r.deliveredKwh == null ? "未测" : fmtNum(r.deliveredKwh, 1),
          r.gridCostYuan == null ? "未测" : fmtNum(r.gridCostYuan, 0),
          r.revenueYuan == null ? "未测" : fmtNum(r.revenueYuan, 0),
          r.opexYuan == null ? "未测" : fmtNum(r.opexYuan, 0),
          SOURCE_LABEL[r.source] ?? r.source,
          r.note ?? "—",
          "删除",
        ])}
      />
      {rows && rows.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {rows.map((r) => (
            <Button key={r.id} size="sm" variant="secondary" onClick={() => onDelete(r.id)}>
              删除 {r.periodYear}
              {r.periodMonth === 0 ? " 年度" : `-${r.periodMonth}`}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
