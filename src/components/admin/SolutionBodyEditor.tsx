"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Field, Textarea, Alert, Badge } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * 方案正文「34 分节」编辑（Phase 13 M4，client）——把可售方案的**付费交付主体**变得可录入。
 *
 * 为什么这是本里程碑的重点：Phase 12 打通了「购买 → 解锁正文」，Phase 13 M3 能建/发布方案，
 * 但正文此前只能靠裸 API 写。没有正文编辑台，卖的就是一份空壳——直接拖累「方案质量 > 功能数量」
 * （宪法优先级）。分节规范来自 `solution-body.ts` 的 `SOLUTION_SECTIONS`（总控 §3 逐字给定的单一真源），
 * 编辑器按 canonical key 组织，**不另立一套分节规则**（第 16 条防漂移）。
 *
 * 保存策略（诚实、不丢数据）：
 *   - 以 canonical key 重建 body（`{...extras, [key]: value}`）：非空节写入、空节省略；
 *     历史里用中文 title 当键的内容经归一后会被规范化到 key（title 键因不在 extras 而自然消失），
 *     34 分节之外的未知键（`extras`）原样保留——绝不静默丢弃契约外数据。
 *   - 值：以 `{` 或 `[` 开头的文本尝试 `JSON.parse`（支持直接粘贴结构化内容），失败或普通文本一律存字符串。
 *
 * 注：部分分节（成本/收入/ROI/回收期/关键未知变量/来源）另有结构化卡片（见同页财务/未知编辑台），
 * 叙述性说明放这里、可复算数字放卡片，二者可控冗余，与展示层一致（solution-body.ts 同注释）。
 */

export interface BodySection {
  key: string;
  title: string;
  value: string;
}

function tryStructured(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return text; // 解析失败按原文存字符串，不吞内容
    }
  }
  return text;
}

export function SolutionBodyEditor({
  solutionId,
  sections,
  extras,
}: {
  solutionId: string;
  sections: BodySection[];
  extras: Record<string, unknown>;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(sections.map((s) => [s.key, s.value])),
  );
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const filledCount = sections.filter((s) => (values[s.key] ?? "").trim().length > 0).length;
  const extrasCount = Object.keys(extras).length;

  async function save() {
    setPending(true);
    setNotice(null);
    const body: Record<string, unknown> = { ...extras };
    for (const s of sections) {
      const text = (values[s.key] ?? "").trim();
      if (!text) continue; // 空节省略
      body[s.key] = tryStructured(text);
    }
    const res = await mutateJson(`/api/admin/solutions/${solutionId}`, "PATCH", { body });
    if (res.ok) {
      setNotice({ tone: "success", text: `已保存正文（${filledCount}/${sections.length} 节）` });
      router.refresh();
    } else {
      const hints = fieldHints(res.fields);
      setNotice({ tone: "danger", text: hints.length ? `保存失败：${hints.join("；")}` : res.message ?? "保存失败" });
    }
    setPending(false);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">方案正文（34 分节）</CardTitle>
            <CardDescription>购买者解锁后看到的就是这份正文。逐节填写叙述；可粘贴 JSON 结构化内容。数字测算建议填下方「财务测算」卡片。</CardDescription>
          </div>
          <Badge variant="neutral" className="shrink-0 tabular-nums">
            已填 {filledCount}/{sections.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {extrasCount > 0 ? (
          <Alert variant="info" title={`保留 ${extrasCount} 个契约外字段（原样透传，不丢弃）`} icon politeness="status">
            这些键不在 34 分节规范内，保存时会原样带回，供审计发现契约漂移。
          </Alert>
        ) : null}
        <div className="flex flex-col gap-4">
          {sections.map((s, i) => (
            <Field key={s.key} label={`${i + 1}. ${s.title}`} htmlFor={`body-${s.key}`} help={<code className="font-mono text-[11px]">{s.key}</code>}>
              <Textarea
                id={`body-${s.key}`}
                rows={3}
                value={values[s.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [s.key]: e.target.value }))}
                placeholder="（待补充）"
              />
            </Field>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" variant="primary" disabled={pending} onClick={save}>
            {pending ? "保存中…" : "保存正文"}
          </Button>
          {notice ? (
            <Alert variant={notice.tone} className="flex-1 py-2">
              {notice.text}
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
