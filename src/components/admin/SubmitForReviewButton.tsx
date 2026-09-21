"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * R7-C · V2 决策导出方案「提交人工审核」按钮（DRAFT → UNDER_HUMAN_REVIEW 的**唯一合法通道**）。
 *
 * ## 为什么要单独一个按钮
 * mandate §四 把 `UNDER_HUMAN_REVIEW` 从"可选停留态"升级成 V2 方案的**强制发布闸门**：
 *   DRAFT ─[提交人工审核]→ UNDER_HUMAN_REVIEW ─[发布（走 publishGuard）]→ PUBLISHED
 *   ✗ DRAFT ─────────[直跳 PUBLISHED]──────────→ 被 `humanReviewGateForV2` 拒
 * V1 手工建方案不带 `body.extras.decisionReport` → 门不启用，`PublishSolutionButton` 一步直发即可
 * （不破坏既有 V1 流程）。
 *
 * ## 实现取向
 * 与 `PublishSolutionButton` / `EditSolutionMetaForm` 同构（宪法第 16 条）：**只 PATCH 一个 status 字段**到
 * 已测的 `/api/admin/solutions/[id]`——CSRF + `requireStaffWrite` + 判别联合翻译全在 `api-guard`，
 * UI 只发请求与如实回报，绝不本地判"能不能提交"（判错就是"发布门"漂了）。
 */

interface Props {
  solutionId: string;
  status: string;
  /** 是否 V2 决策导出方案（服务端预渲染时按 extras.decisionReport 判定传入；false → 本按钮不渲染）。 */
  isV2DecisionExport: boolean;
}

export function SubmitForReviewButton({ solutionId, status, isV2DecisionExport }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 只对 V2 DRAFT 显示；进入 UNDER_HUMAN_REVIEW / PUBLISHED 后无动作可点。
  if (!isV2DecisionExport || status !== "DRAFT") return null;

  async function submit() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/solutions/${solutionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "UNDER_HUMAN_REVIEW" }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string } }
        | null;
      if (res.ok && json?.ok) {
        setMsg("已提交人工审核");
        router.refresh();
      } else {
        setMsg(json?.error?.message ?? `提交失败（HTTP ${res.status}）`);
      }
    } catch {
      setMsg("网络错误，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" disabled={pending} onClick={submit}>
        {pending ? "提交中…" : "提交人工审核"}
      </Button>
      {msg ? <span className="max-w-[16rem] text-right text-[11px] text-muted-foreground">{msg}</span> : null}
    </div>
  );
}
