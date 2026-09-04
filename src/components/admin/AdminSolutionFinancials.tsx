"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Field, Input, Textarea, Alert, Badge } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";
import type { AdminSolutionFinancialDetail } from "@/server/admin-solutions";

/**
 * 财务测算「增删」编辑台（Phase 13 M4，client）——CAPEX/OPEX/收入/ROI/IRR/回收期 + 假设溯源。
 *
 * 消费 Phase 13 M1 端点：新增 `POST /api/admin/solutions/[id]/financial`、删除
 * `DELETE /api/admin/solutions/[id]/financial/[financialId]`。金额一律以**字符串**提交，
 * 交服务端 Prisma Decimal 落库（宪法第 7 条：程序计算 > JS 浮点口算，这里杜绝前端浮点污染）。
 *
 * 有意为之：V1 只建/删条目、不做前端 ROI/IRR 复算——公式属 Phase 8 M4 评分内核增量（SCORING §5），
 * 此处录入的是"人给的可复算输入 + calcRef 溯源"，不是自动生成结论。
 */

const NUMERIC_FIELDS: Array<{ key: keyof AdminSolutionFinancialDetail; label: string; help?: string }> = [
  { key: "capex", label: "CAPEX（一次性投资）" },
  { key: "opexAnnual", label: "年 OPEX" },
  { key: "revenueAnnual", label: "年收入" },
  { key: "roiPct", label: "ROI %", help: "如 42.5，不填则留空" },
  { key: "irrPct", label: "IRR %" },
  { key: "paybackYears", label: "回收期（年）" },
];

const CURRENCIES = [
  { value: "CNY", label: "人民币 CNY" },
  { value: "USD", label: "美元 USD" },
];

export function AdminSolutionFinancials({
  solutionId,
  items,
}: {
  solutionId: string;
  items: AdminSolutionFinancialDetail[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload: Record<string, unknown> = {};
    for (const f of NUMERIC_FIELDS) {
      const v = String(fd.get(f.key) ?? "").trim();
      if (v) payload[f.key] = v; // 空值不提交（DecimalStringSchema 拒空串）
    }
    if (Object.keys(payload).length === 0) {
      setNotice({ tone: "danger", text: "至少填写一项数字（CAPEX/OPEX/收入/ROI/IRR/回收期）再新增" });
      return;
    }
    payload.currency = String(fd.get("currency") ?? "CNY");
    const note = String(fd.get("note") ?? "").trim();
    if (note) payload.note = note;
    const calcRef = String(fd.get("calcRef") ?? "").trim();
    if (calcRef) payload.calcRef = calcRef;
    const sourceUrl = String(fd.get("sourceUrl") ?? "").trim();
    if (sourceUrl) payload.sourceUrl = sourceUrl;

    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/solutions/${solutionId}/financial`, "POST", payload);
    if (res.ok) {
      setNotice({ tone: "success", text: "已新增一条财务测算" });
      router.refresh();
    } else {
      const hints = fieldHints(res.fields);
      setNotice({ tone: "danger", text: hints.length ? `新增失败：${hints.join("；")}` : res.message ?? "新增失败" });
    }
    (e.target as HTMLFormElement).reset();
    setPending(false);
  }

  async function remove(id: string) {
    if (!confirm("确认删除这条财务测算？")) return;
    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/solutions/${solutionId}/financial/${id}`, "DELETE");
    if (res.ok) {
      setNotice({ tone: "success", text: "已删除财务测算" });
      router.refresh();
    } else {
      setNotice({ tone: "danger", text: res.message ?? "删除失败" });
    }
    setPending(false);
  }

  const fmt = (v: string | null) => (v === null ? "—" : v);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">财务测算</CardTitle>
            <CardDescription>可复算的关键数字与假设溯源。金额用字符串录入、服务端 Decimal 落库，避免浮点污染。</CardDescription>
          </div>
          <Badge variant="neutral" className="shrink-0 tabular-nums">{items.length} 条</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有财务测算，用下方表单新增第一条。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                  {NUMERIC_FIELDS.map((nf) => {
                    const v = f[nf.key] as string | null;
                    if (v === null) return null;
                    return (
                      <span key={nf.key} className="text-muted-foreground">
                        {nf.label.replace(/（.*）/, "")} <span className="font-medium text-foreground">{fmt(v)}</span>
                      </span>
                    );
                  })}
                  <span className="text-muted-foreground">币种 <span className="font-medium text-foreground">{f.currency}</span></span>
                  {f.calcRef ? <span className="text-muted-foreground">算法 <span className="font-medium text-foreground">{f.calcRef}</span></span> : null}
                  {f.sourceUrl ? (
                    <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">来源</a>
                  ) : null}
                </div>
                <Button size="sm" variant="danger" disabled={pending} onClick={() => remove(f.id)}>
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-md border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {NUMERIC_FIELDS.map((nf) => (
              <Field key={nf.key} label={nf.label} htmlFor={`fin-${nf.key}`} help={nf.help}>
                <Input id={`fin-${nf.key}`} name={nf.key as string} inputMode="decimal" placeholder="留空即不填" />
              </Field>
            ))}
          </div>
          <Field label="备注 / 假设" htmlFor="fin-note" help="支撑这些数字的关键假设（可复算的前提）。">
            <Textarea id="fin-note" name="note" rows={2} maxLength={2000} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="币种" htmlFor="fin-currency">
              <select id="fin-currency" name="currency" defaultValue="CNY" className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                {CURRENCIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="算法引用 calcRef" htmlFor="fin-calcRef" help="公式/口径出处，便于复算。">
              <Input id="fin-calcRef" name="calcRef" maxLength={500} />
            </Field>
            <Field label="来源 URL" htmlFor="fin-sourceUrl">
              <Input id="fin-sourceUrl" name="sourceUrl" inputMode="url" maxLength={2000} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" variant="primary" disabled={pending}>
              {pending ? "处理中…" : "新增财务测算"}
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
