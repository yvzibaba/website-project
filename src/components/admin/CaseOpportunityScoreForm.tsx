"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Field,
  Input,
  Alert,
} from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 案例「10 维度机会评分」录入台（Phase 13 M5b，client）。
 *
 * 为什么（宪法最高优先级：商业闭环）：评分内核 `src/server/scoring.ts` 早在 Phase 7 建成并锁定 26 条黄金样本，
 * 但后台一直没有可操作录入 `scoreInput` 的界面——运营只能通过种子/API 打分，等于「水管造好却没接上龙头」。
 * 本表单补上这一环：把 10 个维度录进来，`PATCH /api/admin/cases/[id]`（数据层 `updateCase` 早已接受 `scoreInput`
 * 并联动 `recomputeCaseScores`），保存后 `router.refresh()` 让服务端把复算出的机会分/明细回显到只读审计卡。
 *
 * 刻意的设计边界（简单优先 + 单一真源，宪法第 16/20 条）：
 *   - **维度、满分、极性全部由服务端传入**（源自 `OPPORTUNITY_DIMENSIONS` 常量），本组件不抄一份权重——
 *     将来调权重只改内核一处，这里自动跟随，杜绝口径漂移。
 *   - **本组件不自己算最终分、不写库**：客户端只做「即时校验 + 预览求和」帮运营少填错；最终机会分一律以
 *     服务端复算（router.refresh 后回显）为准，绝不让前端算分冒充权威结果（程序计算 > 口算，且前端可被绕过）。
 *   - 校验严格对齐内核 `OpportunityInputSchema`：每项须为 0..max 的整数、10 项齐全才提交，
 *     避免落库一份「不完整 scoreInput」却因内核判 invalid 而不生成 breakdown 的悬空态。
 *   - 反向维度（竞争强度 / 实施难度）按直觉填「越高越糟」，程序负责 max-raw，表单只提示「越低越好」不参与换算。
 */

export interface ScoreDimensionMeta {
  key: string;
  label: string;
  max: number;
  polarity: "positive" | "inverse";
}

type DimParse =
  | { ok: true; value: number }
  | { ok: false; error: string };

function parseDim(d: ScoreDimensionMeta, raw: string): DimParse {
  const s = raw.trim();
  if (s === "") return { ok: false, error: "必填" };
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "必须为整数" };
  if (n < 0) return { ok: false, error: "不能小于 0" };
  if (n > d.max) return { ok: false, error: `不能超过 ${d.max}` };
  return { ok: true, value: n };
}

export function CaseOpportunityScoreForm({
  caseId,
  dimensions,
  initial,
  currentScore,
}: {
  caseId: string;
  dimensions: ScoreDimensionMeta[];
  initial: Record<string, number> | null;
  /** 当前已复算落库的机会分（保存成功后由服务端刷新回显，非本组件计算）。 */
  currentScore: number | null;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const d of dimensions) {
      const v = initial ? initial[d.key] : undefined;
      init[d.key] = typeof v === "number" && Number.isFinite(v) ? String(v) : "";
    }
    return init;
  });
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // 即时派生（不 setState，渲染期纯计算）：逐维度校验 + 预览求和 + 齐全度。
  const parsed = dimensions.map((d) => ({ d, r: parseDim(d, values[d.key] ?? "") }));
  let filled = 0;
  let previewTotal = 0;
  for (const { d, r } of parsed) {
    if (r.ok) {
      filled += 1;
      previewTotal += d.polarity === "inverse" ? d.max - r.value : r.value;
    }
  }
  const allValid = filled === dimensions.length;

  function onInput(key: string, val: string) {
    setValues((v) => ({ ...v, [key]: val }));
    setNotice(null);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    if (!allValid) {
      setNotice({
        tone: "danger",
        text: `请填全 ${dimensions.length} 个维度，且每项为 0~其满分的整数（当前有效 ${filled}/${dimensions.length}）`,
      });
      return;
    }
    const scoreInput: Record<string, number> = {};
    for (const { d, r } of parsed) if (r.ok) scoreInput[d.key] = r.value;

    setPending(true);
    setNotice(null);
    const res = await mutateJson(`/api/admin/cases/${caseId}`, "PATCH", { scoreInput });
    if (res.ok) {
      setNotice({ tone: "success", text: "已保存评分并触发服务端复算，下方「评分明细」与顶部机会分随之更新" });
      router.refresh();
    } else {
      setFieldErrors(res.fields ?? {});
      const hints = fieldHints(res.fields);
      setNotice({ tone: "danger", text: hints.length ? `保存失败：${hints.join("；")}` : res.message ?? "保存失败" });
    }
    setPending(false);
  }

  const serverErr = (k: string) => fieldErrors[k]?.[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">机会评分（10 维度）</CardTitle>
        <CardDescription>
          按总控 §10 的固定维度与满分录入；反向维度（竞争强度 / 实施难度）按直觉「越高越糟」填写，程序负责反向换算。
          分数仅表达相对机会优先级，<span className="font-medium">综合评分 ≠ 项目一定成功</span>，须与证据可信度、关键未知变量一并解读。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            {parsed.map(({ d, r }) => {
              const errText = r.ok ? serverErr(d.key) : r.error;
              return (
                <Field
                  key={d.key}
                  label={d.polarity === "inverse" ? `${d.label}（越低越好）` : d.label}
                  htmlFor={`score-${d.key}`}
                  required
                  help={`满分 ${d.max}`}
                  error={errText}
                >
                  <Input
                    id={`score-${d.key}`}
                    name={d.key}
                    type="number"
                    min={0}
                    max={d.max}
                    step={1}
                    inputMode="numeric"
                    value={values[d.key] ?? ""}
                    onChange={(ev) => onInput(d.key, ev.target.value)}
                    invalid={!!errText}
                    disabled={pending}
                  />
                </Field>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-sm">
            <span className="tabular-nums">
              预览合计：<span className="font-semibold">{previewTotal}</span>
              <span className="text-muted-foreground">
                {` / ${dimensions.reduce((s, d) => s + d.max, 0)}（有效 ${filled}/${dimensions.length}，最终分以服务端复算为准）`}
              </span>
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              当前已存机会分：{currentScore ?? "—"}
            </span>
            <Button type="submit" size="sm" variant="primary" disabled={pending || !allValid} className="ml-auto">
              {pending ? "保存并复算中…" : "保存评分并复算"}
            </Button>
          </div>

          {notice ? (
            <Alert variant={notice.tone} className="py-2">
              {notice.text}
            </Alert>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
