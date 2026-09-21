/**
 * V2 决策报告 → 产业方案（Solution）草案 · 纯映射桥（R7-A · 商业闭环最小加性桥）。
 *
 * ## 它解决什么
 * V2 决策平台产出的 `DecisionReport`（14 节、确定性、可复算）此前**没有任何通往商品的出口**：
 * 只有 V1 沙盘能 `buildSolutionDraft`→落 DRAFT Solution→走「发布→下单→交付」。本模块补上 V2 那一侧
 * 对称的**只读投影**，让一份 V2 报告能导出成一条 `DRAFT` `Solution`，自动汇入既有
 * `createSolution`/`publishGuard`/`Order`/`hasPaidEntitlement` 商品链——**不新造任何商业系统**。
 *
 * ## 一条硬规则：只搬运，不重算（宪法第 7/16 条 · 财务口径冻结）
 *   - 输入全部是**已落库的真源**：`report`（引擎算好后冻存的格式化串）、`scenarioInput`（同一次快照回显）、
 *     `econ`（`decisionSnapshotToColumns` 与 report 同源一次 calc 写下的非丢失 Decimal 派生列）。
 *   - 本文件**不 import 任何 engine 运行时代码、不调 `runCalculation`、不做任何参与结论的运算**。
 *     连 `import` 都只用 `import type`（编译期擦除），确保运行期与引擎零耦合。
 *   - 因此「报告数字 == 商品数字」是**结构性事实**而非事后巧合：body 里的每个金额/百分比串**逐字等于**
 *     `report.sections` 对应 item/表行的串；`SolutionFinancial` 的 Decimal **等于** `econ` 派生列。
 *
 * ## 诚实边界（§16/§20 · 「不得把假设伪装成事实」）
 *   - 只读消费方：不触发重算、不改版本、不动任何写路径。
 *   - 失败态（`calcStatus !== "ok"` 或 report 缺失）直接回 `ok:false` + 阻塞项，**绝不给脏/未算情景
 *     编一份看起来能卖的方案**。
 *   - 草案恒 `evidenceGrade="ASSUMPTION"`、`needsProfessionalReview=true`，并产出机器可校验的
 *     `publishBlockers`（未挂案例 / 未定价 / 需专业确认 / 负 NPV）——在人工补真实数据 + 定价 + 过
 *     `publishGuard` 之前，方案**只能停在 DRAFT、绝不冒充可售**。工程侧永不自动升 FACT、永不自动定价/发布。
 *
 * ## 边界（刻意保守）
 *   - `Solution.caseId` 是必填非空外键——是否挂靠哪个案例、价格定多少属**人决策**，本模块只在缺它时
 *     记入 `publishBlockers`，绝不臆造。落库交由已测死的 `persistSolutionDraft` 守 DRAFT + FK 预检。
 *   - 正文 body 严格贴合 `solution-body.ts` 的 34 canonical key；`feasibility`/`diagnostics` 等无对应
 *     canonical 键的内容，连同**整份有序 sections** 一并存入 extra 键 `decisionReport`，保证全文保真、
 *     供详情页与后续离线工件（R7-B）逐节渲染。
 */

import type { DecisionReport, ScenarioInput } from "@app/kernel/engine/types";

/**
 * V2 报告→方案草案映射口径版本（分节映射 / 财务搬运规则变化须升版记因，宪法第 13 条）。
 * 1.0.0（R7-A）：首版。把 `DecisionReport` 的 14 节映射进 Solution 34 canonical 键 + `decisionReport` 全文
 *   extra；`SolutionFinancial` 直读同源 Decimal 派生列；恒 DRAFT / 恒 ASSUMPTION / 失败禁止导出。
 *   零 engine 运行时依赖、零重算。
 */
export const DECISION_TO_SOLUTION_VERSION = "1.0.0";

/** 本仓 V1 唯一深耕的行业叙事（照 PRODUCT_SPEC，非六行业铺量）。 */
const INDUSTRY_LABEL = "新能源重卡 + 光伏 + 储能 + 充电一体化场站";

/* ────────────────────────────── 类型 ────────────────────────────── */

