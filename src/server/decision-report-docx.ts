/**
 * V2 决策报告 → DOCX 离线交付工件（R7-B · 高速连续自治推进）。
 *
 * ## 它是什么
 * **一份纯投影**：把已经落库、经过黄金回归与 provenance 校验的 `DecisionReport`（14 节 + provenance +
 * disclaimer）**逐字**渲染成 DOCX。DOCX 只是 DecisionReport 的**离线表现形式**，不是新的报告生成器、
 * 也不是新的财务算法。所有数字来自冻结 Report；本文件不调 `runCalculation`、不查库重算、不做任何参与
 * 结论的运算。宪法第 7/16 条：程序算 > LLM 口算；单一计算真源。
 *
 * ## 为什么放在宿主（src/server）而非 kernel
 * kernel 只允许 `zod` / `@prisma/client` / `node:*` 外部依赖（`.kernel-tools/verify_kernel.mjs` 白名单）。
 * `docx` 是**呈现层**依赖，属宿主关注点，与「换底座不动内核」主张同层。类型仍从
 * `@app/kernel/engine/types` import（type-only，运行期擦除）。
 *
 * ## 数字一致性保证（mandate R7-B-2）
 * 「同源字段一致」的结构性事实：Report 内每一项都是**已经格式化好的字符串**（引擎产出的成品串），
 * DOCX 层只做「搬运 + 排版」，不做二次格式化、不做二次四舍五入、不做单位换算。故测试可直接在解压后的
 * `word/document.xml` 纯文本里逐串搜到——不需要靠"看起来一样"来验收。null/空串 → "—"（诚实占位），
 * 已明确的 `UNKNOWN` / `ASSUMPTION` / `FACT` / `DERIVED` / `ACTUAL` 字面保留，绝不把 ASSUMPTION 写成 FACT。
 *
 * ## 文件身份（mandate R7-B-5）
 * `ProjectName_DecisionReport_Vx.docx`：项目名（回落 scenarioLabel）+ 情景版本号驱动，**不用当前日期**，
 * 保证同一 ProjectVersion 每次导出文件名一致、不同 ProjectVersion 文件名相异，历史不覆盖。
 *
 * ## 安全边界（mandate R7-B-6 由调用方路由保证）
 * 本文件本身**不做鉴权**，与 `orders.ts` / `solution-admin.ts` 同构：只搬运不判断。登录、ownership、
 * entitlement、staff 全部由 HTTP 路由层负责（`/api/workbench/decision/scenarios/[id]/export/docx`
 * 与 `/api/solutions/[id]/export/docx`）。
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ISectionOptions,
} from "docx";
import type { DecisionReport, ReportSection } from "@app/kernel/engine/types";

/**
 * DOCX 投影层口径版本（分节呈现规则 / 元信息字段变化须升版记因，宪法第 13 条）。
 * 1.0.0（R7-B）：首版。14 节按 kind 分派（paragraph/key-values/bullets/table）；元信息 10 项钉死
 *   （Project/Scenario/ScenarioVersion/ScenarioId/EngineVersion/ModelVersion/BenchmarkVersion/
 *    ScenarioSchemaVersion/InputHash/ReportGeneratedAtIso + Disclaimer 常驻尾注）。null→"—"。
 *   零 engine 运行时依赖、零重算。
 */
export const DECISION_REPORT_DOCX_VERSION = "1.0.0";

const DASH = "—";

/**
 * DOCX 只需要 `DecisionReport` 里**被渲染到的**那一子集（不消费 `inputSnapshot`，因其字段全在
 * sections/economics 等已呈现项里逐字重现）。Solution 侧从 `body.extras.decisionReport` 重建
 * 报告时（R7-A 存的 extras 就没 inputSnapshot），可原样喂给本函数——**不假装它有**。
 */
export interface ReportForDocx {
  reportVersion: string;
  title?: string;
  provenance: DecisionReport["provenance"];
  sections: ReportSection[];
  disclaimer: string;
}

