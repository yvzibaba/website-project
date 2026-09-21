"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * R8 后台候选「重跑筛查」按钮——POST /api/admin/candidates/[id]/screen，服务端 `screenAndSave`
 *   复用上次快照 inputs 重跑纯函数 `screenCandidate`（六闸），回写 `screeningResult / status /
 *   version+1`（不新建、不删行，规则 13 版本自增可追溯）。
 *
 * 为什么留这个入口：草料编辑后（如补了证据/参数），需要**主动**刷新裁决——不自动跑是刻意的
 *   （§九 强调"筛选是门槛状态机非评分"，避免每次 read 都跑一次让人无法预测；且省 DB 写入）。
 * 失败诚实：表未 apply 时后端返 409，把 fieldErrors._ 摊平原样回显，不静默不假装。
 */
export function ReScreenButton({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const res = await mutateJson(`/api/admin/candidates/${encodeURIComponent(candidateId)}/screen`, "POST", {});
    setBusy(false);
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setErr((res.message ?? "刷新失败") + (hint ? `：${hint}` : ""));
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={run} disabled={busy}>
        {busy ? "筛查中…" : "重跑筛查"}
      </Button>
      {err ? <span className="text-[11px] text-rose-600">{err}</span> : null}
    </span>
  );
}