/** 与 report 同源一次 calc 落下的非丢失 Decimal 派生列（单位：元 / 百分数 / 年 / 元·kWh⁻¹ / 比值）。 */
export interface DecisionEconColumns {
  capexNetYuan: number | null;
  npvYuan: number | null;
  /** 全投资 IRR，百分数（如 24.3553）。 */
  irrPct: number | null;
  paybackYears: number | null;
  /** 全投资 ROI，比值（如 1.85 表示 185%）。 */
  roiRatio: number | null;
  lcoeYuanPerKwh: number | null;
  npvEquityYuan: number | null;
  /** 资本金 IRR，百分数。 */
  irrEquityPct: number | null;
}

/** 财务条目：与 `solution-admin.SolutionFinancialInput` 同形（Decimal 十进制串、非负；缺失/负 → 省略）。 */
export interface DraftFinancial {
  capex?: string;
  roiPct?: string;
  irrPct?: string;
  paybackYears?: string;
  currency?: string;
  assumptions?: Record<string, unknown>;
  calcRef?: string;
  note?: string;
}

/** 关键未知变量：与 `solution-admin.SolutionUnknownInput` 同形。 */
export interface DraftUnknown {
  name: string;
  impact?: string;
  howToResolve?: string;
  severity?: number;
}

export interface DecisionSolutionDraftInput {
  /** 已落库的决策报告（含 provenance + 格式化数字 + disclaimer）。 */
  report: DecisionReport | null;
  /** 同一次快照回显的情景输入（`report.inputSnapshot` 的等价物，供叙述性字段）。 */
  scenarioInput?: ScenarioInput | null;
  /** 与 report 同源一次的 Decimal 派生列（喂 SolutionFinancial；非重算）。 */
  econ: DecisionEconColumns;
  /** 该情景最近一次计算状态（`ok` 才允许导出）。 */
  calcStatus: string;
  /** 情景名（来自 ProjectScenario.name）。 */
  scenarioName?: string;
  /** 情景当前版本号（来自 ProjectScenario.version，仅溯源展示，不参与数字）。 */
  scenarioVersion?: number;
  /** 人拟定的对外价格（十进制串，可空 → 记入发布阻塞项）。 */
  price?: string;
  currency?: string;
  /** 人已指定的挂靠案例 ID（可空 → 记入发布阻塞项；本模块不查库不校验存在性，FK 由 persistSolutionDraft 兜底）。 */
  caseId?: string;
}

export interface DecisionSolutionDraftOk {
  ok: true;
  draftVersion: string;
  solutionCalcRef: string;
  title: string;
  slug: string;
  summary: string;
  /** canonical 34 分节 key → 内容（仅填报告能确证者），另含整份报告全文于 `decisionReport` extra。 */
  body: Record<string, unknown>;
  financials: DraftFinancial[];
  unknowns: DraftUnknown[];
  riskDomains: string[];
  needsProfessionalReview: true;
  evidenceGrade: "ASSUMPTION";
  price?: string;
  currency: string;
  /** 溯源（搬运自 report.provenance），供 UI 显性展示与审计。 */
  provenance: DecisionReport["provenance"];
  /** 机器可校验的发布前阻塞清单：非空即「尚不可对外发布/售卖」。 */
  publishBlockers: string[];
}

export interface DecisionSolutionDraftErr {
  ok: false;
  draftVersion: string;
  solutionCalcRef: string;
  error: { reason: string; detail: string };
  publishBlockers: string[];
}

export type DecisionSolutionDraft = DecisionSolutionDraftOk | DecisionSolutionDraftErr;

/* ────────────────────────────── 内部工具（全部零重算） ────────────────────────────── */

function bad(x: number | null | undefined): boolean {
  return x == null || !Number.isFinite(x);
}

/** 十进制非负串（≤6 位小数以过 `DecimalStringSchema`）；负/非有限 → undefined（省略而非造假）。 */
function decimalOr(n: number | null | undefined, dp: number): string | undefined {
  if (bad(n)) return undefined;
  const v = n as number;
  if (v < 0) return undefined; // SolutionFinancial Decimal 禁负号；负值改由 assumptions/正文承载
  return v.toFixed(dp);
}

/** slug 安全化：仅 [a-z0-9-]，段间单连字符、无首尾连字符（贴合 `SlugSchema`）。 */
function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
  return s || "decision-solution-draft";
}

