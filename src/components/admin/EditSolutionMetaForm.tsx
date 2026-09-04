"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Field, Input, Textarea, Alert } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 方案「基本信息」编辑（Phase 13 M4，client）——标题 / 英文名 / 摘要 / 定价 / 币种 / 高风险领域 / 专业确认。
 *
 * 消费 Phase 13 M1 的 `PATCH /api/admin/solutions/[id]`：CSRF + requireStaffWrite + 判别联合翻译
 * 全在 api-guard 一处（宪法第 16 条），本组件只发「变更字段」并如实回显服务端结果。
 *
 * 有意为之的边界：
 *   - **不含 status**——发布是独立的高风险动作，交由 `PublishSolutionButton` 走数据层 publishGuard，
 *     避免这里"顺手"把未定价/未确认的草稿改状态绕过守卫。
 *   - **price 为空则不提交该字段**（数据层 DecimalStringSchema 不接受空串；清价属"改价"增量，V1 不做，
 *     避免一次 PATCH 把已发布方案的价格改没引发退款问题）。
 *   - 保存成功后 `router.refresh()` 拉取最新 version/徽章（RSC 重取，不手动同步本地 state 防漂移）。
 */

export interface SolutionMeta {
  title: string;
  titleEn: string | null;
  summary: string | null;
  price: string | null;
  currency: string;
  riskDomains: string[];
  needsProfessionalReview: boolean;
}

const CURRENCIES = [
  { value: "CNY", label: "人民币 CNY" },
  { value: "USD", label: "美元 USD" },
];

export function EditSolutionMetaForm({ solutionId, initial, status }: { solutionId: string; initial: SolutionMeta; status: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const patch: Record<string, unknown> = {};

    const title = String(fd.get("title") ?? "").trim();
    if (title) patch.title = title;
    const titleEn = String(fd.get("titleEn") ?? "").trim();
    patch.titleEn = titleEn; // 允许清空（→ ""），update 会写入
    const summary = String(fd.get("summary") ?? "").trim();
    patch.summary = summary;
    const price = String(fd.get("price") ?? "").trim();
    if (price) patch.price = price; // 空价不提交（见上注释）
    patch.currency = String(fd.get("currency") ?? "CNY");
    const risk = String(fd.get("riskDomains") ?? "")
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    patch.riskDomains = risk;
    patch.needsProfessionalReview = fd.get("needsProfessionalReview") === "on";

    setPending(true);
    setNotice(null);
    setFieldErrors({});
    const res = await mutateJson(`/api/admin/solutions/${solutionId}`, "PATCH", patch);
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">基本信息</CardTitle>
        <CardDescription>
          当前状态：<span className="font-medium">{status === "PUBLISHED" ? "已发布" : status === "UNDER_HUMAN_REVIEW" ? "人工审核中" : "草稿"}</span>
          。价格与高风险领域影响能否发布（发布走右侧独立按钮、由服务端守卫把关）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="方案标题" htmlFor="m-title" required error={err("title")}>
            <Input id="m-title" name="title" defaultValue={initial.title} invalid={!!err("title")} required maxLength={300} />
          </Field>
          <Field label="英文名" htmlFor="m-titleEn" error={err("titleEn")}>
            <Input id="m-titleEn" name="titleEn" defaultValue={initial.titleEn ?? ""} maxLength={300} />
          </Field>
          <Field label="摘要" htmlFor="m-summary" help="列表与详情页顶部展示的一段话概述（可留空）。" error={err("summary")}>
            <Textarea id="m-summary" name="summary" defaultValue={initial.summary ?? ""} rows={3} maxLength={5000} />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="价格" htmlFor="m-price" help="十进制数字，最多 6 位小数；留空表示暂不定价（草稿）。" error={err("price")}>
              <Input id="m-price" name="price" defaultValue={initial.price ?? ""} inputMode="decimal" placeholder="例如 2999.00" />
            </Field>
            <Field label="币种" htmlFor="m-currency" error={err("currency")}>
              <select
                id="m-currency"
                name="currency"
                defaultValue={initial.currency}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
              >
                {CURRENCIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field
            label="高风险领域"
            htmlFor="m-risk"
            help="用逗号分隔，如：法律、金融、环保。涉及任一高风险领域时，发布前必须勾选下方「需要专业人工确认」（宪法第 21 条）。"
            error={err("riskDomains")}
          >
            <Input id="m-risk" name="riskDomains" defaultValue={initial.riskDomains.join("，")} placeholder="法律，金融，环保" />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="needsProfessionalReview" defaultChecked={initial.needsProfessionalReview} className="h-4 w-4 rounded border-input" />
            需要专业人工确认
          </label>
          {err("needsProfessionalReview") ? <p className="text-xs text-danger">{err("needsProfessionalReview")}</p> : null}

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
