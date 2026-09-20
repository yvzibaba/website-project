"use client";

/**
 * V2 决策平台 · 项目列表与新建（客户端组件）。
 *
 * 关键约定：
 *   - 本组件**不做任何计算**。新建时它先向服务端要一份情景输入骨架（`/templates?fee=`），
 *     再把骨架原样提交（`POST /projects`），服务端现算落库。因此页面上看到的默认参数
 *     与服务端实际使用的完全同源，不存在"前端拼一份、后端又拼一份"的漂移。
 *   - 服务费是**必填**：它是市场调节价，没有可依据的默认值，故不预填、不猜。
 *   - 载入失败诚实展示（401 跳登录，其余显示提示条），绝不把失败画成"暂无数据"。
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { mutateJson } from "@/components/admin/mutate";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@/components/ui";
import { CalcStatusBadge, fmtMoneyShort, fmtPct, fmtYears } from "./primitives";

interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  scenarioCount: number;
  baseline: {
    id: string;
    name: string;
    calcStatus: string;
    npvYuan: number | null;
    irrPct: number | null;
    paybackYears: number | null;
    lcoeYuanPerKwh: number | null;
    capexNetYuan: number | null;
  } | null;
}

interface TemplateInfo {
  id: string;
  label: string;
  components: string[];
  managedCharging: boolean;
  intent: string;
}

const COMPONENT_LABEL: Record<string, string> = {
  PV: "光伏",
  BESS: "储能",
  GRID: "电网",
  CHARGING: "充电",
  SWAP: "换电",
  TOU: "分时电价",
  DEMAND_CHARGE: "需量电费",
};

export function DecisionProjectsPanel() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fee, setFee] = useState("");
  const [templateId, setTemplateId] = useState("pv-bess-tou");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 只在**事件处理器**里调用（effect 的首屏加载走下面的内联请求）。 */
  const reload = useCallback(async () => {
    const res = await mutateJson("/api/workbench/decision/projects", "GET");
    if (!res.ok) {
      setProjects([]);
      setLoadError(res.message ?? "项目列表载入失败");
      return;
    }
    setProjects(((res.data ?? {}).projects as ProjectSummary[]) ?? []);
  }, []);

  /**
   * 首屏加载。刻意**不**在 effect 体内同步 setState（本项目 lint 明令禁止，会引发级联渲染），
   * 所有状态更新都发生在 promise 回调里；首屏「载入中」由 `projects === null` 兜住。
   */
  useEffect(() => {
    let alive = true;
    mutateJson("/api/workbench/decision/projects", "GET").then((res) => {
      if (!alive) return;
      if (!res.ok) {
        if (res.status === 401) {
          router.push(`/login?callbackUrl=${encodeURIComponent("/workbench/projects")}`);
          return;
        }
        setProjects([]);
        setLoadError(res.message ?? "项目列表载入失败");
        return;
      }
      setProjects(((res.data ?? {}).projects as ProjectSummary[]) ?? []);
    });
    // 只取模板目录（不传 fee → 服务器不回骨架），用于渲染选项
    mutateJson("/api/workbench/decision/templates", "GET").then((res) => {
      if (!alive) return;
      if (res.ok) setTemplates(((res.data ?? {}).templates as TemplateInfo[]) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [router]);

  async function onCreate() {
    setFormError(null);
    setNotice(null);

    const feeNum = Number(fee);
    if (!name.trim()) {
      setFormError("请填写项目名称");
      return;
    }
    if (!Number.isFinite(feeNum) || feeNum < 0) {
      setFormError("请填写充电服务费（元/kWh，市场调节价，必须显式给出）");
      return;
    }

    setBusy(true);
    try {
      // 第一步：向服务端要一份情景输入骨架（保证默认参数由服务端给，而非前端拼）
      const seedRes = await mutateJson(
        `/api/workbench/decision/templates?fee=${encodeURIComponent(String(feeNum))}`,
        "GET",
      );
      if (!seedRes.ok) {
        setFormError(seedRes.message ?? "获取情景模板失败");
        return;
      }
      const seeds = ((seedRes.data ?? {}).seeds ?? {}) as Record<string, unknown>;
      const seed = seeds[templateId];
      if (!seed) {
        setFormError("所选模板没有可用的输入骨架，请换一个模板");
        return;
      }

      // 第二步：带着骨架创建项目，服务端现算落库
      const created = await mutateJson("/api/workbench/decision/projects", "POST", {
        name: name.trim(),
        description: description.trim() || undefined,
        scenarioInput: seed,
      });
      if (!created.ok) {
        setFormError(created.message ?? "创建失败");
        return;
      }
      if ((created.data ?? {}).calcStatus !== "ok") {
        setNotice(
          `项目已保存，但本次计算未通过校验，结论暂不可用。${
            typeof (created.data ?? {}).warning === "string" ? (created.data ?? {}).warning : ""
          }`,
        );
      }
      setName("");
      setDescription("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>新建决策项目</CardTitle>
          <p className="text-sm text-muted-foreground">
            选一个起点情景，服务端会立刻按当前参数算一遍并留档，随后可以在项目里改参数、比方案、出报告。
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="项目名称">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：临泉重卡换电站一期" />
            </Field>
            <Field
              label="充电服务费（元/kWh）"
              help="市场调节价，没有统一标准，请按你的经营策略填写"
            >
              <Input
                value={fee}
                onChange={(e) => setFee(e.target.value)}
                inputMode="decimal"
                placeholder="如 0.45"
              />
            </Field>
          </div>

          <Field label="起点情景">
            <div className="flex flex-col gap-2">
              {templates.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted/40"
                >
                  <input
                    type="radio"
                    name="template"
                    className="mt-1"
                    checked={templateId === t.id}
                    onChange={() => setTemplateId(t.id)}
                  />
                  <span className="flex flex-col gap-1">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.intent}</span>
                    <span className="text-xs text-muted-foreground">
                      组件：
                      {t.components.map((c) => COMPONENT_LABEL[c] ?? c).join(" + ")}
                      {t.managedCharging ? "（有序充电）" : ""}
                    </span>
                  </span>
                </label>
              ))}
              {templates.length === 0 ? (
                <p className="text-sm text-muted-foreground">情景模板载入中…</p>
              ) : null}
            </div>
          </Field>

          <Field label="备注（可选）">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="用途说明" />
          </Field>

          {formError ? <Alert variant="danger" title="无法创建">{formError}</Alert> : null}
          {notice ? <Alert variant="warning" title="已保存，但结论不可用">{notice}</Alert> : null}

          <div>
            <Button onClick={onCreate} disabled={busy}>
              {busy ? "正在计算并保存…" : "创建项目"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">我的项目</h2>
        {loadError ? (
          <Alert variant="danger" title="载入失败">
            {loadError}
          </Alert>
        ) : null}
        {projects === null ? (
          <p className="text-sm text-muted-foreground">载入中…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有项目。在上面填好名称与服务费即可创建第一个。</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <Card key={p.id} interactive>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    <CalcStatusBadge status={p.baseline?.calcStatus} />
                  </div>
                  {p.description ? <p className="text-sm text-muted-foreground">{p.description}</p> : null}
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">净现值</dt>
                      <dd className="tabular-nums">{fmtMoneyShort(p.baseline?.npvYuan)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">内部收益率</dt>
                      <dd className="tabular-nums">{fmtPct(p.baseline?.irrPct)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">投资</dt>
                      <dd className="tabular-nums">{fmtMoneyShort(p.baseline?.capexNetYuan)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">回收期</dt>
                      <dd className="tabular-nums">{fmtYears(p.baseline?.paybackYears)}</dd>
                    </div>
                  </dl>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      共 {p.scenarioCount} 个情景 · 最近更新 {new Date(p.updatedAt).toLocaleString("zh-CN")}
                    </span>
                    <Button size="sm" onClick={() => router.push(`/workbench/projects/${p.id}`)}>
                      打开
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