/** 按 label 精确取某节某个 key-value 项（搬运格式化串，非重算）。 */
function findItem(report: DecisionReport, sectionId: string, label: string) {
  const sec = report.sections.find((s) => s.id === sectionId);
  return sec?.items?.find((it) => it.label === label);
}

/** 把某节 key-value items 渲染成「label：value」行数组（仅格式化，值取自 report 原串）。 */
function itemsToLines(report: DecisionReport, sectionId: string): string[] {
  const sec = report.sections.find((s) => s.id === sectionId);
  return (sec?.items ?? []).map((it) => (it.hint ? `${it.label}：${it.value}（${it.hint}）` : `${it.label}：${it.value}`));
}

/** 把某节 table 渲染成「列 | 列」行数组（去 markdown 星号，值取自 report 原串）。 */
function tableToLines(report: DecisionReport, sectionId: string): string[] {
  const sec = report.sections.find((s) => s.id === sectionId);
  const t = sec?.table;
  if (!t) return [];
  const head = t.columns.join(" | ");
  const rows = t.rows.map((r) => r.map((c) => c.replace(/\*\*/g, "")).join(" | "));
  return [head, ...rows];
}

function decisionDraftCalcRef(): string {
  return `decision-solution@${DECISION_TO_SOLUTION_VERSION}`;
}

/* ────────────────────────────── 主装配 ────────────────────────────── */

/**
 * 组装 V2 产业方案草案。**只在 `calcStatus==="ok"` 且 report 存在时产出**；否则诚实回 `ok:false` + 阻塞项，
 * 绝不给未算通 / 快照缺失的情景编一份看起来能卖的方案。全过程零 engine 调用、零重算。
 */
