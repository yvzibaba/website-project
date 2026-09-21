"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Textarea, Label } from "@/components/ui";
import { mutateJson, fieldHints } from "@/components/admin/mutate";

/**
 * R8 后台「新增草料」表单（Research Workspace 的写入口，mandate §八）。
 *
 * 刻意**保持极简、零"AI 帮忙填"入口**：AI 产出属"AI_RESEARCH"来源，但那条路在 §十 里必须先经
 *   §33 多角色研究流水线（`research-pipeline.ts` 已强制 needs_human_review）+ 人工核验后才允许入池；
 *   本表单只服务"人手工录入一条发现期草料"这条最短路径，防止 UI 层提前把 §十 承诺"自动化"跳步实现。
 *
 * 提交即触发**服务端纯函数六闸筛查**（`createCandidate`），成功后 `router.refresh()` 让服务端组件
 *   重新读列表（Next.js App Router 官方推荐 refresh 语义）。失败原样回显字段级错误（api-guard 已把
 *   zod fieldErrors 结构透传），不粉饰、不假装落库。
 */

interface EvidenceRow {
  claim: string;
  kind: string;
  confidence: string; // 用 string 存输入框值，提交前 Number() 转（"空串" 转 NaN 直接跳过）
  sourceUrl: string;
}

const KIND_OPTIONS = ["", "FACT", "ASSUMPTION", "INFERENCE", "PREDICTION"];

function emptyEvidence(): EvidenceRow {
  return { claim: "", kind: "FACT", confidence: "80", sourceUrl: "" };
}

