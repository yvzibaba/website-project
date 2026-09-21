/**
 * R7-A · V2 决策报告 → 产业方案草案 纯映射桥的单测。
 *
 * 关键锁定（宪法 §7/§16/§20 · 创始人「只搬运不重算」硬约束）：
 *   1) 失败/无报告：`ok:false` + 阻塞项，绝不产出可售正文/财务；
 *   2) 成功：`SolutionFinancial` 的 Decimal 串逐字等于同源 econ 派生列（搬运非重算）；
 *      body 里的金额/百分比串逐字取自 report.sections 的对应 item/table；
 *   3) 恒 `evidenceGrade="ASSUMPTION"`、`needsProfessionalReview=true`，publishBlockers 覆盖四类固有阻塞
 *      （低置信度假设 / 需专业人工确认 / 未定价 / 未挂案例）；负 NPV 追加为额外阻塞；
 *   4) `body.decisionReport` 全文保真（reportVersion/provenance/disclaimer/sections 与源逐字段等）；
 *   5) provenance 原样回带（UI 溯源展示的唯一来源）；
 *   6) **反算依赖守卫**：源文件不得 import engine 运行时（只允许 `import type`），
 *      不得引用 `runCalculation`/`buildDecisionReport` 等计算符号——把「不重算」钉成结构事实。
 *
 * 用**手工构造的 fixture**（对齐 kernel/src/engine/report.ts 的 14 节 id/label 与串格式）而非直接跑引擎，
 * 让「数字逐字搬运」的断言在纯字符串层完成，独立于引擎版本演进；引擎→报告→草案的端到端另在
 * 集成测 `tests/integration/decision-export.test.ts` 里跑真库+真引擎证。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildSolutionDraftFromDecision,
  DECISION_TO_SOLUTION_VERSION,
  type DecisionEconColumns,
  type DecisionSolutionDraftInput,
} from "@app/kernel/lib/decision-to-solution";
import type { DecisionReport, ScenarioInput } from "@app/kernel/engine/types";

/* ─────────────────────────── fixture 构造 ─────────────────────────── */

const PROVENANCE = {
  scenarioId: "cabc123scenario",
  scenarioLabel: "基准情景",
  engineVersion: "engine@2.0.0",
  modelVersion: "model@1.5.0",
  benchmarkVersion: "benchmark@1.0.0",
  inputHash: "sha256:abcdef0123456789",
  timeStepMinutes: 60,
  generatedAtIso: "2026-09-21T08:00:00.000Z",
};

