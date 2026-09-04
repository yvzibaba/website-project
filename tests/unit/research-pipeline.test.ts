import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  PIPELINE_VERSION,
  PIPELINE_ROLES,
  DEFAULT_ROLE_TIERS,
  DEFAULT_ROLE_TASKKIND,
  DEFAULT_QA_THRESHOLD,
  EVIDENCE_KINDS,
  researchSchema,
  bullSchema,
  bearSchema,
  judgeSchema,
  qaSchema,
  runResearchPipeline,
  type PipelineInput,
  type PipelineRole,
} from "@/server/research-pipeline";
import {
  StubProvider,
  type ChatProvider,
  type ModelSpec,
  type ModelTaskKind,
  type ProviderRequest,
  type ProviderResult,
} from "@/server/model-router";

/**
 * §33 多角色研究流水线契约单测（Phase 9 M2，**无 DB、无网络、无 key**）。
 * 锁定的是「编排契约」而非某个模型的行为：固定角色序、每角色 schema 校验、QA 门禁不静默放行、
 * provider/ schema 失败诚实早退且保留已产出记录与成本、确定性可复算、上下文按序传递。
 * 真实 provider 到位后这些测试**不动**（只需注入实现 ChatProvider 的类）。
 */

/* ───────── helpers ───────── */

const run = runResearchPipeline;

/** provider 调用快照（顺序 / 上下文传递断言用）。 */
interface ProviderRequestCapture {
  taskKind: ModelTaskKind;
  model: ModelSpec;
  prompt: string;
}

function completeFixtures() {
  return {
    research: { summary: "综述：该方案在 X 场景具备机会。", findings: [
      { statement: "市场规模逐年增长", evidenceKind: "FACT", confidence: 80 },
      { statement: "本地化改造成本可控", evidenceKind: "ASSUMPTION", confidence: 55 },
    ] },
    bull: { points: [{ claim: "有明确付费客户群", evidence: "访谈 3 家意向客户", strength: 70 }] },
    bear: { points: [{ claim: "供应链依赖单一来源", evidence: "供应商尽调", severity: 60 }] },
    judge: { verdict: "mixed", rationale: "正反证据并存，需补关键未知变量。", confidence: 65 },
    qa: { approved: true, qualityScore: 85, needsHumanReview: false, issues: [] },
  };
}

/** 记录每次 provider 调用（含 prompt），并按队列返回预设 json（供顺序 / 上下文传递断言）。 */
function scriptedProvider(
  queue: Array<{ json: unknown } | { throwWith: string }>,
): { provider: ChatProvider; calls: ProviderRequestCapture[] } {
  const calls: ProviderRequestCapture[] = [];
  let i = 0;
  const provider: ChatProvider = {
    id: "scripted",
    async complete(req: ProviderRequest): Promise<ProviderResult> {
      calls.push({ taskKind: req.taskKind, model: req.model, prompt: req.prompt });
      const next = queue[i++];
      if (!next) throw new Error(`scripted provider exhausted at call ${i}`);
      if ("throwWith" in next) throw new Error(next.throwWith);
      const text = JSON.stringify(next.json);
      return {
        modelId: req.model.id,
        json: next.json,
        usage: { promptTokens: Math.max(1, Math.round(req.prompt.length / 4)), completionTokens: Math.round(text.length / 4) },
      };
    },
  };
  return { provider, calls };
}

const q = completeFixtures();
const FULL_QUEUE = [q.research, q.bull, q.bear, q.judge, q.qa].map((json) => ({ json }));

/* ───────── constants ───────── */

describe("constants", () => {
  it("版本已定、恰 5 角色且顺序固定 research→bull→bear→judge→qa", () => {
    expect(PIPELINE_VERSION).toBe("1.0.0");
    expect([...PIPELINE_ROLES]).toEqual(["research", "bull", "bear", "judge", "qa"]);
  });

  it("每个角色都有合法 taskKind 与 tier；research/judge 走 high，bull/bear/qa 走 medium", () => {
    for (const r of PIPELINE_ROLES) {
      expect(DEFAULT_ROLE_TIERS[r as PipelineRole]).toMatch(/^(low|medium|high)$/);
      expect(typeof DEFAULT_ROLE_TASKKIND[r as PipelineRole]).toBe("string");
    }
    expect(DEFAULT_ROLE_TIERS.research).toBe("high");
    expect(DEFAULT_ROLE_TIERS.judge).toBe("high");
    expect(DEFAULT_ROLE_TIERS.bull).toBe("medium");
    expect(DEFAULT_ROLE_TIERS.qa).toBe("medium");
    expect(DEFAULT_QA_THRESHOLD).toBe(70);
    expect([...EVIDENCE_KINDS]).toEqual(["FACT", "ASSUMPTION", "INFERENCE", "PREDICTION"]);
  });

  it("各 schema 接受黄金样本、拒绝缺字段（契约可被校验）", () => {
    expect(researchSchema.safeParse(q.research).success).toBe(true);
    expect(bullSchema.safeParse(q.bull).success).toBe(true);
    expect(bearSchema.safeParse(q.bear).success).toBe(true);
    expect(judgeSchema.safeParse(q.judge).success).toBe(true);
    expect(qaSchema.safeParse(q.qa).success).toBe(true);
    // summary 必填非空
    expect(researchSchema.safeParse({ summary: "", findings: [] }).success).toBe(false);
    // verdict 枚举受限
    expect(judgeSchema.safeParse({ verdict: "maybe", rationale: "x", confidence: 50 }).success).toBe(false);
    // 空数组被允许（诚实：没查到不硬凑）
    expect(bullSchema.safeParse({}).success).toBe(true);
    expect(bullSchema.parse({}).points).toEqual([]);
  });
});

