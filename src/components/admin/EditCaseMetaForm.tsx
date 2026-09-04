"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Field, Input, Textarea, Alert } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 案例「基本信息」编辑（Phase 13 M5，client）——标题 / 英文名 / 摘要 / 来源 / 行业 / 阶段。
 *
 * 消费 Phase 13 M1 的 `PATCH /api/admin/cases/[id]`：CSRF + requireStaffWrite + 判别联合翻译全在
 * api-guard 一处（宪法第 16 条），本组件只发「变更字段」并如实回显服务端结果；成功后 `router.refresh()`
 * 拉取最新 version/徽章/评分标量（RSC 重取，不手动同步本地 state 防漂移）。与方案侧 EditSolutionMetaForm 同构。
 *
 * 有意为之的边界：
 *   - **不含 scoreInput（10 维度评分录入）**——评分是"程序复算"的高敏感区（黄金样本 + RUBRIC 版本），
 *     其录入 UI 单独留 M5b；这里只改结构化字段（改到 title 等不影响评分）。
 *   - titleEn/summary/summaryEn/sourceUrl/sourceType 允许清空（提交 ""）；title 为空则不提交该字段
 *     （数据层要求标题非空，清空无意义且会被拒）。
 *   - regionId/businessModelId 暂不在此编辑（需额外下拉数据源，V1 简单优先，留后续）。
 */

export interface CaseMeta {
  title: string;
  titleEn: string | null;
  summary: string | null;
  summaryEn: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  industry: string;
  stage: string;
}

interface Option {
  value: string;
  label: string;
}

export function EditCaseMetaForm({
  caseId,
  initial,
  industries,
  stages,
}: {
  caseId: string;
  initial: CaseMeta;
  industries: Option[];
  stages: Option[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const patch: Record<string, unknown> = {};

    const title = String(fd.get("title") ?? "").trim();
    if (title) patch.title = title; // 空标题不提交（数据层要求非空）
    patch.titleEn = String(fd.get("titleEn") ?? "").trim(); // 允许清空
    patch.summary = String(fd.get("summary") ?? "").trim();
    patch.summaryEn = String(fd.get("summaryEn") ?? "").trim();
    patch.sourceUrl = String(fd.get("sourceUrl") ?? "").trim();
    patch.sourceType = String(fd.get("sourceType") ?? "").trim();
    patch.industry = String(fd.get("industry") ?? initial.industry);
    patch.stage = String(fd.get("stage") ?? initial.stage);

    setPending(true);
    setNotice(null);
    setFieldErrors({});
    const res = await mutateJson(`/api/admin/cases/${caseId}`, "PATCH", patch);
    if (res.ok) {
      setNotice({ tone: "success", text: "已保存基本信息" });
      router.refresh();
    } else {
      setFieldErrors(res.fields ?? {});
      const hints = fieldHints(res.fields);
      setNotice({ tone: "danger", text: hints.length ? `保存失败：${hints.join("；")}` : res.message ?? "保存失败" });
    }
    setPending(false);
  }

  const err = (k: string) => fieldErrors[k]?.[0];
  const selectCls =
    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">基本信息</CardTitle>
        <CardDescription>标题与行业必填；证据与评分请在下方对应区块单独维护（本表单不改动评分，避免绕过复算口径）。</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="案例标题" htmlFor="c-title" required error={err("title")}>
            <Input id="c-title" name="title" defaultValue={initial.title} invalid={!!err("title")} required maxLength={300} />
          </Field>
          <Field label="英文名" htmlFor="c-titleEn" error={err("titleEn")}>
            <Input id="c-titleEn" name="titleEn" defaultValue={initial.titleEn ?? ""} maxLength={300} />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="行业" htmlFor="c-industry" required error={err("industry")}>
              <select id="c-industry" name="industry" defaultValue={initial.industry} className={selectCls}>
                {industries.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="阶段" htmlFor="c-stage" help="仅 DEEP_CASE 及以后进入公开橱窗；候选/研究中间态只后台可见。" error={err("stage")}>
              <select id="c-stage" name="stage" defaultValue={initial.stage} className={selectCls}>
                {stages.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="来源链接" htmlFor="c-sourceUrl" error={err("sourceUrl")}>
              <Input id="c-sourceUrl" name="sourceUrl" type="url" defaultValue={initial.sourceUrl ?? ""} maxLength={2000} placeholder="https://…" invalid={!!err("sourceUrl")} />
            </Field>
            <Field label="来源类型" htmlFor="c-sourceType" help="新闻 / 论文 / 年报 / 访谈 / 数据库…" error={err("sourceType")}>
              <Input id="c-sourceType" name="sourceType" defaultValue={initial.sourceType ?? ""} maxLength={100} />
            </Field>
          </div>

          <Field label="摘要" htmlFor="c-summary" help="列表与详情页顶部展示的一段话概述（可留空）。" error={err("summary")}>
            <Textarea id="c-summary" name="summary" defaultValue={initial.summary ?? ""} rows={3} maxLength={5000} />
          </Field>
          <Field label="英文摘要" htmlFor="c-summaryEn" error={err("summaryEn")}>
            <Textarea id="c-summaryEn" name="summaryEn" defaultValue={initial.summaryEn ?? ""} rows={2} maxLength={5000} />
          </Field>

          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" variant="primary" disabled={pending}>
              {pending ? "保存中…" : "保存基本信息"}
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
