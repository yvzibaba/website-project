/**
 * 沙盘「动态报告」展示面板（中途重构 R6.1 · §9 动态报告 / §14 优先级第 5 项）。
 *
 * 纯展示：吃 `buildSandboxReport` 产出的结构化 `SandboxReport`（其数字全部来自引擎经视图模型投影，
 * 本组件不重算、不查网络），按 `section.kind` 渲染段落 / 键值条 / 要点，并把常驻免责与人工复核声明置顶。
 * 之所以单独成文件：报告体量大、结构固定，与参数控制台/图表区解耦，便于 R6.2 在其上叠加 AI 解释节。
 */

"use client";

import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import type { ReportSection, SandboxReport } from "@/lib/sandbox-report";

function SectionBlock({ section }: { section: ReportSection }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold text-zinc-800">{section.title}</h4>

      {section.kind === "bullets" && section.items ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {section.items.map((it, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 border-b border-dashed border-zinc-100 py-0.5">
              <dt className="text-xs text-zinc-500">{it.label}</dt>
              <dd className="text-sm font-medium tabular-nums text-zinc-800">{it.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {section.kind !== "bullets" && section.paragraphs ? (
        section.kind === "list" ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-zinc-600">
            {section.paragraphs.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-zinc-700">
            {section.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}

export function SandboxReportPanel({ report }: { report: SandboxReport }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">{report.title}</CardTitle>
            <CardDescription>
              由当前参数情景的引擎输出确定性生成（改参数即换整份报告）· 报告 v{report.reportVersion}
            </CardDescription>
          </div>
          {report.needsProfessionalReview ? <Badge variant="warning">需专业人工确认</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* 常驻免责（§16/§17：无论成败都在，防止被当决策依据） */}
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <ul className="flex flex-col gap-1 text-[11px] leading-snug text-amber-800">
            {report.disclaimers.map((d, i) => (
              <li key={i}>· {d.replace(/\*\*/g, "")}</li>
            ))}
          </ul>
        </div>

        {report.sections.map((s) => (
          <SectionBlock key={s.key} section={s} />
        ))}
      </CardContent>
    </Card>
  );
}
