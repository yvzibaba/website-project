"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 审核发布队列的行操作（Phase 13 M6，client）。
 *
 * 一条待办（方案 / 案例）的多个动作按钮，全部**复用 Phase 13 M1 既有 PATCH 端点**
 * （`/api/admin/solutions/[id]` 改 status、`/api/admin/cases/[id]` 改 stage），经 api-guard 的
 * CSRF 同源 + requireStaffWrite 角色门禁 + 数据层发布守卫。UI 不自行判定"能不能发"——服务端仍是
 * 唯一权威（宪法第 16 条防漂移）：按钮照常发出，被守卫拒时如实回显 409 的字段原因。
 * 成功后 `router.refresh()` 让服务端队列重取（该条自然从队列消失 / 状态徽章更新）。
 */

export interface QueueAction {
  /** 按钮文案。 */
  label: string;
  /** PATCH 请求体（如 {status:"PUBLISHED"} / {stage:"DEEP_CASE"}）。 */
  body: Record<string, unknown>;
  variant?: "primary" | "secondary" | "ghost" | "link";
  /** 点击前先弹确认（用于"发布到公开橱窗"这类对外可见动作）。 */
  confirm?: string;
}

interface ReviewQueueActionsProps {
  /** 目标端点，如 `/api/admin/solutions/abc`。 */
  endpoint: string;
  actions: QueueAction[];
}

export function ReviewQueueActions({ endpoint, actions }: ReviewQueueActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(action: QueueAction) {
    if (action.confirm && !window.confirm(action.confirm)) return;
    setPending(action.label);
    setMsg(null);
    const res = await mutateJson(endpoint, "PATCH", action.body);
    if (res.ok) {
      setMsg(`${action.label}：完成`);
      router.refresh();
    } else {
      const hints = fieldHints(res.fields);
      setMsg(hints.length ? `${action.label}被拦：${hints.join("；")}` : res.message ?? `${action.label}失败`);
    }
    setPending(null);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {actions.map((a) => (
          <Button
            key={a.label}
            size="sm"
            variant={a.variant ?? "primary"}
            disabled={pending !== null}
            onClick={() => run(a)}
          >
            {pending === a.label ? "处理中…" : a.label}
          </Button>
        ))}
      </div>
      {msg ? <span className="max-w-[18rem] text-right text-[11px] text-muted-foreground">{msg}</span> : null}
    </div>
  );
}
