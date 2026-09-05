import { describe, it, expect } from "vitest";
import {
  EXPLAIN_VERSION,
  EXPLAIN_TIER,
  EXPLAIN_AGENT,
  sandboxReportInputSchema,
  explanationSchema,
  buildExplainPrompt,
  explainSandboxScenario,
  type SandboxReportInput,
} from "@/server/sandbox-explain";
import {
  StubProvider,
  createMemoryRecorder,
  type ChatProvider,
} from "@/server/model-router";

/**
 * 单元测试：沙盘「AI 解释」编排（中途重构 R6.2 · §7 LLM 只解释不算数）。
 * **无 DB、无网络、无 key、无时钟/随机**——provider 注入确定性 `StubProvider + fixture` 离线跑满契约。
 * 锁死底线：① 报告不完整时诚实拒绝解释；② 只把报告已有数字喂给模型（单一真源、不重算）；
 * ③ prompt 明令禁止算数/杜撰、what-if 只定性；④ provider 报错 / schema 不过一律诚实归一、绝不半渲染；
 * ⑤ 成本经 recorder 记录（§31），归因 agent=sandbox:explain。
 */

const OK_REPORT: SandboxReportInput = {
  reportVersion: "1.0.0",
  ok: true,
  title: "产业项目可视化决策沙盘报告 · 山西",
  regionName: "山西",
  sections: [
    {
      key: "exec",
      title: "一、执行摘要",
      kind: "prose",
      paragraphs: ["核心结论：净现值 NPV 427.74 万元，内部收益率 IRR 23.76%。"],
    },
    {
      key: "structure",
      title: "二、投资与首年运营结构",
      kind: "bullets",
      items: [
        { label: "净 CAPEX（补贴后）", value: "352.45 万元" },
        { label: "首年收入", value: "498.75 万元" },
      ],
    },
    {
      key: "sensitivity",
      title: "四、敏感性",
      kind: "prose",
      paragraphs: ["最敏感变量为「综合充电单价」。"],
    },
  ],
  disclaimers: ["本报告全部数字由确定性计算引擎程序算出。", "结论需专业人工确认。"],
};

const FAIL_REPORT: SandboxReportInput = {
  reportVersion: "1.0.0",
  ok: false,
  title: "产业项目沙盘报告 · 全国通用（未能生成）",
  regionName: "全国通用",
  sections: [
    { key: "error", title: "当前参数不足以生成结论", kind: "list", paragraphs: ["引擎返回状态：tech_error"] },
  ],
  disclaimers: ["结论需专业人工确认。"],
};

const EXPLAIN_FIXTURE = {
  interpretation: "在当前参数下 NPV 为正，经济面初步乐观。",
  keyDrivers: ["充电单价是最敏感变量", "上网电价次之"],
  whatIf: ["若充电单价上升，NPV 通常随之改善"],
  risks: ["所有入参均为占位假设，需人工核实"],
  needsHumanReview: true,
};

/** 只 throw 的 provider，用于测 provider_error 归一，并证明拒绝解释发生在调用之前。 */
const BOOM_PROVIDER: ChatProvider = {
  id: "boom",
  async complete(): Promise<never> {
    throw new Error("boom-network");
  },
};

