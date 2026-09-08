"use client";

import { useState } from "react";
import { Button, Input, Textarea, Label, Alert } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 反馈表单（Phase 4 模块 C，client）：POST /api/feedback（可匿名，服务端会话自动归因）。
 * kind 白名单 BUG/SUGGESTION/QUESTION/OTHER；message 5–2000 字；email 可选。
 * 成功后整表重置并显示感谢条；服务端 zod 错误回显到字段提示。
 */
const KINDS = [
  { value: "BUG", label: "问题/报错" },
  { value: "SUGGESTION", label: "功能建议" },
  { value: "QUESTION", label: "使用咨询" },
  { value: "OTHER", label: "其他" },
] as const;

export function FeedbackForm({ page }: { page?: string }) {
  const [kind, setKind] = useState<string>("BUG");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await mutateJson("/api/feedback", "POST", {
      kind,
      message,
      email: email || undefined,
      page: page || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError((res.message ?? "提交失败") + (hint ? `：${hint}` : ""));
      return;
    }
    setDone(true);
    setMessage("");
    setEmail("");
  }

  if (done) {
    return (
      <Alert variant="success" title="已收到你的反馈">
        感谢反馈！站点维护者会在后台查看并处理。若留下邮箱，处理后可能与你联系。
        <button type="button" className="ml-2 underline" onClick={() => setDone(false)}>
          再提一条
        </button>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="feedback-kind">反馈类型</Label>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              aria-pressed={kind === k.value}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                kind === k.value
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-input bg-transparent text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="feedback-message" required>
          反馈内容（5–2000 字）
        </Label>
        <Textarea
          id="feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          maxLength={2000}
          placeholder="发生了什么？在哪个页面？期望是什么？描述越具体越容易被处理。"
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="feedback-email">联系邮箱（可选，登录用户可留空）</Label>
        <Input
          id="feedback-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={200}
          placeholder="name@example.com"
        />
      </div>

      {error ? (
        <Alert variant="danger" title="提交失败">
          {error}
        </Alert>
      ) : null}

      <div>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "提交中…" : "提交反馈"}
        </Button>
      </div>
    </form>
  );
}