export interface DocxBuildInput {
  /** 冻结的报告对象——每个数字都已由引擎格式化成字符串，本函数只做搬运。 */
  report: ReportForDocx;
  /** 项目名（优先用于文件名 / 元信息）；缺省回落 provenance.scenarioLabel。 */
  projectName?: string | null;
  /** 情景名（可选，用于元信息）；缺省回落 provenance.scenarioLabel。 */
  scenarioName?: string | null;
  /** 情景版本号（`ProjectScenario.version`），驱动文件名 Vx 段。null / 非有限 → `vUnknown`。 */
  scenarioVersion?: number | null;
  /** ScenarioInput 契约版本（`SCENARIO_SCHEMA_VERSION`），元信息第 6 项。 */
  scenarioSchemaVersion?: string | null;
  /** 追加元信息（如 Solution 侧下载时挂"方案 ID / 方案标题"，不与内建 10 项冲突）。 */
  extraMeta?: Array<[string, string]>;
  /** 标题覆盖（默认 `${provenance.scenarioLabel} · 项目决策报告` 与引擎 report.ts 同构）。 */
  titleOverride?: string | null;
}

export interface DocxBuildResult {
  /** OOXML 字节流。 */
  buffer: Uint8Array;
  /** `ProjectName_DecisionReport_Vx.docx`（文件名安全化后）。 */
  filename: string;
  /** 本次导出触发时刻（仅记入页眉"导出时间"，**不参与文件名**——文件名恒由 ProjectVersion 定，防日期覆盖历史）。 */
  exportedAtIso: string;
}

/* ─────────────────────────── 文件名 ─────────────────────────── */

/**
 * `ProjectName_DecisionReport_Vx.docx`（mandate §R7-B-5）。
 *   - 项目名回落链：projectName → scenarioName → provenance.scenarioLabel → fallback → "DecisionReport"；
 *   - 版本号：有限非负整数 → `v<N>`；否则 `vUnknown`（**绝不**用当前日期兜底，避免"日期覆盖历史"）；
 *   - Windows/macOS/Linux 通用文件名安全化：剔除 `\ / : * ? " < > |` 与控制字符、折叠空白、截断 80。
 */
export function buildDecisionReportFilename(
  input: Pick<DocxBuildInput, "projectName" | "scenarioName"> & {
    scenarioLabel?: string | null;
    scenarioVersion?: number | null;
    fallback?: string;
  },
): string {
  const raw =
    input.projectName?.trim() ||
    input.scenarioName?.trim() ||
    input.scenarioLabel?.trim() ||
    input.fallback?.trim() ||
    "DecisionReport";
  const v =
    typeof input.scenarioVersion === "number" && Number.isFinite(input.scenarioVersion) && input.scenarioVersion >= 0
      ? `v${Math.trunc(input.scenarioVersion)}`
      : "vUnknown";
  return `${sanitizeFilename(raw)}_DecisionReport_${v}.docx`;
}

function sanitizeFilename(s: string): string {
  return (
    s
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "DecisionReport"
  );
}

/* ─────────────────────────── 主入口 ─────────────────────────── */

/**
 * 纯投影：DecisionReport → DOCX Buffer。零 engine 运行时 import、零重算、零 DB。
 * `Packer.toBuffer` 是 async（内部走 zip）；调用方 `await` 即可。
 */
