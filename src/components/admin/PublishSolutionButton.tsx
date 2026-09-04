"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * 后台方案行操作（Phase 13 M3，client）——「发布」动作（草稿/审核中 → 已发布）。
 *
 * 沿用 NewSolutionForm/AdminOrderActions 的取向（宪法第 16 条）：不各写 Server Action，而是**消费
 * Phase 13 M1 的 `/api/admin/solutions/[id]` PATCH 端点**——CSRF 同源 + requireStaffWrite 角色门禁 +
 * 判别联合翻译都收敛在 api-guard 一处，UI 只负责发请求与如实回报结果。
 * 成功后 `router.refresh()` 让服务端列表重取（状态徽章随之更新为「已发布」、按钮转为禁用）。
 *
 * 发布守卫在数据层：PATCH {status:"PUBLISHED"} 若缺价 / 涉及高风险未勾选专业确认 → 409 CONFLICT
 * 且 error.details.fields 指名原因；此处如实回显，让运营明白「还差什么才能发布」（不假装成功）。
 */

interface PublishSolutionButtonProps {
  solutionId: string;
  status: string;
}

type Fields = Record<string, string[]>;

export function PublishSolutionButton({ solutionId, status }: PublishSolutionButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const published = status === "PUBLISHED";
  const actionable = !published;

  async function publish() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/solutions/${solutionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "PUBLISHED" }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { code?: string; message?: string; details?: { fields?: Fields } } }
        | null;
      if (res.ok && json?.ok) {
        setMsg("已发布，方案现对外可售");
        router.refresh();
      } else {
        const fields = json?.error?.details?.fields;
        const hints = fields ? Object.values(fields).flat().filter(Boolean) : [];
        setMsg(hints.length ? `发布被拦：${hints.join("；")}` : json?.error?.message || `发布失败（HTTP ${res.status}）`);
      }
    } catch {
      setMsg("网络错误，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="primary" disabled={!actionable || pending} onClick={publish}>
        {published ? "已发布" : pending ? "处理中…" : "发布"}
      </Button>
      {msg ? <span className="max-w-[16rem] text-right text-[11px] text-muted-foreground">{msg}</span> : null}
    </div>
  );
}