/* ───────── complete path ───────── */

describe("runResearchPipeline：complete", () => {
  it("五角色齐备 → status complete，输出齐全、5 条记录按 agent 归因、成本>0", async () => {
    const input: PipelineInput = { question: "本土化重构 X 是否可行？", caseId: "c1", solutionId: "s1" };
    const r = await run(input, { fixtures: completeFixtures() });
    expect(r.status).toBe("complete");
    if (r.status !== "complete") return;
    expect(r.outputs.research?.summary).toContain("综述");
    expect(r.outputs.bull?.points).toHaveLength(1);
    expect(r.outputs.bear?.points).toHaveLength(1);
    expect(r.outputs.judge?.verdict).toBe("mixed");
    expect(r.outputs.qa?.approved).toBe(true);
    expect(r.cost.calls).toBe(5);
    expect(r.cost.totalCostUsd).toBeGreaterThan(0);
    // cost = 各记录 estimatedCostUsd 之和（自洽）
    const sum = Math.round(r.callRecords.reduce((s, c) => s + c.estimatedCostUsd, 0) * 1e6) / 1e6;
    expect(r.cost.totalCostUsd).toBe(sum);
    // 每条记录带 agent=pipeline:<role> 与归因
    expect(r.callRecords.map((c) => c.agent)).toEqual([
      "pipeline:research", "pipeline:bull", "pipeline:bear", "pipeline:judge", "pipeline:qa",
    ]);
    for (const c of r.callRecords) {
      expect(c.caseId).toBe("c1");
      expect(c.solutionId).toBe("s1");
      expect(c.status).toBe("ok");
    }
  });

  it("roleTiers 反映默认映射（可被 tierOverrides 覆写）", async () => {
    const r = await run({ question: "x" }, { fixtures: completeFixtures() });
    if (r.status === "complete") expect(r.roleTiers).toEqual(DEFAULT_ROLE_TIERS);
    const r2 = await run(
      { question: "x" },
      { fixtures: completeFixtures(), tierOverrides: { bull: "low" } },
    );
    if (r2.status === "complete") expect(r2.roleTiers.bull).toBe("low");
  });
});

/* ───────── QA gate ───────── */

describe("runResearchPipeline：QA 门禁（不静默放行）", () => {
  it("approved=false → needs_human_review", async () => {
    const fx = { ...completeFixtures(), qa: { ...q.qa, approved: false } };
    const r = await run({ question: "x" }, { fixtures: fx });
    expect(r.status).toBe("needs_human_review");
    if (r.status === "needs_human_review") expect(r.reason).toContain("未批准");
  });

  it("qualityScore 低于阈值 → needs_human_review（含分数与阈值）", async () => {
    const fx = { ...completeFixtures(), qa: { ...q.qa, qualityScore: 40 } };
    const r = await run({ question: "x" }, { fixtures: fx });
    expect(r.status).toBe("needs_human_review");
    if (r.status === "needs_human_review") {
      expect(r.reason).toContain("40");
      expect(r.reason).toContain(String(DEFAULT_QA_THRESHOLD));
    }
  });

  it("needsHumanReview=true → needs_human_review", async () => {
    const fx = { ...completeFixtures(), qa: { ...q.qa, needsHumanReview: true } };
    const r = await run({ question: "x" }, { fixtures: fx });
    expect(r.status).toBe("needs_human_review");
    if (r.status === "needs_human_review") expect(r.reason).toContain("人工复核");
  });

  it("qaThreshold 覆写可翻转结论（75 默认放行、抬到 80 变暂缓）", async () => {
    const fx = { ...completeFixtures(), qa: { ...q.qa, qualityScore: 75 } };
    const pass = await run({ question: "x" }, { fixtures: fx });
    expect(pass.status).toBe("complete");
    const hold = await run({ question: "x" }, { fixtures: fx, qaThreshold: 80 });
    expect(hold.status).toBe("needs_human_review");
  });

  it("needs_human_review 仍保留完整五段输出与成本（暂缓 ≠ 丢失成果）", async () => {
    const fx = { ...completeFixtures(), qa: { ...q.qa, approved: false } };
    const r = await run({ question: "x" }, { fixtures: fx });
    if (r.status === "needs_human_review") {
      expect(r.cost.calls).toBe(5);
      expect(r.outputs.judge?.rationale).toBeTruthy();
    }
  });
});

