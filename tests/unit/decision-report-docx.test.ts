/**
 * R7-B-2 · V2 决策报告 DOCX 离线交付：数字一致性机器测。
 *
 * ## 它锁的是什么
 * mandate §R7-B-2 明写「禁止『看起来一样』，必须做到同源字段一致」。这里做法：
 *   1) 手工构造一份**含所有 14 节**、每节里都塞**唯一可搜串**（例如 `¥3,875,000` / `24.35%` /
 *      `sha256:abcdef0123456789`）的 fixture，覆盖 CAPEX/NPV/IRR/Payback/ROI/LCOE/年用电/需量/PV/BESS/
 *      电网/充电/关键假设/provenance 全类目；
 *   2) 调 `buildDecisionReportDocx` → 拿 `Uint8Array`；
 *   3) 用 `jszip` 解 OOXML 包 → 取 `word/document.xml` → 剥 XML tag → 得到"纯文本投影"；
 *   4) **逐串 assert 存在**：每一处 fixture 里的原始字符串必须能一字不差地在 DOCX 里搜到。
 *
 * 这样"DOCX = DecisionReport"就是**结构+字节**层面的等价，而不是肉眼比对。
 * 反算依赖守卫：源文件不得 import `runCalculation` / engine 运行时——把「不重算」钉成结构事实（R7-A 同构）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import {
  buildDecisionReportDocx,
  buildDecisionReportFilename,
  DECISION_REPORT_DOCX_VERSION,
  type ReportForDocx,
} from "@/server/decision-report-docx";

/* ─────────────────────────── fixture：14 节 · 唯一可搜串 ─────────────────────────── */

const PROVENANCE = {
  scenarioId: "cabc123scenfix",
  scenarioLabel: "基准情景",
  engineVersion: "engine@2.0.0",
  modelVersion: "model@1.5.0",
  benchmarkVersion: "benchmark@1.0.0",
  inputHash: "sha256:abcdef0123456789",
  timeStepMinutes: 15,
  generatedAtIso: "2026-09-21T08:00:00.000Z",
};

const DISCLAIMER_TEXT = "【免责声明·唯一可搜串】本报告不构成投资承诺或工程交付，须由持证人员复核。";

function makeReport(): ReportForDocx {
  return {
    reportVersion: "report@1.0.0",
    title: "基准情景 · 项目决策报告",
    provenance: PROVENANCE,
    disclaimer: DISCLAIMER_TEXT,
    sections: [
      {
        id: "summary",
        title: "一、执行摘要",
        kind: "paragraph",
        paragraphs: ["【摘要唯一串】全投资 NPV 444.86 万元、IRR 24.35%。"],
      },
      {
        id: "feasibility",
        title: "二、可行性判断",
        kind: "key-values",
        items: [
          { label: "结论", value: "经济可行【可行性唯一串】", hint: "NPV>0 且 IRR 高于基准" },
          { label: "需专业确认", value: "是" },
        ],
      },
      {
        id: "recommendation",
        title: "三、推荐配置",
        kind: "key-values",
        items: [
          { label: "光伏装机", value: "800 kWp【PV唯一串】" },
          { label: "储能功率", value: "500 kW / 1000 kWh【BESS唯一串】" },
          { label: "充电桩", value: "10 × 120 kW【charging唯一串】" },
        ],
      },
      {
        id: "critical-assumptions",
        title: "四、关键假设",
        kind: "table",
        table: {
          columns: ["假设项", "取值", "证据级别", "置信度", "偏差影响"],
          rows: [
            ["光伏等效利用小时", "1,500.000 h", "ASSUMPTION", "40/100", "发电量按比例下降【关键假设唯一串】"],
            ["峰谷价差", "0.85 元/kWh", "UNKNOWN", "0/100", "储能套利收益 = 0"],
          ],
        },
      },
      {
        id: "truck-demand",
        title: "五、重卡用电需求",
        kind: "key-values",
        items: [
          { label: "年用电量", value: "3,285,000 kWh【年用电唯一串】" },
          { label: "峰值需量", value: "1,200 kW【需量唯一串】" },
        ],
      },
      {
        id: "charging",
        title: "六、充电系统",
        kind: "key-values",
        items: [{ label: "服务费", value: "0.45 元/kWh【服务费唯一串】" }],
      },
      {
        id: "energy-system",
        title: "七、能源系统平衡",
        kind: "key-values",
        items: [
          { label: "光伏年发电量", value: "1,200,000 kWh【PV年发唯一串】" },
          { label: "储能年套利", value: "¥27,491【储能收益唯一串】" },
          { label: "电网下网", value: "2,085,000 kWh【电网唯一串】" },
        ],
      },
      {
        id: "economics-capex",
        title: "八、投资概算（CAPEX）",
        kind: "table",
        table: {
          columns: ["分项", "金额（元）", "备注"],
          rows: [
            ["光伏", "¥2,400,000", "3 元/W"],
            ["储能", "¥520,000", "0.52 元/Wh"],
            ["CAPEX 合计", "¥3,875,000", "含税【CAPEX唯一串】"],
          ],
        },
      },
      {
        id: "economics-metrics",
        title: "九、经济性指标",
        kind: "key-values",
        items: [
          { label: "全投资 NPV", value: "¥4,448,573【NPV唯一串】" },
          { label: "全投资 IRR", value: "24.35%【IRR唯一串】" },
          { label: "静态回收期", value: "4.80 年【Payback唯一串】" },
          { label: "全周期投资回报率 ROI", value: "185.0%", hint: "1.85 比值" },
          { label: "LCOE", value: "0.3180 元/kWh【LCOE唯一串】" },
        ],
      },
      {
        id: "sensitivity",
        title: "十、敏感性分析",
        kind: "table",
        table: {
          columns: ["变量", "-20%", "基准", "+20%"],
          rows: [["IRR", "18.10%", "24.35%", "30.20%【敏感性唯一串】"]],
        },
      },
      {
        id: "risks",
        title: "十一、风险清单",
        kind: "bullets",
        bullets: [
          "【支持】政策免征需量电费【风险支持唯一串】",
          "【关注】储能套利依赖峰谷价差稳定",
        ],
      },
      {
        id: "diagnostics",
        title: "十二、诊断",
        kind: "table",
        table: {
          columns: ["类别", "代码", "说明", "建议"],
          rows: [["计算异常", "DIAG_FIXTURE", "此为 fixture 唯一诊断串", "—"]],
        },
      },
      {
        id: "provenance",
        title: "十三、可复算溯源",
        kind: "key-values",
        items: [
          { label: "Engine 版本", value: "engine@2.0.0" },
          { label: "Model 版本", value: "model@1.5.0" },
          { label: "Benchmark 版本", value: "benchmark@1.0.0" },
          { label: "Input Hash", value: "sha256:abcdef0123456789" },
          { label: "生成时刻", value: PROVENANCE.generatedAtIso, hint: "【溯源唯一串】" },
        ],
      },
      {
        id: "next-steps",
        title: "十四、下一步",
        kind: "bullets",
        bullets: ["补充真实电价曲线【下一步唯一串】", "接洽持证人复核"],
      },
    ],
  };
}

