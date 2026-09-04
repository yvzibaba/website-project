"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea, Field, Alert, Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui";

/**
 * 「新建方案」表单（Phase 13 M3，client）——补齐「方案从录入到可售」链路的后台录入入口。
 *
 * 为什么走 fetch 到 HTTP 端点、而不是 Server Action 直调数据层：
 *   Phase 13 M1 把后台写门禁（CSRF 同源 + requireRole + 判别联合翻译）收敛进 `src/server/api-guard.ts`
 *   **唯一一处**（宪法第 16 条单一真源）。这里再写 Server Action 就等于把同一套鉴权/翻译抄第二遍、必然漂移。
 *   故后台 UI 直接**消费 `/api/admin/solutions` 端点**（数据层强制 status=DRAFT，发布另走 PublishSolutionButton）。
 *
 * 交互（V1 简单优先，宪法第 4/22 条）：
 *   - 成功后 `router.refresh()` 让服务端列表重取（新方案以 DRAFT 态出现在列表，可随后发布）；
 *   - 端点回 400 `details.fields` → 逐字段回显（与数据层 Zod 同口径，UI 不另立校验）；
 *   - 401/403/500 → 顶部 Alert 如实报错，绝不假装成功（宪法第 20 条）。
 *
 * 刻意不含 body（34 分节结构化正文）与财务/未知变量的录入——那些是逐条子资源的增删，
 * 属后台详情页范畴（留 M4）；此处只建「方案骨架 + 定价」，让闭环能跑通到「可售」。
 */

interface Option {
  value: string;
  label: string;
}

interface NewSolutionFormProps {
  /** 现有案例（id + 可读标题），供选择方案挂靠的真实案例。 */
  cases: Option[];
  currencies: Option[];
}

type FieldErrors = Record<string, string[]>;

export function NewSolutionForm({ cases, currencies }: NewSolutionFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const noCase = cases.length === 0;

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
      slug: get("slug"),
      caseId: get("caseId"),
    };
    const titleEn = get("titleEn");
    const summary = get("summary");
    const price = get("price");
    const currency = get("currency");
    const riskRaw = get("riskDomains");
    if (titleEn) payload.titleEn = titleEn;
    if (summary) payload.summary = summary;
    if (price) payload.price = price;
    if (currency) payload.currency = currency;
    const riskDomains = riskRaw
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (riskDomains.length) payload.riskDomains = riskDomains;
    payload.needsProfessionalReview = fd.get("needsProfessionalReview") === "on";

    try {
      const res = await fetch("/api/admin/solutions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; solutionId?: string; error?: { code?: string; message?: string; details?: { fields?: FieldErrors } } }
        | null;

      if (res.ok && json?.ok) {
        form.reset();
        setDone(`已创建方案（草稿）${json.solutionId ? `（id: ${json.solutionId}）` : ""}。可在列表中「发布」后对外可售。`);
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
        <CardTitle>新建方案</CardTitle>
        <CardDescription>
          录入一条方案的骨架与定价（草稿态起步，标题 / slug / 挂靠案例必填）。发布前须补价格；
          若涉及高风险领域，发布时会被要求勾选「需要专业人工确认」（宪法第 21 条）。
          正文 34 分节、财务测算、关键未知变量的录入留后台详情页（M4）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {noCase ? (
          <Alert variant="warning" title="还没有可挂靠的案例">
            方案必须挂在一个真实案例下。请先到{" "}
            <Link href="/admin/cases" className="mx-1 underline">
              「案例管理」
            </Link>{" "}
            录入案例，再回来创建方案。
          </Alert>
        ) : null}

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
            <Input id="title" name="title" type="text" required maxLength={300} placeholder="例：县域沼气提纯并网整体解决方案" invalid={!!fieldErrors.title} />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Slug（URL 标识）" htmlFor="slug" required error={fieldErrors.slug?.[0]} help="小写字母/数字/连字符，全站唯一，用于方案链接。">
              <Input id="slug" name="slug" type="text" required maxLength={160} placeholder="example-solution-slug" invalid={!!fieldErrors.slug} />
            </Field>

            <Field label="挂靠案例" htmlFor="caseId" required error={fieldErrors.caseId?.[0]}>
              <select
                id="caseId"
                name="caseId"
                required
                defaultValue={cases[0]?.value ?? ""}
                aria-invalid={!!fieldErrors.caseId || undefined}
                className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 ${fieldErrors.caseId ? "border-danger focus-visible:outline-danger" : "border-input focus-visible:outline-ring"}`}
              >
                {cases.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="价格（可选，发布前必填）" htmlFor="price" error={fieldErrors.price?.[0]} help="十进制数字，不含货币符号；留空=未定价（草稿可留空，发布会被拦）。">
              <Input id="price" name="price" type="text" inputMode="decimal" maxLength={20} placeholder="1999.00" invalid={!!fieldErrors.price} />
            </Field>

            <Field label="币种" htmlFor="currency" error={fieldErrors.currency?.[0]}>
              <select
                id="currency"
                name="currency"
                defaultValue={currencies[0]?.value ?? "CNY"}
                aria-invalid={!!fieldErrors.currency || undefined}
                className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 ${fieldErrors.currency ? "border-danger focus-visible:outline-danger" : "border-input focus-visible:outline-ring"}`}
              >
                {currencies.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="英文名（可选）" htmlFor="titleEn" error={fieldErrors.titleEn?.[0]}>
            <Input id="titleEn" name="titleEn" type="text" maxLength={300} placeholder="English title (optional)" invalid={!!fieldErrors.titleEn} />
          </Field>

          <Field
            label="高风险领域（可选，逗号或换行分隔）"
            htmlFor="riskDomains"
            error={fieldErrors.riskDomains?.[0]}
            help="如：法律、投资、工程安全、环保、医疗等。填写后发布会被要求勾选「需要专业人工确认」。"
          >
            <Input id="riskDomains" name="riskDomains" type="text" maxLength={500} placeholder="法律、环保" invalid={!!fieldErrors.riskDomains} />
          </Field>

          <Field label="摘要（可选）" htmlFor="summary" error={fieldErrors.summary?.[0]} help="一句话概述方案解决的问题与商业价值，便于列表与详情页顶部展示。">
            <Textarea id="summary" name="summary" rows={3} maxLength={5000} placeholder="面向什么企业、解决什么问题、跑通什么模式…" invalid={!!fieldErrors.summary} />
          </Field>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="needsProfessionalReview" className="mt-1 h-4 w-4 rounded border-input" />
            <span>
              本方案涉及需专业人工确认的高风险领域
              <span className="block text-xs text-muted-foreground">勾选后作为发布守卫前置条件（涉及高风险领域而未勾选将被拒绝发布，宪法第 21 条）。</span>
            </span>
          </label>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending || noCase}>
              {pending ? "提交中…" : "创建方案（草稿）"}
            </Button>
            <span className="text-xs text-muted-foreground">写入前经服务端角色与 CSRF 校验，操作会记入审计流水。</span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
