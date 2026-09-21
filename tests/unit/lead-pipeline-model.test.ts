/**
 * R7-D · 企业项目工作流漏斗派生纯函数（`deriveLeadPipeline`）单测。
 *
 * 锁 mandate §R7-D 的七段判定的**每一个边界**：每段只认确证记录、最深段随最深 reached 推进、
 * nextActions 指针对第一个未到达段、脏数据（负数/非有限/非数组）被 safeCount/兜底吃成 0 不误判。
 * 零 DB / 零时间，字面量即可精确复现。
 */
import { describe, it, expect } from "vitest";
import {
  deriveLeadPipeline,
  PIPELINE_STAGE_ORDER,
  type PipelineEvidence,
} from "@/server/lead-pipeline-model";

function ev(over: Partial<PipelineEvidence> = {}): PipelineEvidence {
  return {
    hasLead: true,
    projectCount: 0,
    computedScenarioCount: 0,
    solutionCount: 0,
    solutionStatuses: [],
    orderStatuses: [],
    ...over,
  };
}

function reachedKeys(p: ReturnType<typeof deriveLeadPipeline>): Set<string> {
  return new Set(p.stages.filter((s) => s.reached).map((s) => s.key));
}

describe("R7-D · deriveLeadPipeline 段序与标签", () => {
  it("输出恒为有序 7 段，键序与 PIPELINE_STAGE_ORDER 一致", () => {
    const p = deriveLeadPipeline(ev());
    expect(p.stages.map((s) => s.key)).toEqual(PIPELINE_STAGE_ORDER.map((s) => s.key));
    expect(p.stages.length).toBe(7);
  });
});

describe("R7-D · 逐段确证判定", () => {
  it("仅留资：只到 LEAD，furthest=LEAD，下一步=立项", () => {
    const p = deriveLeadPipeline(ev());
    expect([...reachedKeys(p)]).toEqual(["LEAD"]);
    expect(p.furthest).toBe("LEAD");
    expect(p.nextActions[0]).toContain("立项");
  });

  it("有项目但未算通出报告：到 PROJECT，未到 ASSESSMENT", () => {
    const p = deriveLeadPipeline(ev({ projectCount: 2, computedScenarioCount: 0 }));
    const r = reachedKeys(p);
    expect(r.has("PROJECT")).toBe(true);
    expect(r.has("ASSESSMENT")).toBe(false);
    expect(p.furthest).toBe("PROJECT");
    expect(p.nextActions[0]).toContain("算通");
  });

  it("有算通出报告的情景：到 ASSESSMENT", () => {
    const p = deriveLeadPipeline(ev({ projectCount: 1, computedScenarioCount: 1 }));
    expect(reachedKeys(p).has("ASSESSMENT")).toBe(true);
    expect(p.furthest).toBe("ASSESSMENT");
    expect(p.nextActions[0]).toContain("方案");
  });

  it("有方案（全草稿）：到 SOLUTION，未 REVIEW（草稿不算过审）", () => {
    const p = deriveLeadPipeline(
      ev({ projectCount: 1, computedScenarioCount: 1, solutionCount: 1, solutionStatuses: ["DRAFT"] }),
    );
    const r = reachedKeys(p);
    expect(r.has("SOLUTION")).toBe(true);
    expect(r.has("REVIEW")).toBe(false);
    expect(p.furthest).toBe("SOLUTION");
    expect(p.nextActions[0]).toContain("人工审核");
  });

  it("有 UNDER_HUMAN_REVIEW 方案：到 REVIEW，未到 PUBLISHED", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["UNDER_HUMAN_REVIEW"],
      }),
    );
    const r = reachedKeys(p);
    expect(r.has("REVIEW")).toBe(true);
    expect(r.has("PUBLISHED")).toBe(false);
    expect(p.furthest).toBe("REVIEW");
    expect(p.nextActions[0]).toContain("复核通过");
  });

  it("有 PUBLISHED 方案：REVIEW 与 PUBLISHED 同时到达（发布蕴含已过审门）", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["PUBLISHED"],
      }),
    );
    const r = reachedKeys(p);
    expect(r.has("REVIEW")).toBe(true);
    expect(r.has("PUBLISHED")).toBe(true);
    expect(p.furthest).toBe("PUBLISHED");
    expect(p.nextActions[0]).toContain("下单");
  });

  it("有 PAID 订单：到达 DELIVERY，nextActions 为空（闭环完成）", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["PUBLISHED"],
        orderStatuses: ["PAID"],
      }),
    );
    expect(p.furthest).toBe("DELIVERY");
    expect(p.nextActions).toEqual([]);
  });

  it("仅有 PENDING 订单：未到 DELIVERY，提示确认收款（后台标 PAID）", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 1,
        solutionCount: 1,
        solutionStatuses: ["PUBLISHED"],
        orderStatuses: ["PENDING"],
      }),
    );
    expect(reachedKeys(p).has("DELIVERY")).toBe(false);
    expect(p.furthest).toBe("PUBLISHED");
    expect(p.nextActions[0]).toContain("确认收款");
  });
});

describe("R7-D · 脏数据兜底（不误判到达）", () => {
  it("负数 / 非有限计数一律当 0", () => {
    const p = deriveLeadPipeline(ev({ projectCount: -5, computedScenarioCount: NaN, solutionCount: Infinity }));
    const r = reachedKeys(p);
    expect(r.has("PROJECT")).toBe(false);
    expect(r.has("ASSESSMENT")).toBe(false);
    expect(r.has("SOLUTION")).toBe(false);
  });

  it("solutionStatuses / orderStatuses 非数组 → 视为空", () => {
    const p = deriveLeadPipeline({
      ...ev({ projectCount: 1, computedScenarioCount: 1 }),
      solutionStatuses: undefined as unknown as PipelineEvidence["solutionStatuses"],
      orderStatuses: null as unknown as PipelineEvidence["orderStatuses"],
    });
    expect(reachedKeys(p).has("REVIEW")).toBe(false);
    expect(reachedKeys(p).has("PUBLISHED")).toBe(false);
  });

  it("hasLead=false（脏调用）→ LEAD 都不到达，furthest 回落 LEAD", () => {
    const p = deriveLeadPipeline(ev({ hasLead: false }));
    expect(p.stages.find((s) => s.key === "LEAD")?.reached).toBe(false);
    expect(p.furthest).toBe("LEAD");
  });
});

describe("R7-D · 多重集统计如实反映在 detail", () => {
  it("混合方案状态：detail 精确到各态计数", () => {
    const p = deriveLeadPipeline(
      ev({
        projectCount: 1,
        computedScenarioCount: 3,
        solutionCount: 4,
        solutionStatuses: ["DRAFT", "UNDER_HUMAN_REVIEW", "PUBLISHED", "PUBLISHED"],
        orderStatuses: ["PAID", "PENDING"],
      }),
    );
    const sol = p.stages.find((s) => s.key === "SOLUTION")!;
    expect(sol.detail).toContain("草稿 1");
    expect(sol.detail).toContain("审核中 1");
    expect(sol.detail).toContain("已发布 2");
    const del = p.stages.find((s) => s.key === "DELIVERY")!;
    expect(del.detail).toContain("已支付订单 1");
    expect(del.detail).toContain("待支付 1");
    expect(p.furthest).toBe("DELIVERY");
  });
});
