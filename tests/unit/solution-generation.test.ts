import { describe, it, expect } from "vitest";
import {
  SOLUTION_GENERATION_VERSION,
  SOLUTION_SECTION_KEYS,
  mapPipelineToSolution,
} from "@/server/solution-generation";
import { SOLUTION_SECTIONS } from "@/server/solution-body";
import type { PipelineResult, PipelineRole } from "@/server/research-pipeline";
import type { ModelTier } from "@/server/model-router";

/**
 * 单元测试：§33 流水线结果 → 方案正文的纯映射器（Phase 8 M3）。**无 DB、无网络、无 key、无时钟/随机**。
 * 锁死宪法底线：只填能诚实支撑的分节、绝不臆造财务/来源、逐条区分事实/假设/推断/预测、
 * 即便失败也保留成果但一律标记需人工、**永不自动发布**。
 */

const ROLE_TIERS: Record<PipelineRole, ModelTier> = {
  research: "high",
  bull: "medium",
  bear: "medium",
  judge: "high",
  qa: "medium",
};

const RESEARCH = {
  summary: "对该方案的尽职综述",
  findings: [
    { statement: "市场规模约 10 亿元", evidenceKind: "FACT", confidence: 90 },
    { statement: "假设核心部件良率 80%", evidenceKind: "ASSUMPTION", confidence: 60 },
    { statement: "由成本曲线推断三年后可降本", evidenceKind: "INFERENCE", confidence: 55 },
    { statement: "预测三年内回本", evidenceKind: "PREDICTION", confidence: 40 },
  ],
};
const BULL = { points: [{ claim: "需求旺盛", evidence: "多份行业报告", strength: 80 }] };
const BEAR = {
  points: [
    { claim: "政策仍处草案阶段", evidence: "尚未落地", severity: 70 },
    { claim: "关键原料依赖进口", evidence: "供应链单一", severity: 90 },
  ],
};
const JUDGE = { verdict: "mixed", rationale: "利弊兼有", confidence: 65 };
const QA_PASS = { approved: true, qualityScore: 85, needsHumanReview: false, issues: [] };

const COST = { calls: 5, totalCostUsd: 0.05 };

function completeResult(): PipelineResult {
  const outputs = { research: RESEARCH, bull: BULL, bear: BEAR, judge: JUDGE, qa: QA_PASS };
  return { status: "complete", outputs, callRecords: [], cost: COST, roleTiers: ROLE_TIERS } as PipelineResult;
}

