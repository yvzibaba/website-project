/**
 * 沙盘「AI 解释」面板（中途重构 R6.2 · §7 LLM 只解释、§14 优先级第 10 项）。
 *
 * 客户端只负责：把 R6.1 已算好的**确定性报告** + 可选追问 POST 到受登录门禁的 `/api/sandbox/explain`，
 * 再如实渲染回来的解释。**本组件不重算任何数字**（数字来自报告，报告来自引擎）；LLM 也只被允许解释
 * 报告里已有的数字。真实模型调用发生在服务端（密钥不入 bundle），成本落 ModelCall 表。
 */

"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  Textarea,
} from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";
import type { SandboxReport } from "@/lib/sandbox-report";

interface Explanation {
  interpretation: string;
  keyDrivers: string[];
  whatIf: string[];
  risks: string[];
  needsHumanReview: boolean;
}

interface ExplainMeta {
  modelId?: string;
  explainVersion?: string;
  cost?: { calls: number; totalCostUsd: number };
}

function BulletList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-zinc-700">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

export function SandboxExplainPanel({ report }: { report: SandboxReport }) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [meta, setMeta] = useState<ExplainMeta | null>(null);

  async function run() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setExplanation(null);
    setMeta(null);
    const res = await mutateJson("/api/sandbox/explain", "POST", {
      report,
      question: question.trim() ? question.trim() : undefined,
    });
    setLoading(false);
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setError(res.message ?? "AI 解释失败" + (hint ? `：${hint}` : ""));
      return;
    }
    const data = (res.data ?? {}) as { explanation?: Explanation } & ExplainMeta;
    setExplanation(data.explanation ?? null);
    setMeta({ modelId: data.modelId, explainVersion: data.explainVersion, cost: data.cost });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">AI 解释（只解读，不算数）</CardTitle>
            <CardDescription>
              让 AI 用自然语言解读上面这份确定性报告：为何是这个结果、最敏感的变量、以及定性的 what-if。
              它不会改动任何数字，也不产生新的具体数值。
            </CardDescription>
          </div>
          {explanation?.needsHumanReview ? <Badge variant="warning">需专业人工确认</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="（可选）想特别了解什么？例如「为什么回收期这么久」「如果电价再降会怎样」"
          rows={2}
          maxLength={2000}
        />
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={run} disabled={loading || !report.ok}>
            {loading ? "AI 正在解读…" : explanation ? "重新解释" : "生成 AI 解释"}
          </Button>
          {loading ? <Spinner className="h-4 w-4" /> : null}
          {!report.ok ? <span className="text-[11px] text-zinc-500">参数不足以出结论，暂不可解释。</span> : null}
        </div>

        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        ) : null}

        {explanation ? (
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-1">
              <h4 className="text-sm font-semibold text-zinc-800">结论解读</h4>
              <p className="text-sm leading-relaxed text-zinc-700">{explanation.interpretation}</p>
            </section>

            {explanation.keyDrivers.length ? (
              <section className="flex flex-col gap-1">
                <h4 className="text-sm font-semibold text-zinc-800">最关键 / 最敏感的变量</h4>
                <BulletList items={explanation.keyDrivers} />
              </section>
            ) : null}

            {explanation.whatIf.length ? (
              <section className="flex flex-col gap-1">
                <h4 className="text-sm font-semibold text-zinc-800">定性 what-if 走势（不含新数值）</h4>
                <BulletList items={explanation.whatIf} />
              </section>
            ) : null}

            {explanation.risks.length ? (
              <section className="flex flex-col gap-1">
                <h4 className="text-sm font-semibold text-zinc-800">风险与待核实</h4>
                <BulletList items={explanation.risks} />
              </section>
            ) : null}

            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
              以上为 AI 对**确定性引擎结论**的语言解读，未参与任何计算；模型（{meta?.modelId ?? "—"}）可能出错，
              所有数字请以报告与图表为准，须经专业人工确认后方可采信。
            </div>
            <div className="text-[11px] text-zinc-400">
              解释 v{meta?.explainVersion ?? "—"} · 本次成本 ≈ ${meta?.cost?.totalCostUsd ?? 0}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
