"use client";

/**
 * V2 决策报告视图：把落库的 `DecisionReport`（有序章节数组）渲染出来。
 *
 * 设计原则：**只渲染，不再计算**。
 *   报告里的每个数字都来自引擎快照（`GET /api/workbench/decision/scenarios/:id/report`），
 *   本组件不做任何求和、换算或格式化之外的加工。一旦这里开始"顺手算一下"，
 *   报告与详情页就会各说一套——那是本项目最不能接受的失败方式。
 *
 * 报告头（provenance）单独突出展示：它回答了「这份结论是怎么来的、能不能复算」，
 * 是这份报告能被当作留档材料的**前提**，而不是装饰性的元数据。
 */

import { Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui";
import { SimpleTable } from "./primitives";

export interface ReportSectionData {
  id: string;
  title: string;
  kind: "paragraph" | "key-values" | "bullets" | "table";
  paragraphs?: string[];
  items?: Array<{ label: string; value: string; hint?: string }>;
  bullets?: string[];
  table?: { columns: string[]; rows: string[][] };
}

export interface DecisionReportData {
  reportVersion: string;
  title: string;
  provenance: {
    scenarioId: string;
    scenarioLabel: string;
    engineVersion: string;
    modelVersion: string;
    inputHash?: string;
    benchmarkVersion?: string;
    generatedAtIso?: string;
  };
  sections: ReportSectionData[];
  disclaimer?: string;
}

function SectionBody({ section }: { section: ReportSectionData }) {
  if (section.kind === "paragraph") {
    return (
      <div className="flex flex-col gap-2">
        {(section.paragraphs ?? []).map((p, i) => (
          <p key={i} className="text-sm leading-relaxed">
            {p}
          </p>
        ))}
      </div>
    );
  }
  if (section.kind === "key-values") {
    return (
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {(section.items ?? []).map((it, i) => (
          <div key={i} className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/20 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{it.label}</dt>
            <dd className="text-sm font-medium tabular-nums">{it.value}</dd>
            {it.hint ? <span className="text-xs text-muted-foreground">{it.hint}</span> : null}
          </div>
        ))}
      </dl>
    );
  }
  if (section.kind === "bullets") {
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
        {(section.bullets ?? []).map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    );
  }
  if (section.kind === "table" && section.table) {
    return <SimpleTable columns={section.table.columns} rows={section.table.rows} />;
  }
  return <p className="text-sm text-muted-foreground">（本段暂无可展示内容）</p>;
}

export function DecisionReportView({ report }: { report: DecisionReportData }) {
  const p = report.provenance;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{report.title}</CardTitle>
        <p className="text-sm text-muted-foreground">
          报告版本 {report.reportVersion} · 情景「{p.scenarioLabel}」
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* 报告头：可复算所需的全部指纹 */}
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">溯源信息（凭这些可以独立复算）</div>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">情景标识</dt>
              <dd className="font-mono">{p.scenarioId}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">计算引擎</dt>
              <dd className="font-mono">{p.engineVersion}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">模型版本</dt>
              <dd className="font-mono">{p.modelVersion}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">基准参数版本</dt>
              <dd className="font-mono">{p.benchmarkVersion ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">输入指纹</dt>
              <dd className="font-mono">{p.inputHash ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">生成时刻</dt>
              <dd className="font-mono">{p.generatedAtIso ?? "—"}</dd>
            </div>
          </dl>
        </div>

        {report.sections.map((s) => (
          <div key={s.id} className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">{s.title}</h3>
            <SectionBody section={s} />
          </div>
        ))}

        {report.disclaimer ? (
          <>
            <Separator />
            <p className="text-xs leading-relaxed text-muted-foreground">{report.disclaimer}</p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
