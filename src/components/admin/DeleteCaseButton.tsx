"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Alert } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 删除案例（Phase 13 M5，client）——消费 `DELETE /api/admin/cases/[id]`。
 *
 * 数据层守卫（deleteCase）：案例仍挂 **PUBLISHED 方案** → 409 blocked 并透「仍有 N 个已发布方案，
 * 禁止删除」原因（宪法：不把可购买商品变孤儿）。与方案侧不同，这里**不因订单数禁用按钮**——因为
 * 拦截条件专指"已发布方案"，是否可删由服务端裁决；客户端只把 publishedSolutionCount 作为提示、
 * 并在服务端真的拒绝时如实回显原因，绝不假装删除。无已发布方案时硬删（级联删证据/能力/本土化，
 * schema onDelete:Cascade 保证），成功跳回案例列表。
 */
export function DeleteCaseButton({ caseId, title, publishedSolutionCount }: { caseId: string; title: string; publishedSolutionCount: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onClick() {
    if (!confirm(`确认删除案例「${title}」？将级联删除其证据/能力/本土化记录，此操作不可撤销。`)) return;
    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/cases/${caseId}`, "DELETE");
    if (res.ok) {
      router.push("/admin/cases");
      router.refresh();
      return;
    }
    const hints = fieldHints(res.fields);
    setNotice(hints.length ? hints.join("；") : res.message ?? "删除失败");
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" variant="danger" disabled={pending} onClick={onClick}>
        {pending ? "删除中…" : "删除案例"}
      </Button>
      {publishedSolutionCount > 0 ? (
        <span className="text-[11px] text-muted-foreground">{`该案例仍有 ${publishedSolutionCount} 个已发布方案，需先下架/撤审后才能删除。`}</span>
      ) : null}
      {notice ? (
        <Alert variant="danger" className="py-2">
          {notice}
        </Alert>
      ) : null}
    </div>
  );
}
