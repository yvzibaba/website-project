"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Field, Input, Textarea, Alert, Badge } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";
import type { AdminCaseEvidenceDetail } from "@/server/admin-cases";

/**
 * 证据「增删」编辑台（Phase 13 M5，client）——案例拆解的核心：逐条录入结论 + 类型 + 来源 + 可信度。
 *
 * 规则 6：严格区分 事实/假设/推断/预测；规则 7：关键数字须来源可追溯 + 置信度。消费
 * `POST /api/admin/cases/[id]/evidence` 与 `DELETE .../evidence/[evidenceId]`（Phase 13 M1 端点）。
 * 二者在数据层内**联动 recompute 证据可信度**，故保存后 `router.refresh()` 让服务端标量（evidenceConfidence）
 * 与计数重取——本组件不自行改评分、不手动维护列表（防漂移，第 16/7 条）。
 *
 * type/grade 选项在此内联为常量（值即枚举字面量），合法性由数据层 `CaseEvidenceInputSchema` 裁决；
 * UI 侧仅做「置信度 0–100 整数」的即时提示，不另立校验口径。
 */

const TYPES = [
  { value: "FACT", label: "事实 FACT" },
  { value: "ASSUMPTION", label: "假设 ASSUMPTION" },
  { value: "INFERENCE", label: "推断 INFERENCE" },
  { value: "PREDICTION", label: "预测 PREDICTION" },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));
const TYPE_VARIANT: Record<string, "success" | "info" | "warning" | "neutral"> = {
  FACT: "success",
  ASSUMPTION: "info",
  INFERENCE: "warning",
  PREDICTION: "warning",
};

const GRADES = [
  { value: "", label: "（未分级）" },
  { value: "S", label: "S · 政府/法规/原始论文/审计" },
  { value: "A", label: "A · 权威机构/上市公司年报/专业库" },
  { value: "B", label: "B · 行业媒体/行业报告" },
  { value: "C", label: "C · 普通二手资料" },
  { value: "D", label: "D · AI 推断（须标待验证）" },
];

export function AdminCaseEvidences({ caseId, items }: { caseId: string; items: AdminCaseEvidenceDetail[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const statement = String(fd.get("statement") ?? "").trim();
    if (!statement) {
      setNotice({ tone: "danger", text: "证据陈述不能为空" });
      return;
    }
    const payload: Record<string, unknown> = {
      type: String(fd.get("type") ?? "FACT"),
      statement,
    };
    const grade = String(fd.get("grade") ?? "").trim();
    if (grade) payload.grade = grade;
    const sourceUrl = String(fd.get("sourceUrl") ?? "").trim();
    if (sourceUrl) payload.sourceUrl = sourceUrl;
    const sourceType = String(fd.get("sourceType") ?? "").trim();
    if (sourceType) payload.sourceType = sourceType;
    const confRaw = String(fd.get("confidence") ?? "").trim();
    if (confRaw) {
      const conf = Number(confRaw);
      if (!Number.isInteger(conf) || conf < 0 || conf > 100) {
        setNotice({ tone: "danger", text: "置信度须为 0–100 的整数" });
        return;
      }
      payload.confidence = conf;
    }

    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/cases/${caseId}/evidence`, "POST", payload);
    if (res.ok) {
      setNotice({ tone: "success", text: "已新增证据（可信度已联动复算）" });
      router.refresh();
    } else {
      const hints = fieldHints(res.fields);
      setNotice({ tone: "danger", text: hints.length ? `新增失败：${hints.join("；")}` : res.message ?? "新增失败" });
    }
    (e.target as HTMLFormElement).reset();
    setPending(false);
  }

  async function remove(id: string) {
    if (!confirm("确认删除这条证据？删除后会重新计算证据可信度。")) return;
    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/cases/${caseId}/evidence/${id}`, "DELETE");
    if (res.ok) {
      setNotice({ tone: "success", text: "已删除（可信度已联动复算）" });
      router.refresh();
    } else {
      setNotice({ tone: "danger", text: res.message ?? "删除失败" });
    }
    setPending(false);
  }

  const selectCls =
    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">证据（案例拆解）</CardTitle>
            <CardDescription>逐条列出支撑结论的证据，区分事实 / 假设 / 推断 / 预测，并标注来源与置信度（规则 6/7）。</CardDescription>
          </div>
          <Badge variant="neutral" className="shrink-0 tabular-nums">{items.length} 条</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有证据。可信度取决于证据的类型与置信度——用下方表单逐条补充。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((ev) => (
              <div key={ev.id} className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={TYPE_VARIANT[ev.type] ?? "neutral"}>{TYPE_LABEL[ev.type] ?? ev.type}</Badge>
                    {ev.grade ? <Badge variant="neutral">来源 {ev.grade}</Badge> : null}
                    {ev.confidence !== null ? <span className="text-xs text-muted-foreground tabular-nums">{`置信度 ${ev.confidence}/100`}</span> : null}
                  </div>
                  <span>{ev.statement}</span>
                  {ev.sourceUrl ? (
                    <a href={ev.sourceUrl} target="_blank" rel="noopener noreferrer" className="truncate text-xs text-info underline">
                      {ev.sourceUrl}
                    </a>
                  ) : null}
                  {ev.sourceType ? <span className="text-xs text-muted-foreground">来源类型：{ev.sourceType}</span> : null}
                </div>
                <Button size="sm" variant="danger" disabled={pending} onClick={() => remove(ev.id)}>
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-md border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.4fr_1.6fr_1fr]">
            <Field label="类型" htmlFor="ev-type" required>
              <select id="ev-type" name="type" defaultValue="FACT" className={selectCls}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="来源等级（可选）" htmlFor="ev-grade">
              <select id="ev-grade" name="grade" defaultValue="" className={selectCls}>
                {GRADES.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="置信度（0–100）" htmlFor="ev-confidence">
              <Input id="ev-confidence" name="confidence" inputMode="numeric" placeholder="可留空" maxLength={3} />
            </Field>
          </div>
          <Field label="证据陈述" htmlFor="ev-statement" required>
            <Textarea id="ev-statement" name="statement" rows={2} maxLength={2000} placeholder="例：该项目 2024 年实测度电成本 0.42 元（来源：企业披露年报 P37）" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="来源链接" htmlFor="ev-sourceUrl">
              <Input id="ev-sourceUrl" name="sourceUrl" type="url" maxLength={2000} placeholder="https://…" />
            </Field>
            <Field label="来源类型" htmlFor="ev-sourceType">
              <Input id="ev-sourceType" name="sourceType" maxLength={100} placeholder="年报 / 论文 / 访谈…" />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" variant="primary" disabled={pending}>
              {pending ? "处理中…" : "新增证据"}
            </Button>
            {notice ? (
              <Alert variant={notice.tone} className="flex-1 py-2">
                {notice.text}
              </Alert>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