export function CandidateCreateForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [industry, setIndustry] = useState<string>("NEW_ENERGY");
  const [region, setRegion] = useState("");
  const [source, setSource] = useState("");
  const [sourceType, setSourceType] = useState<"MANUAL" | "AI_RESEARCH" | "IMPORT">("MANUAL");
  const [technology, setTechnology] = useState("");
  const [description, setDescription] = useState("");
  const [estimatedScale, setEstimatedScale] = useState("");
  const [evidence, setEvidence] = useState<EvidenceRow[]>([emptyEvidence()]);
  const [hasEconomics, setHasEconomics] = useState(false);
  const [industryValuePresent, setIndustryValuePresent] = useState(false);
  const [disqualifiers, setDisqualifiers] = useState("");

  function reset() {
    setTitle("");
    setIndustry("NEW_ENERGY");
    setRegion("");
    setSource("");
    setSourceType("MANUAL");
    setTechnology("");
    setDescription("");
    setEstimatedScale("");
    setEvidence([emptyEvidence()]);
    setHasEconomics(false);
    setIndustryValuePresent(false);
    setDisqualifiers("");
    setErr(null);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    const ev = evidence
      .map((e) => ({
        claim: e.claim.trim() || undefined,
        kind: e.kind || undefined,
        confidence:
          e.confidence.trim() === "" ? undefined : Number(e.confidence),
        sourceUrl: e.sourceUrl.trim() || undefined,
      }))
      .filter((e) => e.claim || e.sourceUrl || e.kind); // 全空的证据行不上送
    const body: Record<string, unknown> = {
      title: title.trim(),
      industry,
      region: region.trim() || null,
      source: source.trim(),
      sourceType,
      technology: technology.trim() || null,
      description: description.trim() || null,
      estimatedScale: estimatedScale.trim() || null,
      evidence: ev,
      screeningHints: {
        hasEconomics,
        industryValuePresent,
        disqualifiers: disqualifiers
          .split(/[,，;；\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };
    const res = await mutateJson("/api/admin/candidates", "POST", body);
    setBusy(false);
    if (!res.ok) {
      const hint = fieldHints(res.fields).join("；");
      setErr((res.message ?? "写入失败") + (hint ? `：${hint}` : ""));
      return;
    }
    reset();
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          ＋ 新增草料
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">新增草料（发现期 · 未核实）</div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          收起
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label required>标题</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清是哪个项目 / 场景" />
        </div>
        <div>
          <Label required>来源文字（source）</Label>
          <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="如：官网新闻 / 访谈纪要 / 研报链接说明" />
        </div>
        <div>
          <Label>行业</Label>
          <select
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          >
            <option value="NEW_ENERGY">新能源</option>
            <option value="INDUSTRIAL_MANUFACTURING">工业制造</option>
            <option value="TRANSPORTATION">交通运输</option>
            <option value="AGRICULTURE_FORESTRY_FISHERY">农林牧渔</option>
            <option value="EDUCATION_TRAINING">教育培训</option>
            <option value="REAL_ESTATE_CONSTRUCTION">房地产建筑</option>
            <option value="OTHER">其他</option>
          </select>
        </div>
        <div>
          <Label>来源类型</Label>
          <select
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm"
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value as "MANUAL" | "AI_RESEARCH" | "IMPORT")}
          >
            <option value="MANUAL">人工录入（MANUAL）</option>
            <option value="AI_RESEARCH">AI 研究产出（AI_RESEARCH·恒为候选须人工核验）</option>
            <option value="IMPORT">批量导入（IMPORT）</option>
          </select>
        </div>
        <div>
          <Label>地区</Label>
          <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="如：山西大同 / 内蒙古鄂尔多斯" />
        </div>
        <div>
          <Label>关键技术路线</Label>
          <Input value={technology} onChange={(e) => setTechnology(e.target.value)} placeholder="如：换电重卡 / 独立储能现货+调频" />
        </div>
        <div>
          <Label>规模档位（粗估）</Label>
          <Input value={estimatedScale} onChange={(e) => setEstimatedScale(e.target.value)} placeholder="如：12 站 / 200MWh / 年运力 500 万吨" />
        </div>
        <div className="md:col-span-2">
          <Label>描述</Label>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="发现期一句话画像即可，不必完整" />
        </div>
      </div>

      <div className="pt-2 border-t border-dashed border-border">
        <div className="text-xs text-zinc-500 mb-2">
          证据条目（发现期「能填多少填多少」；高置信 conf ≥ 50 计入六闸「证据」门 ≥3 条判定）
        </div>
        {evidence.map((row, idx) => (
          <div key={idx} className="grid grid-cols-12 gap-2 mb-2">
            <div className="col-span-5">
              <Input
                value={row.claim}
                placeholder="事实/假设的一句话陈述"
                onChange={(e) =>
                  setEvidence((prev) => prev.map((p, i) => (i === idx ? { ...p, claim: e.target.value } : p)))
                }
              />
            </div>
            <div className="col-span-2">
              <select
                className="w-full rounded-md border border-input bg-white px-2 py-2 text-sm"
                value={row.kind}
                onChange={(e) =>
                  setEvidence((prev) => prev.map((p, i) => (i === idx ? { ...p, kind: e.target.value } : p)))
                }
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {k || "—"}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <Input
                inputMode="numeric"
                value={row.confidence}
                placeholder="置信 0-100"
                onChange={(e) =>
                  setEvidence((prev) => prev.map((p, i) => (i === idx ? { ...p, confidence: e.target.value } : p)))
                }
              />
            </div>
            <div className="col-span-3">
              <Input
                value={row.sourceUrl}
                placeholder="http(s) 链接（可空）"
                onChange={(e) =>
                  setEvidence((prev) => prev.map((p, i) => (i === idx ? { ...p, sourceUrl: e.target.value } : p)))
                }
              />
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEvidence((prev) => [...prev, emptyEvidence()])}>
            ＋ 加一条
          </Button>
          {evidence.length > 1 ? (
            <Button variant="ghost" size="sm" onClick={() => setEvidence((prev) => prev.slice(0, -1))}>
              删最后一条
            </Button>
          ) : null}
        </div>
      </div>

      <div className="pt-2 border-t border-dashed border-border grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hasEconomics} onChange={(e) => setHasEconomics(e.target.checked)} />
          已有经济性信号（粗口径亦可）
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={industryValuePresent}
            onChange={(e) => setIndustryValuePresent(e.target.checked)}
          />
          已确证产业价值
        </label>
        <div>
          <Label>一票否决项（逗号/换行分隔；留空即无）</Label>
          <Input
            value={disqualifiers}
            onChange={(e) => setDisqualifiers(e.target.value)}
            placeholder="如：许可证未核 / 被禁技术路线 / 无落地路径"
          />
        </div>
      </div>

      {err ? <div className="text-xs text-rose-600">{err}</div> : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
          清空
        </Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
          {busy ? "提交中…" : "提交并筛查"}
        </Button>
      </div>
    </div>
  );
}