export async function buildDecisionReportDocx(input: DocxBuildInput): Promise<DocxBuildResult> {
  const { report } = input;
  const p = report.provenance;
  const exportedAtIso = new Date().toISOString();

  const children: Array<Paragraph | Table> = [];

  // 封面标题（与 report.ts 默认标题同构；调用方若给了 Solution 标题可覆盖）
  const titleText =
    input.titleOverride?.trim() || report.title?.trim() || `${p.scenarioLabel} · 项目决策报告`;
  children.push(new Paragraph({ text: titleText, heading: HeadingLevel.TITLE }));
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `导出时间：${formatDateTime(exportedAtIso)} · DOCX 投影层版本：${DECISION_REPORT_DOCX_VERSION}`,
          italics: true,
          size: 18,
        }),
      ],
    }),
  );

  /* ── 元信息（10 项钉死 + 追加项） ── */
  children.push(new Paragraph({ text: "报告溯源（Reproducible Provenance）", heading: HeadingLevel.HEADING_1 }));
  const meta: Array<[string, string]> = [
    ["项目 / Project", input.projectName?.trim() || p.scenarioLabel || DASH],
    ["情景 / Scenario", input.scenarioName?.trim() || p.scenarioLabel || DASH],
    ["情景版本 / Scenario Version", fmtVersion(input.scenarioVersion)],
    ["情景 ID / Scenario ID", p.scenarioId || DASH],
    ["Engine 版本 / Engine Version", p.engineVersion || DASH],
    ["Model 版本 / Model Version", p.modelVersion || DASH],
    ["Benchmark 版本 / Benchmark Version", p.benchmarkVersion || DASH],
    ["Scenario Schema 版本", input.scenarioSchemaVersion?.trim() || DASH],
    ["Input Hash", p.inputHash || DASH],
    ["报告契约版本 / Report Version", report.reportVersion || DASH],
    ["时间步长（分钟）/ Time Step", String(p.timeStepMinutes)],
    ["报告生成时刻 / Generated At", formatDateTime(p.generatedAtIso)],
    ...(input.extraMeta ?? []),
  ];
  children.push(kvTable(meta));

  /* ── 14 节主内容（顺序即 report.sections 顺序） ── */
  for (const section of report.sections) {
    for (const node of renderSectionChildren(section)) children.push(node);
  }

  /* ── 免责声明（不得省略；宪法第 20 条诚实） ── */
  children.push(new Paragraph({ text: "免责声明", heading: HeadingLevel.HEADING_1 }));
  children.push(
    new Paragraph({
      children: [new TextRun({ text: report.disclaimer || DASH, size: 20 })],
    }),
  );

  const sectionOptions: ISectionOptions = { properties: {}, children };
  const doc = new Document({
    title: titleText,
    description: `V2 决策报告离线导出（DOCX 投影层 ${DECISION_REPORT_DOCX_VERSION}）——同源数字、不重算。`,
    creator: "website-v2 · R7-B",
    styles: { default: { document: { run: { font: "Microsoft YaHei", size: 22 } } } },
    sections: [sectionOptions],
  });

  const buf = await Packer.toBuffer(doc);
  return {
    buffer: new Uint8Array(buf),
    filename: buildDecisionReportFilename({
      projectName: input.projectName,
      scenarioName: input.scenarioName,
      scenarioLabel: p.scenarioLabel,
      scenarioVersion: input.scenarioVersion,
    }),
    exportedAtIso,
  };
}

/* ─────────────────────────── 分节渲染 ─────────────────────────── */

function renderSectionChildren(section: ReportSection): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  out.push(new Paragraph({ text: section.title || DASH, heading: HeadingLevel.HEADING_2 }));

  if (section.kind === "paragraph" && section.paragraphs?.length) {
    for (const para of section.paragraphs) {
      out.push(new Paragraph({ children: [new TextRun({ text: cellOrDash(para), size: 22 })] }));
    }
    return out;
  }
  if (section.kind === "key-values" && section.items?.length) {
    const rows: Array<[string, string]> = section.items.map((it) => {
      const valueCell = cellOrDash(it.value) + (it.hint ? `（${it.hint}）` : "");
      return [cellOrDash(it.label), valueCell];
    });
    out.push(kvTable(rows));
    out.push(new Paragraph({ text: "" }));
    return out;
  }
  if (section.kind === "bullets" && section.bullets?.length) {
    for (const b of section.bullets) {
      out.push(new Paragraph({ text: cellOrDash(b), bullet: { level: 0 } }));
    }
    return out;
  }
  if (section.kind === "table" && section.table) {
    const { columns, rows } = section.table;
    const trs: TableRow[] = [];
    trs.push(
      new TableRow({
        tableHeader: true,
        children: columns.map(
          (c) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cellOrDash(c), bold: true, size: 20 })] })],
            }),
        ),
      }),
    );
    for (const r of rows) {
      trs.push(
        new TableRow({
          children: r.map(
            (cell) =>
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: cellOrDash(cell), size: 20 })] })],
              }),
          ),
        }),
      );
    }
    out.push(new Table({ rows: trs, width: { size: 100, type: WidthType.PERCENTAGE } }));
    out.push(new Paragraph({ text: "" }));
    return out;
  }
  // 空节：诚实占位（不隐藏）
  out.push(new Paragraph({ children: [new TextRun({ text: `${DASH}（本节无内容）`, italics: true, size: 20 })] }));
  return out;
}

function kvTable(rows: Array<[string, string]>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      ([k, v]) =>
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cellOrDash(k), bold: true, size: 20 })] })],
            }),
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cellOrDash(v), size: 20 })] })],
            }),
          ],
        }),
    ),
  });
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function cellOrDash(s: unknown): string {
  if (s === null || s === undefined) return DASH;
  const str = typeof s === "string" ? s : String(s);
  const t = str.trim();
  return t === "" ? DASH : str;
}

function fmtVersion(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return DASH;
  return String(Math.trunc(v));
}

/** `2026-09-21 14:05:07 (Asia/Shanghai)` — 只影响页眉「导出时间」一行；文件名不用它。 */
function formatDateTime(iso: string): string {
  if (!iso) return DASH;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "Asia/Shanghai",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
