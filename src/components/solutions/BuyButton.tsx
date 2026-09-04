"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Alert } from "@/components/ui";

/**
 * 「购买方案」按钮（Phase 12 M3，client）——消费 Phase 12 M2 的 `POST /api/orders`。
 *
 * 为什么走 fetch 到 HTTP 端点、而非另起 Server Action 直调 orders.ts：
 *   下单的门禁（CSRF 同源 `requireSameOriginActor` + 会话身份注入）与结果翻译已收敛在
 *   `api-guard.ts` **唯一一处**（宪法第 16 条防逐入口漂移）。这里若各自 requireUser + 各自翻译判别联合，
 *   等于把同一套鉴权/防篡改逻辑抄第二遍。端点也因此获得真实调用方，而非"造了没人用"。
 *   浏览器同源 POST 自动带 `Origin`、`SameSite=Lax` 会话 cookie 同源必发，与服务端 CSRF 判定天然吻合。
 *
 * 金额安全（宪法第 7/20 条）：**本组件只提交 `solutionId`，绝不提交任何金额/状态**——
 *   订单金额由服务端从 `Solution.price` 快照（orders.ts 数据层白名单），客户端无从篡改。
 *
 * V1 决策：**购买需登录**（下单身份=会话 userId，便于事后找回订单与判定解锁）。
 *   游客在详情页看到的是「登录后可购买」引导（由服务端 RSC 决定是否渲染本组件）。
 *   （数据层/端点仍支持游客 buyerEmail 下单，只是本版 UI 不提供游客下单入口，属有意的最小化。）
 *
 * 交互：成功（含幂等复用已有待支付单）→ `router.push("/orders/<orderId>")` 进入支付说明页；
 *   409 blocked（如已购买过该方案）→ 顶部如实提示；401/500 → 如实报错，绝不假装成功。
 */

interface BuyButtonProps {
  solutionId: string;
  solutionTitle: string;
  /** 支付说明页跳转前的兜底：已登录用户在详情页下方即可看到结果反馈。 */
  loginHref?: string;
}

export function BuyButton({ solutionId, solutionTitle }: BuyButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  async function onBuy() {
    setPending(true);
    setBanner(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 只提交 solutionId；身份由服务端从会话注入，金额由服务端快照，客户端一概不传。
        body: JSON.stringify({ solutionId }),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            orderId?: string;
            deduped?: boolean;
            error?: { code?: string; message?: string; details?: { fields?: Record<string, string[]> } };
          }
        | null;

      if (res.ok && json?.ok && json.orderId) {
        // 跳到该订单的支付说明页（支付说明为站外、无网关；后台确认后解锁）。
        router.push(`/orders/${json.orderId}`);
        return;
      }
      if (res.status === 409) {
        setBanner(json?.error?.message || "你已拥有该方案，无需重复下单。");
      } else if (res.status === 401) {
        setBanner("请先登录后再购买。");
      } else {
        setBanner(json?.error?.message || `下单失败（HTTP ${res.status}）`);
      }
    } catch {
      setBanner("网络错误，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button variant="primary" size="lg" onClick={onBuy} disabled={pending}>
        {pending ? "处理中…" : "立即购买方案"}
      </Button>
      {banner ? (
        <div className="w-full max-w-xs">
          <Alert variant="warning" title="无法下单">
            {banner}
            {res409HasOrder(banner) ? (
              <Link href="/account/orders" className="ml-1 underline">
                查看我的订单 →
              </Link>
            ) : null}
          </Alert>
        </div>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          下单后按支付说明完成站外付款，管理员确认到账即解锁《{solutionTitle.slice(0, 16)}…》完整正文。
        </span>
      )}
    </div>
  );
}

// 「已拥有该方案」类提示才引导去我的订单（粗略判定，仅为体验，不作安全依据）。
function res409HasOrder(msg: string): boolean {
  return /已(购买|拥有|下单)/.test(msg);
}