describe("sandbox-explain constants", () => {
  it("exposes a semantic version and stable tier/agent tags", () => {
    expect(EXPLAIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(EXPLAIN_TIER).toBe("medium");
    expect(EXPLAIN_AGENT).toBe("sandbox:explain");
  });
});

describe("sandboxReportInputSchema", () => {
  it("accepts a well-formed deterministic report", () => {
    const r = sandboxReportInputSchema.safeParse(OK_REPORT);
    expect(r.success).toBe(true);
  });

  it("rejects reports with no sections or an unknown section kind", () => {
    expect(sandboxReportInputSchema.safeParse({ ...OK_REPORT, sections: [] }).success).toBe(false);
    expect(
      sandboxReportInputSchema.safeParse({
        ...OK_REPORT,
        sections: [{ key: "x", title: "y", kind: "table" }],
      }).success,
    ).toBe(false);
  });
});

describe("buildExplainPrompt（确定性 + 只喂报告原数字）", () => {
  it("is deterministic for the same input", () => {
    expect(buildExplainPrompt(OK_REPORT)).toBe(buildExplainPrompt(OK_REPORT));
  });

  it("embeds the report's numbers verbatim and the anti-recompute instructions", () => {
    const p = buildExplainPrompt(OK_REPORT);
    // 单一真源：报告里的数字逐字进入 prompt（模型不得改动）。
    expect(p).toContain("NPV 427.74 万元");
    expect(p).toContain("352.45 万元");
    expect(p).toContain("最敏感变量为「综合充电单价」");
    // 铁律关键词。
    expect(p).toContain("不得");
    expect(p).toContain("重新计算");
    expect(p).toContain("定性");
    expect(p).toContain("需专业人工确认");
  });

  it("appends and truncates a user follow-up question", () => {
    const withQ = buildExplainPrompt(OK_REPORT, "为什么回收期这么久？");
    expect(withQ).toContain("用户追问");
    expect(withQ).toContain("为什么回收期这么久？");
    const long = "x".repeat(5000);
    const truncated = buildExplainPrompt(OK_REPORT, long);
    expect(truncated.length).toBeLessThan(long.length + 2000);
  });
});

describe("explainSandboxScenario（编排契约 · 离线 StubProvider）", () => {
  it("honestly refuses to explain an incomplete report (no provider call)", async () => {
    const rec = createMemoryRecorder();
    const res = await explainSandboxScenario(FAIL_REPORT, {}, { provider: BOOM_PROVIDER, recorder: rec });
    expect(res.status).toBe("blocked");
    // 拒绝发生在调用之前：一次都没打给模型。
    expect(rec.calls.length).toBe(0);
  });

  it("returns a validated explanation and records cost on success", async () => {
    const rec = createMemoryRecorder();
    const res = await explainSandboxScenario(
      OK_REPORT,
      {},
      { provider: new StubProvider(), fixture: EXPLAIN_FIXTURE, recorder: rec },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.explanation.interpretation).toBe(EXPLAIN_FIXTURE.interpretation);
    expect(res.explanation.keyDrivers).toEqual(EXPLAIN_FIXTURE.keyDrivers);
    expect(res.explainVersion).toBe(EXPLAIN_VERSION);
    expect(res.modelId).toBeTruthy();
    expect(res.cost.calls).toBe(1);
    expect(Number.isFinite(res.cost.totalCostUsd)).toBe(true);
    expect(res.cost.totalCostUsd).toBeGreaterThanOrEqual(0);

    // §31 成本落记录器（路由侧再落 ModelCall 表）：归因与任务类型正确。
    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0].agent).toBe(EXPLAIN_AGENT);
    expect(rec.calls[0].taskKind).toBe("structured_output");
    expect(rec.calls[0].tier).toBe(EXPLAIN_TIER);
    expect(rec.calls[0].status).toBe("ok");
  });

  it("applies schema defaults for a minimal valid explanation", async () => {
    const res = await explainSandboxScenario(
      OK_REPORT,
      {},
      { provider: new StubProvider(), fixture: { interpretation: "只有一句解读" } },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.explanation.keyDrivers).toEqual([]);
    expect(res.explanation.whatIf).toEqual([]);
    expect(res.explanation.risks).toEqual([]);
    expect(res.explanation.needsHumanReview).toBe(true); // 缺省宁可多标
  });

  it("normalizes a schema-invalid model output to error (never half-renders)", async () => {
    const rec = createMemoryRecorder();
    const res = await explainSandboxScenario(
      OK_REPORT,
      {},
      { provider: new StubProvider(), fixture: { interpretation: "", keyDrivers: [] }, recorder: rec },
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.error).toContain("结构校验");
    expect(rec.calls[0].status).toBe("schema_invalid");
  });

  it("normalizes a provider failure to error without leaking the raw throw as a crash", async () => {
    const res = await explainSandboxScenario(OK_REPORT, {}, { provider: BOOM_PROVIDER });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.error).toContain("boom-network");
  });
});

describe("explanationSchema", () => {
  it("requires a non-empty interpretation and defaults the lists", () => {
    expect(explanationSchema.safeParse({ interpretation: "x" }).success).toBe(true);
    expect(explanationSchema.safeParse({ interpretation: "" }).success).toBe(false);
    const parsed = explanationSchema.parse({ interpretation: "x" });
    expect(parsed.keyDrivers).toEqual([]);
    expect(parsed.needsHumanReview).toBe(true);
  });
});
