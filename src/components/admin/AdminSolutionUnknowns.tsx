"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Field, Input, Textarea, Alert, Badge } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";
import type { AdminSolutionUnknownDetail } from "@/server/admin-solutions";

/**
 * 关键未知变量「增删」编辑台（Phase 13 M4，client）。
 *
 * 规则 6/9：不确定性必须**显式列出**、不能靠综合分掩盖。消费 `POST /api/admin/solutions/[id]/unknown`
 * 与 `DELETE .../unknown/[unknownId]`。`Solution.unknownVariableCount` 由数据层在增删事务里自动回写
 * 实时条数（可计算事实），故此处保存后 `router.refresh()` 即可看到计数与列表同步——不手动改本地 state。
 */

export function AdminSolutionUnknowns({
  solutionId,
  items,
}: {
  solutionId: string;
  items: AdminSolutionUnknownDetail[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get("name") ?? "").trim();
    if (!name) {
      setNotice({ tone: "danger", text: "变量名不能为空" });
      return;
    }
    const payload: Record<string, unknown> = { name };
    const impact = String(fd.get("impact") ?? "").trim();
    if (impact) payload.impact = impact;
    const how = String(fd.get("howToResolve") ?? "").trim();
    if (how) payload.howToResolve = how;
    const sevRaw = String(fd.get("severity") ?? "").trim();
    if (sevRaw) {
      const sev = Number(sevRaw);
      if (!Number.isInteger(sev) || sev < 0 || sev > 100) {
        setNotice({ tone: "danger", text: "严重度须为 0–100 的整数" });
        return;
      }
      payload.severity = sev;
    }

    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/solutions/${solutionId}/unknown`, "POST", payload);
    if (res.ok) {
      setNotice({ tone: "success", text: "已新增关键未知变量" });
      router.refresh();
    } else {
      const hints = fieldHints(res.fields);
      setNotice({ tone: "danger", text: hints.length ? `新增失败：${hints.join("；")}` : res.message ?? "新增失败" });
    }
    (e.target as HTMLFormElement).reset();
    setPending(false);
  }

  async function remove(id: string) {
    if (!confirm("确认删除这条关键未知变量？")) return;
    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/solutions/${solutionId}/unknown/${id}`, "DELETE");
    if (res.ok) {
      setNotice({ tone: "success", text: "已删除" });
      router.refresh();
    } else {
      setNotice({ tone: "danger", text: res.message ?? "删除失败" });
    }
    setPending(false);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">关键未知变量</CardTitle>
            <CardDescription>显式列出会推翻结论的不确定项及其解决路径（规则 6/9）。</CardDescription>
          </div>
          <Badge variant="neutral" className="shrink-0 tabular-nums">{items.length} 条</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有列出未知变量——若方案确有明显不确定性，应如实补上。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((u) => (
              <div key={u.id} className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">
                    {u.name}
                    {u.severity !== null ? <span className="ml-2 text-xs text-muted-foreground tabular-nums">{`严重度 ${u.severity}/100`}</span> : null}
                  </span>
                  {u.impact ? <span className="text-muted-foreground">影响：{u.impact}</span> : null}
                  {u.howToResolve ? <span className="text-muted-foreground">如何消除：{u.howToResolve}</span> : null}
                </div>
                <Button size="sm" variant="danger" disabled={pending} onClick={() => remove(u.id)}>
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-md border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
            <Field label="变量名" htmlFor="unk-name" required>
              <Input id="unk-name" name="name" maxLength={200} placeholder="例如：政策补贴是否延续" />
            </Field>
            <Field label="严重度（0–100）" htmlFor="unk-severity">
              <Input id="unk-severity" name="severity" inputMode="numeric" placeholder="可留空" />
            </Field>
          </div>
          <Field label="影响" htmlFor="unk-impact">
            <Textarea id="unk-impact" name="impact" rows={2} maxLength={2000} />
          </Field>
          <Field label="如何消除 / 验证" htmlFor="unk-how">
            <Textarea id="unk-how" name="howToResolve" rows={2} maxLength={2000} />
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" variant="primary" disabled={pending}>
              {pending ? "处理中…" : "新增未知变量"}
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
