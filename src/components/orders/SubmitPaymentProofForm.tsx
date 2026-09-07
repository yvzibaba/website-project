"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Textarea, Label, FieldError, Alert } from "@/components/ui";

/**
 * 提交付款凭证表单（Phase 12 M4，过渡版人工收款闭环的买家侧动作，client）。
 *
 * 沿用 AdminOrderActions / NewCaseForm 的取向（宪法第 16 条）：不各写 Server Action，而是
 * 消费 M4 新增的 `POST /api/orders/[id]/proof` 端点——CSRF 同源 + 属主核对 + 结果翻译都收敛在
 * api-guard/路由一处，本组件只发请求、如实回报。成功后 `router.refresh()` 让服务端订单页重取
 * （徽章随之从「待支付」变「已提交付款凭证」，收款说明区保持可见直到后台确认）。
 *
 * 诚实与安全：这里**只提交买家自填的凭证文本 `paymentRef`**，绝不提交金额/状态——凭证只是给人工
 * 核对的线索，不改变任何财务事实；订单状态是否变 PAID、正文是否解锁，只由后台 confirmPaid 裁决。
 * 状态机由数据层守护：仅 PENDING 可提交；已支付/已取消调用会得到 blocked，据 HTTP 结果如实提示。
 */

interface SubmitPaymentProofFormProps {
  orderId: string;
  /** 仅 PENDING 暴露提交入口；其它状态本组件由调用方决定是否渲染（此处也兜一层 disabled）。 */
  status: string;
  /** 已提交过的凭证文本，作为 textarea 初值，方便买家更正后重新提交。 */
  initialPaymentRef?: string | null;
}

export function SubmitPaymentProofForm({
  orderId,
  status,
  initialPaymentRef,
}: SubmitPaymentProofFormProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialPaymentRef ?? "");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const actionable = status === "PENDING";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    setErr(null);
    setOkMsg(null);
    if (!trimmed) {
      setErr("请填写付款凭证或交易流水信息");
      return;
    }
    setPending(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/proof`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentRef: trimmed }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: { message?: string; details?: { fields?: Record<string, string[]> } } }
        | null;
      if (res.ok && json?.ok) {
        setOkMsg("已提交付款凭证，工作人员核对到账后将确认，无需你再次操作。");
        router.refresh();
      } else {
        const fieldMsg = json?.error?.details?.fields?.paymentRef?.[0];
        setErr(fieldMsg || json?.error?.message || `提交失败（HTTP ${res.status}）`);
      }
    } catch {
      setErr("网络错误，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <Label htmlFor={`proof-${orderId}`} required>
        付款凭证 / 交易流水信息
      </Label>
      <Textarea
        id={`proof-${orderId}`}
        name="paymentRef"
        rows={3}
        maxLength={200}
        disabled={!actionable || pending}
        invalid={!!err}
        aria-invalid={!!err || undefined}
        placeholder="例如：工商银行 尾号 1234，09-07 转账 ¥1999.00；或转账回执编号"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {err ? <FieldError>{err}</FieldError> : null}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" disabled={!actionable || pending}>
          {pending ? "提交中…" : initialPaymentRef ? "更新付款凭证" : "提交付款凭证"}
        </Button>
        <span className="text-[11px] text-muted-foreground">提交仅代表你已付款，实际到账以工作人员核对确认为准。</span>
      </div>
      {okMsg ? (
        <Alert variant="success" title="已收到">
          {okMsg}
        </Alert>
      ) : null}
    </form>
  );
}