function makeReport(overrides: Partial<DecisionReport> = {}): DecisionReport {
  const sections: DecisionReport["sections"] = [
    {
      id: "summary",
      title: "一、执行摘要",
      kind: "paragraph",
      paragraphs: ["本项目 NPV 444.86 万元、IRR 24.35%，方案经济上成立。"],
    },
    {
      id: "feasibility",
      title: "二、可行性判定",
      kind: "paragraph",
      paragraphs: ["可行（推荐推进）。"],
    },
    {
      id: "recommendation",
      title: "三、推荐意见",
      kind: "paragraph",
      paragraphs: ["推荐推进。"],
      bullets: ["【支持】NPV 为正、IRR 高于折现率", "【关注】关键假设多为低置信度取值"],
    },
    {
      id: "critical-assumptions",
      title: "四、必须人工确认的关键假设",
      kind: "table",
      table: {
        columns: ["参数", "本次取值", "证据等级", "置信度", "若不成立会怎样"],
        rows: [
          ["光伏等效利用小时", "1,500.000 h", "ASSUMPTION", "40/100", "发电量按比例下降"],
          ["峰谷价差", "0.80 元/kWh", "ASSUMPTION", "35/100", "储能套利收益归零"],
        ],
      },
    },
    {
      id: "truck-demand",
      title: "五、车队与用能需求",
      kind: "key-values",
      items: [
        { label: "车队规模", value: "50 辆（额定载重 28.0 吨）" },
        { label: "年用能需求（电网侧口径）", value: "365.0 万 kWh", hint: "已含充电链路与换电损耗" },
      ],
    },
    {
      id: "charging",
      title: "六、充电与换电",
      kind: "key-values",
      items: [
        { label: "补能方式", value: "充电为主" },
        { label: "充电桩", value: "10 台 × 240 kW（装机 2.4 MW，同时率 70% → 有效 1.7 MW）" },
      ],
    },
    {
      id: "energy-system",
      title: "七、光伏与储能",
      kind: "key-values",
      items: [
        { label: "光伏装机", value: "1,000 kWp（倾角 25°、方位 180°）" },
        { label: "储能配置", value: "500 kW / 1,000 kWh（往返效率 88%）" },
      ],
    },
    {
      id: "economics-capex",
      title: "八、投资构成（CAPEX）",
      kind: "table",
      table: {
        columns: ["科目", "金额", "占比"],
        rows: [
          ["光伏系统", "200.00 万元", "30.5%"],
          ["储能系统", "150.00 万元", "22.9%"],
          ["**净投资**", "**520.00 万元**", "—"],
        ],
      },
    },
    {
      id: "economics-metrics",
      title: "九、经济评价指标",
      kind: "key-values",
      items: [
        { label: "首年收入", value: "300.00 万元", hint: "充电服务 260.00 万元、其他 40.00 万元" },
        { label: "净现值 NPV", value: "444.86 万元", hint: "折现率 8%" },
        { label: "内部收益率 IRR", value: "24.35%" },
        { label: "静态回收期", value: "3.20 年" },
        { label: "折现回收期", value: "3.85 年" },
        { label: "全周期投资回报率 ROI", value: "185.0%" },
      ],
    },
    {
      id: "sensitivity",
      title: "十、敏感性分析",
      kind: "table",
      table: {
        columns: ["参数", "-20%", "+20%"],
        rows: [["光伏等效小时", "-180 万元", "+180 万元"]],
      },
    },
    {
      id: "risks",
      title: "十一、风险",
      kind: "table",
      table: {
        columns: ["风险", "影响", "缓解"],
        rows: [["电价政策变化", "套利收益归零", "签长期协议"]],
      },
    },
    {
      id: "diagnostics",
      title: "十二、诊断",
      kind: "paragraph",
      paragraphs: ["无异常。"],
    },
    {
      id: "provenance",
      title: "十三、溯源",
      kind: "key-values",
      items: [
        { label: "情景", value: "基准情景（cabc123scenario）" },
        { label: "引擎版本", value: "engine@2.0.0（计算引用 calc）" },
        { label: "模型版本", value: "model@1.5.0" },
        { label: "基准参数版本", value: "benchmark@1.0.0" },
        { label: "输入哈希", value: "sha256:abcdef0123456789" },
        { label: "生成时刻", value: "2026-09-21T08:00:00.000Z" },
      ],
    },
    {
      id: "next-steps",
      title: "十四、下一步",
      kind: "bullets",
      bullets: ["补充真实电价与光照数据", "对接产业案例进入发布流程"],
    },
  ];
  return {
    reportVersion: "1.0.0",
    title: "V2 决策报告 · 基准情景",
    provenance: PROVENANCE,
    inputSnapshot: {} as unknown as ScenarioInput,
    sections,
    disclaimer: "本报告为程序计算+叙述层，关键假设多属示例·待核实，须人工以真实数据复核后方可用于投资决策。",
    ...overrides,
  };
}

function makeEcon(overrides: Partial<DecisionEconColumns> = {}): DecisionEconColumns {
  return {
    capexNetYuan: 5200000,
    npvYuan: 4448573,
    irrPct: 24.3553,
    paybackYears: 3.85,
    roiRatio: 1.85,
    lcoeYuanPerKwh: 0.4823,
    npvEquityYuan: 2100000,
    irrEquityPct: 27.1,
    ...overrides,
  };
}

function okInput(overrides: Partial<DecisionSolutionDraftInput> = {}): DecisionSolutionDraftInput {
  return {
    report: makeReport(),
    scenarioInput: null,
    econ: makeEcon(),
    calcStatus: "ok",
    scenarioName: "基准情景",
    scenarioVersion: 2,
    ...overrides,
  };
}

/* ─────────────────────────── 版本与契约 ─────────────────────────── */

