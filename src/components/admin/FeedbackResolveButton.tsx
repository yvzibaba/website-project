"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 「标记已处理」按钮（Phase 4 模块 C，后台）：POST /api/admin/feedback/[id]/resolve。
 * 受服务端 STAFF 门禁（requireStaffWrite）；数据层幂等。成功后刷新后台列表。
 */
export function FeedbackResolveButton({ feedbackId }: { feedbackId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await mutateJson(
      `/api/admin/feedback/${encodeURIComponent(feedbackId)}/resolve`,
      "POST",
      {},
    );
    setBusy(false);
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError((res.message ?? "操作失败") + (hint ? `：${hint}` : ""));
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex items-center gap-2">
      <Button type="button" size="sm" variant="secondary" onClick={resolve} disabled={busy}>
        {busy ? "处理中…" : "标记已处理"}
      </Button>
      {error ? <span className="text-[11px] text-rose-600">{error}</span> : null}
    </span>
  );
}