describe("solution-generation constants", () => {
  it("exposes a semantic version", () => {
    expect(SOLUTION_GENERATION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("section-key set matches the 34 canonical sections", () => {
    expect(SOLUTION_SECTION_KEYS.size).toBe(SOLUTION_SECTIONS.length);
    expect(SOLUTION_SECTION_KEYS.has("bullCase")).toBe(true);
    expect(SOLUTION_SECTION_KEYS.has("aiAnnotations")).toBe(true);
    expect(SOLUTION_SECTION_KEYS.has("notARealSection")).toBe(false);
  });
});

describe("mapPipelineToSolution — complete pipeline", () => {
  const gen = mapPipelineToSolution(completeResult());

  it("fills only honestly-supported sections", () => {
    expect(Object.keys(gen.body).sort()).toEqual(
      ["aiAnnotations", "bearCase", "bullCase", "riskAnalysis", "unknowns"].sort(),
    );
  });

  it("every filled key is a real solution section (no contract drift)", () => {
    for (const k of gen.filledSectionKeys) expect(SOLUTION_SECTION_KEYS.has(k)).toBe(true);
  });

  it("never fabricates financials or sources", () => {
    expect(gen.body.costModel).toBeUndefined();
    expect(gen.body.roi).toBeUndefined();
    expect(gen.body.payback).toBeUndefined();
    expect(gen.body.sources).toBeUndefined();
  });

  it("unknowns lists only non-FACT findings (FACT excluded)", () => {
    const unknowns = gen.body.unknowns as { statement: string; kind: string }[];
    expect(unknowns).toHaveLength(3);
    expect(unknowns.map((u) => u.kind).sort()).toEqual(["ASSUMPTION", "INFERENCE", "PREDICTION"]);
    expect(unknowns.some((u) => u.statement.includes("市场规模"))).toBe(false);
  });

  it("aiAnnotations partitions by kind, carries judge+qa, and registers deliberately-skipped sections", () => {
    const ann = gen.body.aiAnnotations as Record<string, unknown>;
    expect(ann.factualStatementCount).toBe(1);
    expect(ann.assumptions).toHaveLength(1);
    expect(ann.inferences).toHaveLength(1);
    expect(ann.predictions).toHaveLength(1);
    expect((ann.judge as { verdict: string }).verdict).toBe("mixed");
    expect((ann.qa as { qualityScore: number }).qualityScore).toBe(85);
    expect(ann.notGenerated).toEqual(expect.arrayContaining(["costModel", "sources", "roi"]));
    expect(ann.pipelineVersion).toBe("1.1.0");
  });

  it("riskAnalysis sorts bear risks by severity desc and carries the verdict", () => {
    const risk = gen.body.riskAnalysis as { risks: { risk: string; severity: number }[]; judgeVerdict: string };
    expect(risk.risks[0].risk).toBe("关键原料依赖进口"); // severity 90
    expect(risk.risks[1].risk).toBe("政策仍处草案阶段"); // severity 70
    expect(risk.judgeVerdict).toBe("mixed");
  });

  it("reports complete → no human review, passes cost through", () => {
    expect(gen.pipelineStatus).toBe("complete");
    expect(gen.needsHumanReview).toBe(false);
    expect(gen.reviewReason).toBeUndefined();
    expect(gen.cost).toEqual({ calls: 5, totalCostUsd: 0.05 });
    expect(gen.judgeVerdict).toBe("mixed");
    expect(gen.unknownCount).toBe(3);
  });

  it("the generated payload never contains a PUBLISHED directive", () => {
    expect(JSON.stringify(gen).includes("PUBLISHED")).toBe(false);
  });

  it("is deterministic (pure, no clock/random)", () => {
    expect(mapPipelineToSolution(completeResult())).toEqual(gen);
  });
});

describe("mapPipelineToSolution — needs_human_review keeps output but flags review", () => {
  it("preserves all sections yet sets needsHumanReview + reason", () => {
    const result = {
      ...completeResult(),
      status: "needs_human_review",
      reason: "质量分不足",
    } as PipelineResult;
    const gen = mapPipelineToSolution(result);
    expect(gen.pipelineStatus).toBe("needs_human_review");
    expect(gen.needsHumanReview).toBe(true);
    expect(gen.reviewReason).toBe("质量分不足");
    expect(gen.body.bullCase).toBeDefined(); // 暂缓≠丢失成果
  });
});

describe("mapPipelineToSolution — failed keeps partial output", () => {
  it("early exit at bull keeps research-derived sections only, flags stage+kind", () => {
    const result = {
      status: "failed",
      stage: "bull",
      kind: "schema_invalid",
      issues: [{ message: "points 应为数组" }],
      outputs: { research: RESEARCH },
      callRecords: [],
      cost: { calls: 2, totalCostUsd: 0.01 },
      roleTiers: ROLE_TIERS,
    } as unknown as PipelineResult;
    const gen = mapPipelineToSolution(result);
    expect(gen.pipelineStatus).toBe("failed");
    expect(gen.needsHumanReview).toBe(true);
    expect(gen.reviewReason).toContain("bull");
    expect(gen.reviewReason).toContain("schema_invalid");
    expect(gen.body.bullCase).toBeUndefined();
    expect(gen.body.bearCase).toBeUndefined();
    expect(gen.body.riskAnalysis).toBeUndefined(); // no bear/judge present
    expect(gen.body.unknowns).toBeDefined(); // research still counts
    expect(gen.body.aiAnnotations).toBeDefined();
    expect(gen.judgeVerdict).toBeUndefined();
    expect(gen.qa).toBeUndefined();
  });

  it("failure at research (no outputs) yields an empty body", () => {
    const result = {
      status: "failed",
      stage: "research",
      kind: "provider_error",
      message: "network down",
      outputs: {},
      callRecords: [],
      cost: { calls: 1, totalCostUsd: 0 },
      roleTiers: ROLE_TIERS,
    } as unknown as PipelineResult;
    const gen = mapPipelineToSolution(result);
    expect(gen.body).toEqual({});
    expect(gen.filledSectionKeys).toEqual([]);
    expect(gen.unknownCount).toBe(0);
    expect(gen.needsHumanReview).toBe(true);
    expect(gen.reviewReason).toContain("network down");
  });
});

describe("mapPipelineToSolution — empty points are not written as noise", () => {
  it("drops bullCase/bearCase/riskAnalysis when their arrays are empty and no judge", () => {
    const result = {
      status: "complete",
      outputs: {
        research: { summary: "s", findings: [] },
        bull: { points: [] },
        bear: { points: [] },
        judge: undefined,
        qa: QA_PASS,
      },
      callRecords: [],
      cost: COST,
      roleTiers: ROLE_TIERS,
    } as unknown as PipelineResult;
    const gen = mapPipelineToSolution(result);
    expect(gen.body.bullCase).toBeUndefined();
    expect(gen.body.bearCase).toBeUndefined();
    expect(gen.body.riskAnalysis).toBeUndefined();
    expect(gen.body.unknowns).toBeUndefined();
    // aiAnnotations still present (research+qa exist) and honestly reports zero facts
    expect((gen.body.aiAnnotations as Record<string, unknown>).factualStatementCount).toBe(0);
  });
});
