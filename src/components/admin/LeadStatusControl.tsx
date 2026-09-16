"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { mutateJson, fieldHints } from "@/components/admin/mutate";
import type { LeadStatus } from "@/server/leads";

/**
 * 后台「留资跟进状态」切换控件（V1.1 P6 · 补 P4 尾巴：updateLeadStatus 的数据层早已就绪，
 * 这里接上唯一的人工回写入口）。POST /api/admin/leads/[id]/status（服务端 STAFF 门禁 + CSRF）。
 *
 * 交互：三段小按钮（待处理 / 已联系 / 已归档），当前状态高亮且不可点，点其它即回写并刷新列表。
 * 数据层幂等（同状态重复标记只刷 updatedAt）。失败就地显示错误、绝不假装成功。
 */
const OPTIONS: Array<{ value: LeadStatus; label: string }> = [
  { value: "NEW", label: "待处理" },
  { value: "CONTACTED", label: "已联系" },
  { value: "CLOSED", label: "已归档" },
];

export function LeadStatusControl({ leadId, current }: { leadId: string; current: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<LeadStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(next: LeadStatus) {
    if (busy || next === current) return;
    setBusy(next);
    setError(null);
    const res = await mutateJson(
      `/api/admin/leads/${encodeURIComponent(leadId)}/status`,
      "POST",
      { status: next },
    );
    setBusy(null);
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError((res.message ?? "操作失败") + (hint ? `：${hint}` : ""));
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="inline-flex items-center gap-1 rounded-full border border-border p-0.5">
        {OPTIONS.map((o) => {
          const active = o.value === current;
          return (
            <button
              key={o.value}
              type="button"
              disabled={active || busy !== null}
              onClick={() => setStatus(o.value)}
              aria-pressed={active}
              className={
                "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-default " +
                (active
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-600 hover:bg-zinc-100 disabled:opacity-50")
              }
            >
              {busy === o.value ? "…" : o.label}
            </button>
          );
        })}
      </span>
      {error ? <span className="text-[11px] text-rose-600">{error}</span> : null}
    </span>
  );
}