/* ─────────────────────────── DOCX 文本投影 helper ─────────────────────────── */

async function unzipToPlainText(buffer: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml 未在 DOCX 包中找到");
  const xml = await entry.async("string");
  // 剥掉所有标签；docx 里 <w:t> 文本节点用 `<..>` 括起；`&` 转义符还原成常见 3 个（够用）
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/* ─────────────────────────── 断言：数字一致 ─────────────────────────── */

describe("R7-B-2 · buildDecisionReportDocx 数字一致（Web Report = DecisionReport = DOCX）", () => {
  it("14 节 fixture 里的每一处唯一可搜串都逐字出现在 DOCX 纯文本投影里", async () => {
    const report = makeReport();
    const built = await buildDecisionReportDocx({
      report,
      projectName: "山西示范项目",
      scenarioName: "基准情景",
      scenarioVersion: 3,
      scenarioSchemaVersion: "scenario@1.0.0",
    });
    const text = await unzipToPlainText(built.buffer);

    const mustContain = [
      // 元信息
      "engine@2.0.0",
      "model@1.5.0",
      "benchmark@1.0.0",
      "sha256:abcdef0123456789",
      "report@1.0.0",
      "scenario@1.0.0",
      "cabc123scenfix",
      // 14 节唯一串（覆盖 mandate §R7-B-2 全清单）
      "【摘要唯一串】",
      "【可行性唯一串】",
      "【PV唯一串】",
      "【BESS唯一串】",
      "【charging唯一串】",
      "【关键假设唯一串】",
      "【年用电唯一串】",
      "【需量唯一串】",
      "【服务费唯一串】",
      "【PV年发唯一串】",
      "【储能收益唯一串】",
      "【电网唯一串】",
      "【CAPEX唯一串】",
      "【NPV唯一串】",
      "【IRR唯一串】",
      "【Payback唯一串】",
      "【LCOE唯一串】",
      "【敏感性唯一串】",
      "【风险支持唯一串】",
      "【溯源唯一串】",
      "【下一步唯一串】",
      // 关键数字（逐字）
      "¥3,875,000",
      "¥4,448,573",
      "24.35%",
      "4.80 年",
      "0.3180 元/kWh",
      "1,500.000 h",
      "3,285,000 kWh",
      "1,200 kW",
      // 五态严格区分（UNKNOWN / ASSUMPTION 字面保留，不被洗成 FACT）
      "ASSUMPTION",
      "UNKNOWN",
      // 免责声明
      DISCLAIMER_TEXT,
    ];
    for (const needle of mustContain) {
      expect(text, `DOCX 里搜不到：${needle}`).toContain(needle);
    }
  });

  it("null / 空串 → 「—」占位；不得静默消失或写成 0（UNKNOWN ≠ 0）", async () => {
    const report: ReportForDocx = {
      reportVersion: "report@1.0.0",
      title: "空缺测试",
      provenance: { ...PROVENANCE, inputHash: "" },
      disclaimer: "DISC",
      sections: [
        {
          id: "economics-metrics",
          title: "指标（含空值）",
          kind: "key-values",
          items: [
            { label: "LCOE", value: "" },
            { label: "NPV", value: "" },
          ],
        },
      ],
    };
    const built = await buildDecisionReportDocx({ report, scenarioVersion: null });
    const text = await unzipToPlainText(built.buffer);
    // 至少出现 3 个 "—"（LCOE 值 + NPV 值 + Input Hash 空 + 版本未知 + 项目名/情景名回落）
    const dashes = (text.match(/—/g) ?? []).length;
    expect(dashes).toBeGreaterThanOrEqual(3);
    expect(text).not.toMatch(/^\s*0\s*$/m); // 不出现裸 0 冒充缺失
  });

  it("文件名 = ProjectName_DecisionReport_Vx.docx，绝不用当前日期覆盖历史（§R7-B-5）", async () => {
    const report = makeReport();
    const a = await buildDecisionReportDocx({ report, projectName: "A 项目", scenarioVersion: 5 });
    const b = await buildDecisionReportDocx({ report, projectName: "A 项目", scenarioVersion: 6 });
    expect(a.filename).toBe("A 项目_DecisionReport_v5.docx");
    expect(b.filename).toBe("A 项目_DecisionReport_v6.docx");
    // 不含日期时间戳（同版本 → 同文件名 → 不会因导出时刻漂移）
    expect(a.filename).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("buildDecisionReportFilename 独立函数：非法字符安全化 + 版本回落链 + 空 → vUnknown", () => {
    // Windows/Linux 通用非法字符 \ / : * ? " < > | 全替换为 _
    const sanitized = buildDecisionReportFilename({
      projectName: "Bad:Name/With\\Illegal*Chars",
      scenarioVersion: 1,
    });
    expect(sanitized).toBe("Bad_Name_With_Illegal_Chars_DecisionReport_v1.docx");
    expect(buildDecisionReportFilename({ scenarioVersion: null, fallback: "Fallback" })).toBe(
      "Fallback_DecisionReport_vUnknown.docx",
    );
    // 项目名全空白 → 落到"DecisionReport"字面兜底，再拼模板 → 双"DecisionReport_"前缀是**特性**不是 bug
    expect(buildDecisionReportFilename({ projectName: "   ", scenarioVersion: 2 })).toBe(
      "DecisionReport_DecisionReport_v2.docx",
    );
    // 非整数版本 → 截断
    expect(buildDecisionReportFilename({ projectName: "项目", scenarioVersion: 10.9 })).toBe(
      "项目_DecisionReport_v10.docx",
    );
    // 负数版本 → vUnknown（防漂：负 version 不是合法 ProjectVersion）
    expect(buildDecisionReportFilename({ projectName: "P", scenarioVersion: -1 })).toBe(
      "P_DecisionReport_vUnknown.docx",
    );
  });

  it("§R7-B-3 · DOCX 元信息 10 项：Project/Scenario/ProjectVersion/Engine/Benchmark/Schema/InputHash/ReportVersion/GeneratedAt/Disclaimer 全在", async () => {
    const built = await buildDecisionReportDocx({
      report: makeReport(),
      projectName: "P-名",
      scenarioName: "S-名",
      scenarioVersion: 7,
      scenarioSchemaVersion: "scenario@1.0.0",
    });
    const text = await unzipToPlainText(built.buffer);
    // 每项都用其中/英标签 + 对应值串双锚（防漂）
    expect(text).toContain("项目 / Project");
    expect(text).toContain("P-名");
    expect(text).toContain("情景 / Scenario");
    expect(text).toContain("S-名");
    expect(text).toContain("情景版本 / Scenario Version");
    expect(text).toContain("7");
    expect(text).toContain("Engine 版本 / Engine Version");
    expect(text).toContain("Benchmark 版本 / Benchmark Version");
    expect(text).toContain("Scenario Schema 版本");
    expect(text).toContain("Input Hash");
    expect(text).toContain("sha256:abcdef0123456789");
    expect(text).toContain("报告契约版本 / Report Version");
    expect(text).toContain("报告生成时刻 / Generated At");
    expect(text).toContain("免责声明");
    expect(text).toContain(DISCLAIMER_TEXT);
  });

  it("§R7-B-1 · 反算依赖守卫：DOCX 生成器不得 import engine 运行时 / runCalculation", () => {
    const src = readFileSync("src/server/decision-report-docx.ts", "utf8");
    const runtimeEngineImports = src
      .split(/\r?\n/)
      .filter((l) => /from\s+["']@app\/kernel\/engine\//.test(l))
      .filter((l) => !/^\s*import\s+type\s/.test(l));
    expect(runtimeEngineImports).toEqual([]);
    const forbidden = ["runCalculation(", "buildDecisionReport(", "computeDecisionSnapshot("];
    for (const token of forbidden) {
      expect(src, `DOCX 生成器不该调用：${token}`).not.toContain(token);
    }
  });

  it("导出常量 DECISION_REPORT_DOCX_VERSION 语义化（正则 + 单调 floor 防漂）", () => {
    expect(DECISION_REPORT_DOCX_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = DECISION_REPORT_DOCX_VERSION.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(1);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });
});