describe("decision-to-solution · 版本与顶层契约", () => {
  it("DECISION_TO_SOLUTION_VERSION 语义化 + calcRef 溯源串", () => {
    expect(DECISION_TO_SOLUTION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const d = buildSolutionDraftFromDecision(okInput());
    expect(d.solutionCalcRef).toBe(`decision-solution@${DECISION_TO_SOLUTION_VERSION}`);
    expect(d.draftVersion).toBe(DECISION_TO_SOLUTION_VERSION);
  });

  it("成功草案：title/slug/summary/body/financials 齐备，恒 ASSUMPTION + needsProfessionalReview", () => {
    const d = buildSolutionDraftFromDecision(okInput());
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.title).toBe("V2 决策报告 · 基准情景 · v2");
    expect(d.slug).toMatch(/^[a-z0-9-]+$/);
    expect(d.summary.length).toBeGreaterThan(20);
    expect(d.evidenceGrade).toBe("ASSUMPTION");
    expect(d.needsProfessionalReview).toBe(true);
    expect(d.currency).toBe("CNY");
    expect(d.riskDomains).toEqual(["投资", "能源", "政策"]);
    expect(d.publishBlockers.length).toBeGreaterThanOrEqual(3);
    const all = d.publishBlockers.join("\n");
    expect(all).toContain("低置信度");
    expect(all).toContain("需专业人工确认");
    expect(all).toContain("价格");
    expect(all).toContain("案例");
  });
});

/* ─────────────────────────── §7 单一真源（搬运非重算） ─────────────────────────── */

