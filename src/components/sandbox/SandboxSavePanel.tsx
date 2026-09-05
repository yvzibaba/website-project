/**
 * 沙盘「项目保存 / 版本 / 回滚」面板（中途重构 R6.3 · §14 优先级第 2 项「项目模型」落到 /sandbox）。
 *
 * 职责边界（诚实）：本组件**只搬运输入、绝不本地算数**——把工作台当前的参数分层（含 `now` 与政策日期窗）
 * 原样 POST 给受登录 + owner 门禁的服务端，由 `sandbox-store` **重跑引擎**落库快照与 Decimal 汇总列（§4 命脉）。
 * 因此「保存后再打开」得到的数字，与页面上此刻看到的逐位一致（R6.3 修好了回放时政策窗口被判成 epoch-0 / 字符串
 * 的隐患）。所有结论仍「需专业人工确认」（§16）。回滚只改**服务端**情景当前态；把版本参数重新载入可视化编辑器
 * 属后续增强（见面板内提示），本面板不假装同步前端滑块。
 */

"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

interface ScenarioView {
  id: string;
  name: string;
  isBaseline: boolean;
  version: number;
  calcStatus: string;
  npv: number | null;
}

interface VersionRow {
  id: string;
  seq: number;
  label: string | null;
  note: string | null;
  savedBy: string | null;
  createdAt: string;
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 万元`;
}

export function SandboxSavePanel({
  layers,
  regionId,
  regionName,
}: {
  /** 工作台当前参数分层（含 now / 政策窗），随请求原样上行；组件不解释其内容。 */
  layers: Record<string, unknown>;
  regionId: string;
  regionName: string;
}) {
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [server, setServer] = useState<{ calcStatus: string; version: number; npv: number | null } | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const report = useCallback((res: Awaited<ReturnType<typeof mutateJson>>, okNotice: string) => {
    if (res.status === 401) {
      setNeedLogin(true);
      setError(res.message ?? "需要登录");
      return false;
    }
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError(res.message ?? "操作失败" + (hint ? `：${hint}` : ""));
      return false;
    }
    setNeedLogin(false);
    setError(null);
    setNotice(okNotice);
    return true;
  }, []);

  async function refreshVersions(sid: string) {
    const res = await mutateJson(`/api/sandbox/scenarios/${sid}/versions`, "GET");
    if (res.ok) setVersions(((res.data as { versions?: VersionRow[] })?.versions) ?? []);
  }

  async function refreshProject(pid: string) {
    const res = await mutateJson(`/api/sandbox/projects/${pid}`, "GET");
    if (res.ok) {
      const p = (res.data as { project?: { scenarios?: ScenarioView[] } })?.project;
      const baseline = p?.scenarios?.find((s) => s.isBaseline) ?? p?.scenarios?.[0] ?? null;
      if (baseline) {
        setServer({ calcStatus: baseline.calcStatus, version: baseline.version, npv: baseline.npv });
      }
    }
  }

  async function createProject() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const res = await mutateJson("/api/sandbox/projects", "POST", {
      name: name.trim() || `${regionName} 沙盘方案`,
      regionId,
      layers,
    });
    setBusy(false);
    if (!report(res, "已保存为项目（服务端已按当前参数重算并落库）")) return;
    const data = (res.data ?? {}) as { projectId?: string; scenarioId?: string };
    if (data.projectId) {
      setProjectId(data.projectId);
      setScenarioId(data.scenarioId ?? null);
      if (data.scenarioId) {
        void refreshVersions(data.scenarioId);
        void refreshProject(data.projectId);
      }
    }
  }

  async function updateScenario() {
    if (!scenarioId || busy) return;
    setBusy(true);
    setNotice(null);
    const res = await mutateJson(`/api/sandbox/scenarios/${scenarioId}`, "PUT", { layers });
    setBusy(false);
    if (!report(res, "已把当前参数保存到该情景（服务端重算、版本 +1）")) return;
    const data = (res.data ?? {}) as { calcStatus?: string; version?: number };
    setServer((prev) => ({
      calcStatus: data.calcStatus ?? prev?.calcStatus ?? "ok",
      version: data.version ?? (prev?.version ?? 0) + 1,
      npv: prev?.npv ?? null,
    }));
    if (projectId) void refreshProject(projectId);
  }

  async function saveVersion() {
    if (!scenarioId || busy) return;
    setBusy(true);
    setNotice(null);
    const res = await mutateJson(`/api/sandbox/scenarios/${scenarioId}/versions`, "POST", {
      label: label.trim() || undefined,
    });
    setBusy(false);
    if (!report(res, "已冻结为一个新的不可变版本")) return;
    setLabel("");
    void refreshVersions(scenarioId);
  }

  async function restoreTo(versionId: string, seq: number) {
    if (!scenarioId || busy) return;
    setBusy(true);
    setNotice(null);
    const res = await mutateJson(`/api/sandbox/scenarios/${scenarioId}/restore`, "POST", { versionId });
    setBusy(false);
    if (!report(res, `已回滚服务端情景到 v${seq}（按该版本参数重跑引擎）`)) return;
    if (projectId) void refreshProject(projectId);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">保存与版本（项目模型 · 服务端重算）</CardTitle>
            <CardDescription>
              把当前地区 / 参数存成可回滚的持久项目：数字全部由服务端引擎按输入**重新算出**（非搬页面值），
              下次打开即与此刻一致。
            </CardDescription>
          </div>
          {server ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Badge variant={server.calcStatus === "ok" ? "success" : "neutral"}>
                {server.calcStatus === "ok" ? "已算入库" : `落库状态：${server.calcStatus}`}
              </Badge>
              {server.version ? <span>情景 v{server.version}</span> : null}
              {server.npv != null ? <span className="tabular-nums">NPV {fmtMoney(server.npv)}</span> : null}
            </div>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[220px] flex-1 flex-col gap-1">
            <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-proj-name">
              项目名称（默认「{regionName} 沙盘方案」）
            </label>
            <Input
              id="sbx-proj-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${regionName} 光储充重卡沙盘`}
              maxLength={200}
              disabled={Boolean(projectId)}
            />
          </div>
          {!projectId ? (
            <Button type="button" size="sm" onClick={createProject} disabled={busy}>
              {busy ? "保存中…" : "保存为项目"}
            </Button>
          ) : (
            <span className="text-[11px] text-zinc-400">项目已建 · id {projectId?.slice(0, 8)}…</span>
          )}
        </div>

        {projectId && scenarioId ? (
          <div className="flex flex-wrap items-end gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={updateScenario} disabled={busy}>
              更新参数到项目
            </Button>
            <div className="flex min-w-[200px] flex-1 flex-col gap-1">
              <label className="text-xs font-medium text-zinc-500" htmlFor="sbx-ver-label">
                版本命名（可选）
              </label>
              <Input
                id="sbx-ver-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例如「电价上调后」"
                maxLength={100}
              />
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={saveVersion} disabled={busy}>
              存为新版本
            </Button>
          </div>
        ) : null}

        {busy ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner className="h-4 w-4" /> 处理中…
          </div>
        ) : null}

        {needLogin ? (
          <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
            保存沙盘项目需要登录。
            <Link href="/login?callbackUrl=%2Fsandbox" className="ml-1 underline">
              前往登录
            </Link>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
        ) : null}

        {notice ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        ) : null}

        {versions.length ? (
          <div className="flex flex-col gap-1">
            <div className="text-xs font-medium text-zinc-500">版本时间线（不可变快照 · 可回滚）</div>
            <ul className="flex flex-col gap-1">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm">
                  <span className="truncate">
                    <span className="font-medium">v{v.seq}</span>
                    {v.label ? <span className="text-zinc-600"> · {v.label}</span> : null}
                    <span className="ml-1 text-[11px] text-zinc-400">{new Date(v.createdAt).toLocaleString("zh-CN")}</span>
                  </span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => restoreTo(v.id, v.seq)} disabled={busy}>
                    回滚到此版本
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-snug text-zinc-400">
              注：「回滚」恢复的是**服务端**情景的参数并重算；把该版本参数重新载入左侧可视化编辑器为后续增强，当前不改动页面上的滑块。
            </p>
          </div>
        ) : null}

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
          落库数字由确定性引擎按输入现算，全部继承「占位假设 + 需专业人工确认」；未核实前不得作为投资 / 并网决策依据。
        </div>
      </CardContent>
    </Card>
  );
}
