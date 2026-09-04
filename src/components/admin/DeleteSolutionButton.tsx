"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 删除方案（Phase 13 M4，client）——消费 `DELETE /api/admin/solutions/[id]`。
 *
 * 数据层守卫：任一 Order 关联（PENDING/PAID/…）→ 409 blocked 并透「仍有 N 条订单」原因（V1 无退款
 * 流程，删单会孤儿订单，属 ROADMAP #5）。此处如实回显拦截原因、绝不假装删除；无关联时硬删（级联
 * 删财务/未知由 schema onDelete:Cascade 保证），成功跳回方案列表。
 */
export function DeleteSolutionButton({ solutionId, title, orderCount }: { solutionId: string; title: string; orderCount: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onClick() {
    if (!confirm(`确认删除方案「${title}」？此操作不可撤销（草稿/未售方案才建议删）。`)) return;
    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/solutions/${solutionId}`, "DELETE");
    if (res.ok) {
      router.push("/admin/solutions");
      router.refresh();
      return;
    }
    const hints = fieldHints(res.fields);
    setNotice(hints.length ? hints.join("；") : res.message ?? "删除失败");
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" variant="danger" disabled={pending || orderCount > 0} onClick={onClick}>
        {pending ? "删除中…" : "删除方案"}
      </Button>
      {orderCount > 0 ? (
        <span className="text-[11px] text-muted-foreground">已有 {orderCount} 条订单，禁止删除（先走撤单/退款流程，属支付域）。</span>
      ) : null}
      {notice ? (
        <Alert variant="danger" className="py-2">
          {notice}
        </Alert>
      ) : null}
    </div>
  );
}
