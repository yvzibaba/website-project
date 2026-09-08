"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 「复制项目」按钮（Phase 4 模块 B）：POST /api/sandbox/projects/[id]/copy → 服务端按源项目
 * 基线参数**现算重跑**落一个新项目（绝不搬旧数字），成功后刷新列表页让副本出现在最上方。
 */
export function ProjectCopyButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await mutateJson(
      `/api/sandbox/projects/${encodeURIComponent(projectId)}/copy`,
      "POST",
      {},
    );
    setBusy(false);
    if (res.status === 401) {
      setError("复制项目需要登录。");
      return;
    }
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError((res.message ?? "复制失败") + (hint ? `：${hint}` : ""));
      return;
    }
    const data = (res.data ?? {}) as { name?: string };
    setNotice(data.name ? `已复制为「${data.name}」` : "已复制");
    router.refresh();
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={copy} disabled={busy}>
        {busy ? "复制中…" : "复制"}
      </Button>
      {notice ? <span className="text-[11px] text-emerald-700">{notice}</span> : null}
      {error ? <span className="text-[11px] text-rose-600">{error}</span> : null}
    </span>
  );
}
