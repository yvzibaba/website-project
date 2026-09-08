"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 「收藏」按钮（Phase 4 模块 C）：POST/DELETE /api/favorites（幂等）。
 * initialFavorited 由服务端详情页渲染传入（登录者的真实收藏态），游客点按提示登录——
 * 绝不把登录态判断交给客户端猜测。成功后 router.refresh() 同步服务端状态（如收藏列表页）。
 */
export function FavoriteButton({
  targetType,
  targetId,
  initialFavorited,
}: {
  targetType: "CASE" | "SOLUTION";
  targetId: string;
  initialFavorited: boolean;
}) {
  const router = useRouter();
  const [favorited, setFavorited] = useState(initialFavorited);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const next = !favorited;
    const res = await mutateJson("/api/favorites", next ? "POST" : "DELETE", { targetType, targetId });
    setBusy(false);
    if (res.status === 401) {
      setError("收藏需要先登录。");
      return;
    }
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError((res.message ?? "操作失败") + (hint ? `：${hint}` : ""));
      return;
    }
    // 以服务端返回为准（幂等语义：ok.favorited），不本地臆测。
    const data = (res.data ?? {}) as { favorited?: boolean };
    setFavorited(Boolean(data.favorited ?? next));
    router.refresh();
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant={favorited ? "secondary" : "ghost"} onClick={toggle} disabled={busy}>
        {busy ? "处理中…" : favorited ? "★ 已收藏" : "☆ 收藏"}
      </Button>
      {error ? <span className="text-[11px] text-rose-600">{error}</span> : null}
    </span>
  );
}
