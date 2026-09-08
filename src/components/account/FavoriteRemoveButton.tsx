"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 「移除收藏」按钮（Phase 4 模块 C）：DELETE /api/favorites（幂等），成功后刷新列表页。
 */
export function FavoriteRemoveButton({
  targetType,
  targetId,
}: {
  targetType: "CASE" | "SOLUTION";
  targetId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await mutateJson("/api/favorites", "DELETE", { targetType, targetId });
    setBusy(false);
    if (res.status === 401) {
      setError("需要登录。");
      return;
    }
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError((res.message ?? "移除失败") + (hint ? `：${hint}` : ""));
      return;
    }
    router.refresh();
  }

  return (
    <span className="flex items-center gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={remove} disabled={busy}>
        {busy ? "移除中…" : "移除"}
      </Button>
      {error ? <span className="text-[11px] text-rose-600">{error}</span> : null}
    </span>
  );
}
