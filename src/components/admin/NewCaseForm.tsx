"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea, Field, Alert, Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui";

/**
 * 「新建案例」表单（Phase 13 M2，client）。
 *
 * 为什么走 fetch 到 HTTP 端点、而不是 Server Action 直调数据层：
 *   Phase 13 M1 把后台写门禁（CSRF 同源 + requireRole + 结果翻译）收敛进 `src/server/api-guard.ts`
 *   **唯一一处**（宪法第 16 条：单一真源、防逐入口漂移）。若这里再写一个 Server Action 各自
 *   requireRole + 各自把判别联合翻成 UI 文案，就等于把同一套鉴权/翻译逻辑抄第二遍、必然漂移。
 *   故后台 UI 就**消费那批 `/api/admin/**` 端点**——端点也因此获得真实调用方、而非"造了没人用"。
 *   浏览器对同源 POST 会自动带 `Origin` 头、`SameSite=Lax` 会话 cookie 同源必发，与服务端 CSRF 判定天然吻合。
 *
 * 交互（V1 简单优先，宪法第 4/22 条）：
 *   - 成功后 `router.refresh()` 让服务端列表重取（无需手动 setState 拼列表）；
 *   - 端点回 400 `details.fields` → 逐字段回显（与数据层 Zod 同一口径，UI 不另立校验规则）；
 *   - 401/403/500 → 顶部 Alert 如实报错，绝不假装成功（宪法第 20 条）。
 */

interface Option {
  value: string;
  label: string;
}

interface NewCaseFormProps {
  industries: Option[];
  stages: Option[];
  defaultStage: string;
}

type FieldErrors = Record<string, string[]>;

export function NewCaseForm({ industries, stages, defaultStage }: NewCaseFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setBanner(null);
    setDone(null);
    setFieldErrors({});

    const form = e.currentTarget;
    const fd = new FormData(form);
    const get = (k: string) => (fd.get(k) as string | null)?.trim() ?? "";

    const payload: Record<string, unknown> = {
      title: get("title"),
      industry: get("industry"),
      stage: get("stage"),
    };
    const summary = get("summary");
    const sourceUrl = get("sourceUrl");
    if (summary) payload.summary = summary;
    if (sourceUrl) payload.sourceUrl = sourceUrl;

    try {
      const res = await fetch("/api/admin/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; caseId?: string; error?: { code?: string; message?: string; details?: { fields?: FieldErrors } } }
        | null;

      if (res.ok && json?.ok) {
        form.reset();
        setDone(`已创建案例${json.caseId ? `（id: ${json.caseId}）` : ""}。`);
        router.refresh();
      } else if (res.status === 400 && json?.error?.details?.fields) {
        setFieldErrors(json.error.details.fields);
        setBanner(json.error.message || "请修正表单中的错误字段");
      } else {
        setBanner(json?.error?.message || `创建失败（HTTP ${res.status}）`);
      }
    } catch {
      setBanner("网络错误，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>新建案例</CardTitle>
        <CardDescription>
          录入一条真实案例（候选态起步，后续可加证据/评分）。标题与行业必填；此处只写结构化字段，
          证据与评分建议在案例详情页补充。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {banner ? (
          <Alert variant="danger" title="未能创建">
            {banner}
          </Alert>
        ) : null}
        {done ? (
          <Alert variant="success" title="创建成功">
            {done}
          </Alert>
        ) : null}

        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4" noValidate>
          <Field label="标题" htmlFor="title" required error={fieldErrors.title?.[0]}>
            <Input id="title" name="title" type="text" required maxLength={300} placeholder="例：某地沼气提纯并网项目" invalid={!!fieldErrors.title} />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="行业" htmlFor="industry" required error={fieldErrors.industry?.[0]}>
              <select
                id="industry"
                name="industry"
                required
                defaultValue={industries[0]?.value ?? "OTHER"}
                aria-invalid={!!fieldErrors.industry || undefined}
                className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 ${fieldErrors.industry ? "border-danger focus-visible:outline-danger" : "border-input focus-visible:outline-ring"}`}
              >
                {industries.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="阶段" htmlFor="stage" error={fieldErrors.stage?.[0]}>
              <select
                id="stage"
                name="stage"
                defaultValue={defaultStage}
                aria-invalid={!!fieldErrors.stage || undefined}
                className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 ${fieldErrors.stage ? "border-danger focus-visible:outline-danger" : "border-input focus-visible:outline-ring"}`}
              >
                {stages.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="来源链接（可选）" htmlFor="sourceUrl" error={fieldErrors.sourceUrl?.[0]}>
            <Input id="sourceUrl" name="sourceUrl" type="url" maxLength={2000} placeholder="https://…" invalid={!!fieldErrors.sourceUrl} />
          </Field>

          <Field label="摘要（可选）" htmlFor="summary" error={fieldErrors.summary?.[0]} help="一句话概述案例的商业价值与可复用性，便于列表浏览。">
            <Textarea id="summary" name="summary" rows={3} maxLength={5000} placeholder="这个项目解决了什么问题、跑通了什么模式…" invalid={!!fieldErrors.summary} />
          </Field>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "提交中…" : "创建案例"}
            </Button>
            <span className="text-xs text-muted-foreground">写入前经服务端角色与 CSRF 校验，操作会记入审计流水。</span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