export function buildSolutionDraftFromDecision(input: DecisionSolutionDraftInput): DecisionSolutionDraft {
  const solutionCalcRef = decisionDraftCalcRef();
  const { report, econ, calcStatus } = input;

  // 失败 / 无报告：透传诚实状态，不产出任何正文 / 财务。
  if (calcStatus !== "ok" || !report) {
    const reason = calcStatus === "ok" ? "report_missing" : calcStatus;
    return {
      ok: false,
      draftVersion: DECISION_TO_SOLUTION_VERSION,
      solutionCalcRef,
      error: {
        reason,
        detail:
          calcStatus === "ok"
            ? "该情景结果快照缺失决策报告字段（可能由历史版本写入），请重算后再导出。"
            : `该情景最近一次计算未通过（状态：${calcStatus}），无有效报告，禁止导出为商品。`,
      },
      publishBlockers: [
        "尚无通过校验的决策报告，方案不可生成，更不可发布",
        "须先让引擎对该情景算出有效结果（calcStatus=ok）后再导出",
      ],
    };
  }

  const p = report.provenance;
  const name = input.scenarioName?.trim() || p.scenarioLabel || "决策项目";
  const versionTag = input.scenarioVersion != null ? ` · v${input.scenarioVersion}` : "";
  const title = `${report.title}${versionTag}`;
  const slug = slugify(`${name}-${p.scenarioId}`);

  /* —— 正文：逐节从 report 搬运 / 格式化，绝不重算 —— */
  const body: Record<string, unknown> = {};

  body.name = title;
  body.industry = INDUSTRY_LABEL;
  body.targetEnterprises =
    "通用（未选择企业画像；本平台支持车队 / 充电运营商 / 园区 / 公交 / 投资人等画像裁剪，此处为决策报告的直接投影）。";
  body.coreProblem = (report.sections.find((s) => s.id === "summary")?.paragraphs ?? [report.title]).join("\n\n");

  // 能源 / 设备（逐时引擎口径的呈现层，值取自报告原串）
  const demand = itemsToLines(report, "truck-demand");
  const energy = itemsToLines(report, "energy-system");
  const charging = itemsToLines(report, "charging");
  if (demand.length || energy.length) body.energy = [...demand, ...energy];
  if (charging.length) body.equipment = charging;

  // 成本 / 收入 / 回报 / 回收期（全部搬运 economics-* 节的格式化串，不换算、不反解）
  body.costModel = tableToLines(report, "economics-capex");
  const rev = findItem(report, "economics-metrics", "首年收入");
  body.revenueModel = rev ? `首年收入：${rev.value}${rev.hint ? `（${rev.hint}）` : ""}` : undefined;
  const roi = findItem(report, "economics-metrics", "全周期投资回报率 ROI");
  body.roi = roi ? `全周期投资回报率 ROI：${roi.value}` : undefined;
  const paybackD = findItem(report, "economics-metrics", "折现回收期");
  const paybackS = findItem(report, "economics-metrics", "静态回收期");
  body.payback =
    paybackD || paybackS
      ? `折现回收期：${paybackD?.value ?? "—"}；静态回收期：${paybackS?.value ?? "—"}。`
      : undefined;
  body.sensitivity = tableToLines(report, "sensitivity");

  // 风险 + 免责（disclaimer 契约字段，随正文走、不裁剪）
  const riskLines = tableToLines(report, "risks");
  body.riskAnalysis = [...riskLines, "", report.disclaimer];

  body.implementationConditions =
    "落地前须以来源可追溯的真实电价、光照 / 等效小时、补贴与上网政策、设备与土建造价、车队补能负荷等数据替换报告「关键假设」中标注为低置信度的取值，并由具备资质机构以实际合同价与结算单价复核后方可用于投资决策。";

  // 关键未知（从「必须人工确认的关键假设」表逐行搬运，severity 由置信度反推——表示变换非重算）
  const assumSec = report.sections.find((s) => s.id === "critical-assumptions");
  const unknowns: DraftUnknown[] = [];
  if (assumSec?.table) {
    for (const row of assumSec.table.rows) {
      const [label, value, evidenceKind, confidence, impact] = row;
      const conf = Number.parseInt(String(confidence ?? "").split("/")[0], 10);
      const severity = Number.isFinite(conf) ? Math.max(0, Math.min(100, 100 - conf)) : 60;
      unknowns.push({
        name: `${label ?? "假设"}（本次取值 ${value ?? "—"}，${evidenceKind ?? "?"}）`,
        impact: impact ?? "",
        howToResolve: "接入来源可追溯的真实数据、人工逐项核实，把该取值从低置信度假设升级为已核实事实并留存可点击来源。",
        severity,
      });
    }
  }
  if (bad(econ.npvYuan) || (econ.npvYuan as number) < 0) {
    unknowns.push({
      name: "净现值 NPV 非正或缺失",
      impact: `当前投影 NPV=${econ.npvYuan == null ? "不可计算" : econ.npvYuan.toFixed(2)} 元，作商业发布须重点复核。`,
      howToResolve: "核对收入 / 成本假设与并网、负荷口径；必要时延长分析期。",
      severity: 75,
    });
  }
  body.unknowns = unknowns.map((u) => `${u.name}：${u.impact ?? ""}`);

  // 结论倾向（推荐 / 顾虑）→ bull/bear（值取自 recommendation bullets 原串）
  const recBullets = report.sections.find((s) => s.id === "recommendation")?.bullets ?? [];
  body.bullCase = recBullets.filter((b) => b.startsWith("【支持】"));
  body.bearCase = recBullets.filter((b) => b.startsWith("【关注】"));

  body.nextActions = report.sections.find((s) => s.id === "next-steps")?.bullets ?? [];

  // 溯源 + AI 标注（把草案钉回报告与其指纹，供审计与可信度判定）
  body.sources = itemsToLines(report, "provenance");
  body.aiAnnotations =
    "本方案的每一个数字均由 V2 逐时决策引擎计算、经决策报告格式化呈现；导出仅**搬运报告串与同源 Decimal 派生列**，" +
    "不重算、不改写任何数字。证据等级：示例·待核实（报告「关键假设」列示的低置信度取值未经逐项核实前不得当作事实）。";

  // 整份报告全文（有序 14 节 + provenance + disclaimer）保真存档，供详情页 / R7-B 离线工件逐节渲染。
  body.decisionReport = {
    reportVersion: report.reportVersion,
    provenance: p,
    disclaimer: report.disclaimer,
    sections: report.sections,
  };

  /* —— 财务条目：Decimal 串一律等于同源派生列（搬运非重算），负 / 算不出即省略 —— */
  const financial: DraftFinancial = {
    capex: decimalOr(econ.capexNetYuan, 2),
    roiPct: econ.roiRatio != null && econ.roiRatio >= 0 ? (econ.roiRatio * 100).toFixed(2) : undefined,
    irrPct: decimalOr(econ.irrPct, 4),
    paybackYears: decimalOr(econ.paybackYears, 2),
    currency: input.currency ?? "CNY",
    calcRef: solutionCalcRef,
    assumptions: {
      // 原值（含负 / null）留在 assumptions，供审计与复算比对；Decimal 列只承载非负部分。
      npvYuan: econ.npvYuan,
      roiRatio: econ.roiRatio,
      irrPct: econ.irrPct,
      paybackYears: econ.paybackYears,
      lcoeYuanPerKwh: econ.lcoeYuanPerKwh,
      npvEquityYuan: econ.npvEquityYuan,
      irrEquityPct: econ.irrEquityPct,
      evidenceKind: "ASSUMPTION",
      source: "V2 DecisionReport 投影（数字搬运非重算）",
      methodology: "Path-B 逐时引擎决策报告 → Solution 草案",
      provenance: p,
      scenarioVersion: input.scenarioVersion ?? null,
      solutionCalcRef,
    },
    note:
      "数字直接搬运自与本报告同源一次计算落下的 Decimal 派生列，未二次换算；为负或算不出的指标已省略并登记于关键未知 / 发布阻塞项。" +
      "关键假设多为低置信度取值，属示例·待核实，须人工以真实数据复核后方可用于投资决策。",
  };

  /* —— 发布阻塞项：机器可校验，把「尚不可售卖」钉成产物（§16 / 总控）—— */
  const publishBlockers: string[] = [
    "决策报告的关键假设多为低置信度取值（报告「必须人工确认的关键假设」节已逐条列示），须以来源可追溯的真实数据替换并复核后方可对外发布 / 售卖",
    "需专业人工确认：电力 / 新能源属高风险领域，AI 与本报告只做解读，关键决策由人做出",
  ];
  if (!input.price || input.price.trim() === "") {
    publishBlockers.push("尚未设定对外价格（发布上架前必填）");
  }
  if (bad(econ.npvYuan) || (econ.npvYuan as number) < 0) {
    publishBlockers.push("按当前参数 NPV 为非正或缺失，作商业发布须重点复核");
  }
  // caseId 由人指定（必填外键）；缺失不阻断生成草案，但阻断发布——交由 persistSolutionDraft/createSolution 的 FK 预检兜底。
  if (!input.caseId || input.caseId.trim() === "") {
    publishBlockers.push("决策方案须挂靠一个已存在的产业案例（Case）才能进入发布 / 购买闭环——导出时须指定 caseId");
  }

  const riskDomains = ["投资", "能源", "政策"];

  const summary =
    `基于 V2 项目决策报告（${p.scenarioLabel}）生成的「${INDUSTRY_LABEL}」产业方案草案。` +
    `核心结论（均搬运自报告、未重算）：净 CAPEX ${econ.capexNetYuan == null ? "—" : (econ.capexNetYuan / 10000).toFixed(1) + " 万元"}、` +
    `NPV ${econ.npvYuan == null ? "不可计算" : (econ.npvYuan / 10000).toFixed(1) + " 万元"}、` +
    `IRR ${econ.irrPct == null ? "不可计算" : econ.irrPct.toFixed(2) + "%"}、` +
    `折现回收期 ${econ.paybackYears == null ? "期内未回本" : econ.paybackYears.toFixed(2) + " 年"}。` +
    `引擎 ${p.engineVersion} · 模型 ${p.modelVersion} · 基准 ${p.benchmarkVersion} · 指纹 ${p.inputHash}。` +
    "所有数字为程序计算并经报告呈现、入参多为示例假设、需专业人工确认。";

  return {
    ok: true,
    draftVersion: DECISION_TO_SOLUTION_VERSION,
    solutionCalcRef,
    title,
    slug,
    summary,
    body,
    financials: [financial],
    unknowns,
    riskDomains,
    needsProfessionalReview: true,
    evidenceGrade: "ASSUMPTION",
    price: input.price && input.price.trim() !== "" ? input.price.trim() : undefined,
    currency: input.currency ?? "CNY",
    provenance: p,
    publishBlockers,
  };
}