/* ───────── early abort: failed ───────── */

describe("runResearchPipeline：诚实早退（failed）", () => {
  it("bull 输出不过 schema → 早退 stage=bull kind=schema_invalid，保留 research 记录、不臆造后续", async () => {
    const fx = { ...completeFixtures(), bull: { points: [{ claim: "", evidence: "x", strength: 5 }] } };
    const r = await run({ question: "x" }, { fixtures: fx });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.stage).toBe("bull");
      expect(r.kind).toBe("schema_invalid");
      expect(Array.isArray(r.issues)).toBe(true);
      expect(r.issues && (r.issues as z.ZodError["issues"]).length).toBeGreaterThan(0);
      // 已产出的 research 保留、bear/judge/qa 绝不臆造
      expect(r.outputs.research?.summary).toBeTruthy();
      expect(r.outputs.bear).toBeUndefined();
      expect(r.outputs.judge).toBeUndefined();
      expect(r.outputs.qa).toBeUndefined();
      // 2 条记录：research(ok) + bull(schema_invalid 也记录)
      expect(r.cost.calls).toBe(2);
      expect(r.callRecords[0].status).toBe("ok");
      expect(r.callRecords[1].status).toBe("schema_invalid");
    }
  });

  it("bear 处 provider 抛错 → 早退 stage=bear kind=provider_error，不裸抛、保留前两段", async () => {
    const { provider } = scriptedProvider([
      { json: q.research },
      { json: q.bull },
      { throwWith: "network down" },
    ]);
    const r = await run({ question: "x" }, { provider });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.stage).toBe("bear");
      expect(r.kind).toBe("provider_error");
      expect(r.message).toContain("network down");
      expect(r.outputs.research).toBeTruthy();
      expect(r.outputs.bull).toBeTruthy();
      expect(r.outputs.qa).toBeUndefined();
      // provider_error 记录 usage 归零、成本贡献 0，但记录保留（成本可追踪）
      expect(r.cost.calls).toBe(3);
      expect(r.callRecords[2].status).toBe("provider_error");
      expect(r.callRecords[2].usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    }
  });

  it("首个角色即 provider 抛错 → stage=research、无任何输出、仍产出该次记录", async () => {
    const { provider } = scriptedProvider([{ throwWith: "boom" }]);
    const r = await run({ question: "x" }, { provider });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.stage).toBe("research");
      expect(Object.keys(r.outputs)).toHaveLength(0);
      expect(r.cost.calls).toBe(1);
    }
  });
});

/* ───────── determinism & ordering ───────── */

describe("runResearchPipeline：确定性与上下文传递", () => {
  it("同输入 + 同 fixtures 两次跑 → 输出与成本完全一致（可复算）", async () => {
    const stub = new StubProvider();
    const a = await run({ question: "复算?" }, { provider: stub, fixtures: completeFixtures() });
    const b = await run({ question: "复算?" }, { provider: stub, fixtures: completeFixtures() });
    if (a.status === "complete" && b.status === "complete") {
      expect(a.outputs).toEqual(b.outputs);
      expect(a.cost.totalCostUsd).toBe(b.cost.totalCostUsd);
    } else {
      throw new Error("expected both runs to complete");
    }
  });

  it("按 research→bull→bear→judge→qa 顺序调用，且后段 prompt 含前段结构化输出（上下文链）", async () => {
    const { provider, calls } = scriptedProvider(FULL_QUEUE);
    const r = await run({ question: "顺序与上下文?" }, { provider });
    expect(r.status).toBe("complete");
    // 顺序：taskKind 依次 research, structured_output×4
    expect(calls.map((c) => c.taskKind)).toEqual([
      "research", "structured_output", "structured_output", "structured_output", "structured_output",
    ]);
    const [research, bull, bear, judge, qa] = calls;
    expect(research.prompt).toContain("顺序与上下文?");
    expect(research.prompt).toContain("产业研究员");
    // bull/bear/judge/qa 都应携带 research 摘要上下文
    expect(bull.prompt).toContain("已有研究摘要");
    expect(bear.prompt).toContain("已有研究摘要");
    // judge 同时看到正反方证据
    expect(judge.prompt).toContain("正方证据");
    expect(judge.prompt).toContain("反方证据");
    // qa 看到裁决
    expect(qa.prompt).toContain("裁判裁决");
    expect(qa.prompt).toContain("质检门禁");
  });
});
