"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * 后台订单行操作（Phase 12 M3，client）——「确认收款 / 取消」两个动作。
 *
 * 沿用 NewCaseForm 的取向（宪法第 16 条）：不各写 Server Action，而是**消费 Phase 12 M2 的
 * `/api/admin/orders/[id]/{confirm,cancel}` 端点**——CSRF 同源 + requireStaffWrite 角色门禁 +
 * 判别联合翻译都收敛在 api-guard 一处，UI 只负责发请求与如实回报结果。
 * 成功后 `router.refresh()` 让服务端列表重取（状态徽章/按钮随之更新），不手动改本地态。
 *
 * 状态机由数据层守护：仅 PENDING 可确认/取消；终态点确认返回 blocked/幂等 ok，UI 据 HTTP 结果如实提示。
 */

interface AdminOrderActionsProps {
  orderId: string;
  /** 仅 PENDING 暴露可点按钮；其它状态本组件由调用方决定是否渲染（此处也再兜一层 disabled）。 */
  status: string;
}

export function AdminOrderActions({ orderId, status }: AdminOrderActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<null | "confirm" | "cancel">(null);
  const [msg, setMsg] = useState<string | null>(null);

  const actionable = status === "PENDING";

  async function act(kind: "confirm" | "cancel") {
    setPending(kind);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; deduped?: boolean; error?: { message?: string } }
        | null;
      if (res.ok && json?.ok) {
        setMsg(kind === "confirm" ? (json.deduped ? "已是已支付状态" : "已确认收款") : json.deduped ? "已是已取消状态" : "已取消订单");
        router.refresh();
      } else {
        setMsg(json?.error?.message || `操作失败（HTTP ${res.status}）`);
      }
    } catch {
      setMsg("网络错误，请稍后重试");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!actionable || pending !== null}
          onClick={() => act("confirm")}
        >
          {pending === "confirm" ? "处理中…" : "确认收款"}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!actionable || pending !== null}
          onClick={() => act("cancel")}
        >
          {pending === "cancel" ? "处理中…" : "取消"}
        </Button>
      </div>
      {msg ? <span className="text-[11px] text-muted-foreground">{msg}</span> : null}
    </div>
  );
}
