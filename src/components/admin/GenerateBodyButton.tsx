"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Textarea, Alert } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 后台方案「一键生成正文草稿」按钮（Phase 13 M7，client）。
 *
 * 为什么：Phase 8 M3 已把 §33 多角色研究流水线（Research→Bull→Bear→Judge→QA）产出映射进可售方案正文，
 *   但只有裸端点 `POST /api/admin/solutions/[id]/generate`、无运营可点的人面入口——「AI 做大量劳动」造好的
 *   能力对人是断链的。本组件把这条能力接上后台编辑台，让审核人一键触发「为该草稿生成 AI 正文」，随后仍由
 *   人决定是否发布（宪法「人做关键决策」「禁止 AI 自动公开发布」）。
 *
 * 刻意边界（与 Phase 8 M3 数据层契约一致，UI 不越权）：
 *   - 只调**已受 requireStaffWrite 门禁**的生成端点（复用 mutateJson 薄封装，绝不另起 Server Action / 各抄
 *     一遍 fetch，宪法第 16 条防漂移）；不自行判定能否发布。
 *   - 生成端点**永不发布、且对已发布方案直接 409**（不自动改写线上正文）——故此处对已发布态**禁用按钮 + 说明**，
 *     但仍以服务端为准（若竞态下变已发布，409 原样回显）。
 *   - 只覆盖流水线能诚实支撑的分节（正反证据/风险/未知变量/AI 标注），**财务/ROI/来源等刻意不生成**——回显里
 *     如实转达服务端 `notGenerated` 语义（「须程序计算/人工补充」），绝不暗示方案已完整可售。
 *   - 可选填「研究聚焦问题」覆写默认派生问题；留空则服务端由方案/案例标题确定性派生。
 *   成功 `router.refresh()`，让服务端重取 body → 正文编辑台即时反映生成的分节。
 */

interface GenerateBodyButtonProps {
  solutionId: string;
  /** 当前状态；`PUBLISHED` 时禁用（AI 生成不自动改写线上正文）。 */
  status: string;
}

/** 服务端 `generation` 元数据结构（与 solution-generation.ts 的 GenerateSolutionResult.generation 对齐）。 */
interface GenerationMeta {
  pipelineStatus?: string;
  needsHumanReview?: boolean;
  reviewReason?: string;
  filledSectionKeys?: string[];
  wroteSections?: number;
  cost?: { calls?: number; totalCostUsd?: number };
}

const STATUS_LABEL_ZH: Record<string, string> = {
  complete: "研究完成",
  needs_human_review: "需人工复核",
  failed: "流水线未完成",
};

export function GenerateBodyButton({ solutionId, status }: GenerateBodyButtonProps) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [meta, setMeta] = useState<GenerationMeta | null>(null);

  const published = status === "PUBLISHED";

  async function generate() {
    setPending(true);
    setMsg(null);
    setMeta(null);
    const body = question.trim() ? { question: question.trim().slice(0, 2000) } : {};
    const res = await mutateJson(`/api/admin/solutions/${solutionId}/generate`, "POST", body);
    if (res.ok) {
      const g = (res.data?.generation ?? null) as GenerationMeta | null;
      setMeta(g);
      const wrote = g?.wroteSections ?? 0;
      const cost = g?.cost?.totalCostUsd;
      const costText = typeof cost === "number" ? `，成本约 $${cost.toFixed(4)}` : "";
      if (wrote === 0) {
        setMsg(`已运行但无可诚实写入的分节（${STATUS_LABEL_ZH[g?.pipelineStatus ?? ""] ?? g?.pipelineStatus ?? "—"}），未改动正文${costText}`);
      } else {
        setMsg(`已生成 ${wrote} 个分节（${STATUS_LABEL_ZH[g?.pipelineStatus ?? ""] ?? g?.pipelineStatus ?? "—"}）${costText}`);
      }
      router.refresh();
    } else {
      const hints = fieldHints(res.fields);
      setMsg(hints.length ? `生成未执行：${hints.join("；")}` : res.message ?? "生成失败，请稍后重试");
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-muted-foreground">
          研究聚焦问题（可选，留空则由方案 / 案例标题派生）
        </label>
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          maxLength={2000}
          disabled={pending || published}
          placeholder="例如：重点评估中国本土供应链与设备国产化替代的落地成本与风险"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" disabled={published || pending} onClick={generate}>
          {pending ? "生成中…（多角色研究，约数十秒）" : "生成 AI 正文草稿"}
        </Button>
        {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
      </div>

      {published ? (
        <Alert variant="info" title="已发布方案不可直接生成">
          方案已发布，AI 生成不会自动改写线上正文。请先「退回草稿」或复制新草稿后再生成（发布与否始终由人决定）。
        </Alert>
      ) : null}

      {meta?.needsHumanReview && meta.reviewReason ? (
        <Alert variant="warning" title="需人工复核">
          {meta.reviewReason}
        </Alert>
      ) : null}

      {!published ? (
        <p className="text-[11px] text-muted-foreground">
          仅生成流水线能诚实支撑的分节（正反证据、风险、关键未知变量、AI 假设/推断/预测标注）；
          <strong>成本模型 / 收入 / ROI / 回收期 / 来源等不会由 AI 编造</strong>，须由程序计算与人工溯源补充后，方案才算完整可售。
        </p>
      ) : null}
    </div>
  );
}