describe("decision-to-solution · §7 单一真源（财务=Decimal 派生列、正文=报告原串）", () => {
  it("★SolutionFinancial 的 Decimal 串逐字等于同源 econ 派生列（搬运非重算）", () => {
    const econ = makeEcon();
    const d = buildSolutionDraftFromDecision(okInput({ econ }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const f = d.financials[0];
    expect(f.capex).toBe(econ.capexNetYuan!.toFixed(2));
    expect(f.irrPct).toBe(econ.irrPct!.toFixed(4));
    expect(f.paybackYears).toBe(econ.paybackYears!.toFixed(2));
    expect(f.roiPct).toBe((econ.roiRatio! * 100).toFixed(2));
    // assumptions 保留原始值（含负/null），供审计与后续复核比对
    expect((f.assumptions as Record<string, unknown>).npvYuan).toBe(econ.npvYuan);
    expect((f.assumptions as Record<string, unknown>).roiRatio).toBe(econ.roiRatio);
    expect((f.assumptions as Record<string, unknown>).evidenceKind).toBe("ASSUMPTION");
  });

  it("★负值 / 非有限的 econ 派生列不冒充可售数字（省略而非填假值）", () => {
    const econ = makeEcon({ capexNetYuan: -1, npvYuan: -42000, irrPct: null, paybackYears: Number.NaN, roiRatio: 0 });
    const d = buildSolutionDraftFromDecision(okInput({ econ }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const f = d.financials[0];
    expect(f.capex).toBeUndefined();
    expect(f.irrPct).toBeUndefined();
    expect(f.paybackYears).toBeUndefined();
    expect(f.roiPct).toBe("0.00"); // 0 是合法非负
    // 负 NPV → 关键未知 + 发布阻塞项各点名一次，不粉饰
    const allBlockers = d.publishBlockers.join("\n");
    expect(allBlockers).toContain("NPV");
    const unknownNames = d.unknowns.map((u) => u.name).join("|");
    expect(unknownNames).toContain("NPV");
  });

  it("★body 中的关键金额/百分比串逐字取自 report.sections 对应 item / table（不换算、不反解）", () => {
    const report = makeReport();
    const d = buildSolutionDraftFromDecision(okInput({ report }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const body = d.body as Record<string, unknown>;
    const revenue = body.revenueModel as string;
    expect(revenue).toContain("300.00 万元"); // 与 economics-metrics items[0].value 完全一致
    expect(revenue).toContain("充电服务 260.00 万元"); // hint 也原样带上
    const roi = body.roi as string;
    expect(roi).toContain("185.0%"); // 与「全周期投资回报率 ROI」项 value 完全一致
    const payback = body.payback as string;
    expect(payback).toContain("3.85 年"); // 折现回收期
    expect(payback).toContain("3.20 年"); // 静态回收期
    const costModel = (body.costModel as string[]).join("\n");
    expect(costModel).toContain("光伏系统 | 200.00 万元 | 30.5%");
    expect(costModel).toContain("净投资 | 520.00 万元"); // ** ** 已剥离
  });
});

/* ─────────────────────────── §16 失败态：绝不给脏数据编可售方案 ─────────────────────────── */

describe("decision-to-solution · §16 失败/无报告 → 拒导，不产可售物", () => {
  it("calcStatus!=='ok' → ok:false + 阻塞项，不产 body/financials", () => {
    const d = buildSolutionDraftFromDecision(okInput({ calcStatus: "invalid_input", report: null }));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error.reason).toBe("invalid_input");
    expect(d.error.detail).toContain("最近一次计算未通过");
    expect(d.publishBlockers.length).toBeGreaterThanOrEqual(2);
    expect((d as unknown as Record<string, unknown>).body).toBeUndefined();
    expect((d as unknown as Record<string, unknown>).financials).toBeUndefined();
  });

  it("calcStatus==='ok' 但 report 缺失（历史快照无 report 字段）→ 拒导并给可执行提示", () => {
    const d = buildSolutionDraftFromDecision(okInput({ report: null, calcStatus: "ok" }));
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error.reason).toBe("report_missing");
    expect(d.error.detail).toContain("请重算");
  });
});

/* ─────────────────────────── §13/§20 溯源与免责的完整保留 ─────────────────────────── */

describe("decision-to-solution · 溯源 + disclaimer + 全文保真", () => {
  it("provenance 逐字段原样回带（UI 溯源展示的唯一来源）", () => {
    const report = makeReport();
    const d = buildSolutionDraftFromDecision(okInput({ report }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.provenance).toEqual(report.provenance);
  });

  it("body.decisionReport 全文保真（sections/reportVersion/provenance/disclaimer 与源逐字段等）", () => {
    const report = makeReport();
    const d = buildSolutionDraftFromDecision(okInput({ report }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const dr = (d.body as Record<string, unknown>).decisionReport as Record<string, unknown>;
    expect(dr.reportVersion).toBe(report.reportVersion);
    expect(dr.provenance).toEqual(report.provenance);
    expect(dr.disclaimer).toBe(report.disclaimer);
    expect(dr.sections).toEqual(report.sections);
  });

  it("report.disclaimer 逐字出现在 body.riskAnalysis（免责声明不裁剪、随正文走）", () => {
    const report = makeReport();
    const d = buildSolutionDraftFromDecision(okInput({ report }));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const risk = ((d.body as Record<string, unknown>).riskAnalysis as string[]).join("\n");
    expect(risk).toContain(report.disclaimer);
  });
});

/* ─────────────────────────── §16 关键假设 severity 反推 ─────────────────────────── */

describe("decision-to-solution · 关键假设 severity 反推（100-conf，非重算）", () => {
  it("critical-assumptions 表逐行搬到 unknowns，severity=100-置信度", () => {
    const d = buildSolutionDraftFromDecision(okInput());
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.unknowns.length).toBeGreaterThanOrEqual(2);
    const pv = d.unknowns.find((u) => u.name.includes("光伏等效利用小时"));
    expect(pv?.severity).toBe(60); // 100-40
    const spread = d.unknowns.find((u) => u.name.includes("峰谷价差"));
    expect(spread?.severity).toBe(65); // 100-35
  });
});

/* ─────────────────────────── 反重算依赖守卫（结构性钉死） ─────────────────────────── */

describe("decision-to-solution · 反算依赖守卫（不 import 引擎运行时）", () => {
  const SRC_PATH = "kernel/src/lib/decision-to-solution.ts";

  it("源文件不含引擎运行时 import（只允许 `import type`），确保「不重算」是结构事实", () => {
    const src = readFileSync(SRC_PATH, "utf8");
    // 任何非 `import type` 的、指向 @app/kernel/engine 的 from-clause 都视为运行时依赖 → 失败
    const runtimeEngineImports = src
      .split(/\r?\n/)
      .filter((line) => /from\s+["']@app\/kernel\/engine\//.test(line))
      .filter((line) => !/^\s*import\s+type\s/.test(line));
    expect(runtimeEngineImports).toEqual([]);
  });

  it("源文件不调用 runCalculation / buildDecisionReport / PROJECT_MODEL 等引擎入口", () => {
    const src = readFileSync(SRC_PATH, "utf8");
    // 只扫代码里可能的直接调用（注释里出现没关系，用行首非注释粗略过一遍即可）
    const forbidden = ["runCalculation(", "buildDecisionReport(", "computeDecisionSnapshot(", "PROJECT_MODEL_BASELINE"];
    const codeLines = src
      .split(/\r?\n/)
      .map((l) => l.trim())
      // 剥掉行注释与块注释起始标记
      .filter((l) => !l.startsWith("*") && !l.startsWith("/*") && !l.startsWith("//"));
    for (const sym of forbidden) {
      const hit = codeLines.find((l) => l.includes(sym));
      expect(hit, `源文件不应出现 ${sym}（导出桥只搬运不重算）`).toBeUndefined();
    }
  });
});
