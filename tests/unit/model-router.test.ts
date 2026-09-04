import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MODEL_ROUTER_VERSION,
  MODEL_TASK_KINDS,
  MODEL_TIERS,
  ROUTING_POLICY,
  MODEL_CATALOG,
  estimateCost,
  StubProvider,
  createMemoryRecorder,
  runTask,
  generateText,
  structuredOutput,
  embed,
  type ModelTaskKind,
  type ModelTier,
  type ChatProvider,
} from "@/server/model-router";

/**
 * Model Router 契约单测（Phase 9 M1，**无 DB、无网络、无 key**）。
 * 锁定的是「骨架契约」而非某个模型的行为：路由策略、成本程序计算、结构化输出 schema 校验、
 * provider 错误归一不抛、调用记录始终产出并可聚合、stub 确定性。真实 provider 到位后这些测试**不动**。
 */

describe("constants", () => {
  it("恰 6 个任务入口、3 个层级，版本已定", () => {
    expect(MODEL_TASK_KINDS).toHaveLength(6);
    expect([...MODEL_TASK_KINDS].sort()).toEqual(
      ["code", "embedding", "generate_text", "research", "structured_output", "vision"].sort(),
    );
    expect([...MODEL_TIERS].sort()).toEqual(["high", "low", "medium"]);
    expect(MODEL_ROUTER_VERSION).toBe("1.0.0");
  });

  it("每个任务都能路由到合法层级；复杂研究走 high、纯生成/向量走 low", () => {
    for (const k of MODEL_TASK_KINDS) {
      expect(MODEL_TIERS).toContain(ROUTING_POLICY[k as ModelTaskKind]);
    }
    expect(ROUTING_POLICY.research).toBe("high");
    expect(ROUTING_POLICY.generate_text).toBe("low");
    expect(ROUTING_POLICY.embedding).toBe("low");
  });

  it("目录里每层级模型 id 唯一、单价为正", () => {
    const ids = MODEL_TIERS.map((t) => MODEL_CATALOG[t as ModelTier].id);
    expect(new Set(ids).size).toBe(3);
    for (const t of MODEL_TIERS) {
      const m = MODEL_CATALOG[t as ModelTier];
      expect(m.tier).toBe(t);
      expect(m.inputPer1kUsd).toBeGreaterThan(0);
      expect(m.outputPer1kUsd).toBeGreaterThan(0);
    }
  });
});

describe("estimateCost（程序计算 · 黄金值）", () => {
  it("high 层 1K 输入 + 1K 输出 = 0.008 + 0.024 = 0.032", () => {
    expect(estimateCost(MODEL_CATALOG.high, { promptTokens: 1000, completionTokens: 1000 })).toBe(0.032);
  });
  it("low 层 2K 输入 = 0.001", () => {
    expect(estimateCost(MODEL_CATALOG.low, { promptTokens: 2000, completionTokens: 0 })).toBe(0.001);
  });
  it("负 / NaN token 一律按 0 处理（脏输入不污染，结果不为负/NaN）", () => {
    expect(estimateCost(MODEL_CATALOG.high, { promptTokens: -5, completionTokens: Number.NaN })).toBe(0);
  });
  it("四舍五入到 6 位小数", () => {
    const c = estimateCost(MODEL_CATALOG.medium, { promptTokens: 1, completionTokens: 1 });
    expect(c).toBe(Number((Math.round(c * 1e6) / 1e6).toFixed(6)));
    expect(String(c).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });
});

describe("StubProvider 确定性", () => {
  it("同 prompt 两次 → embedding/文本/usage 完全一致", async () => {
    const p = new StubProvider();
    const req = { taskKind: "embedding" as const, model: MODEL_CATALOG.low, prompt: "沼气提纯" };
    const a = await p.complete(req);
    const b = await p.complete(req);
    expect(a.embedding).toEqual(b.embedding);
    expect(a.embedding).toHaveLength(8);
    expect(a.usage).toEqual(b.usage);
  });
  it("respondWith 原样回放为 json", async () => {
    const payload = { title: "x", confidence: 42 };
    const r = await new StubProvider().complete({
      taskKind: "structured_output",
      model: MODEL_CATALOG.medium,
      prompt: "hi",
      respondWith: payload,
    });
    expect(r.json).toEqual(payload);
    expect(r.text).toBeUndefined();
  });
});

describe("runTask 编排", () => {
  it("自由文本 → ok，落 low 层，记录 status ok", async () => {
    const rec = createMemoryRecorder();
    const res = await generateText("hello", { recorder: rec });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.output.text).toBe("[stub:generate_text] hello");
      expect(res.record.tier).toBe("low");
      expect(res.record.modelId).toBe("stub-lite");
      expect(res.record.status).toBe("ok");
    }
    expect(rec.calls).toHaveLength(1);
  });

  it("显式 tier 覆盖路由（generate_text 升 high）", async () => {
    const res = await runTask({ taskKind: "generate_text", prompt: "x", tier: "high" });
    expect(res.record.tier).toBe("high");
    expect(res.record.modelId).toBe("stub-max");
  });

  it("结构化输出：合法 → ok 且 json 为校验后数据", async () => {
    const Schema = z.object({ n: z.number(), tags: z.array(z.string()) });
    const res = await structuredOutput(
      "give me",
      Schema,
      {},
      { respondWith: { n: 3, tags: ["a", "b"] } },
    );
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.record.tier).toBe("medium");
      expect(res.output.json).toEqual({ n: 3, tags: ["a", "b"] });
      expect(res.record.estimatedCostUsd).toBeGreaterThan(0);
    }
  });

  it("结构化输出：非法 → schema_invalid 且 issues 指名，但记录仍产出（成本可追踪）", async () => {
    const Schema = z.object({ n: z.number() });
    const rec = createMemoryRecorder();
    const res = await runTask(
      { taskKind: "structured_output", prompt: "p", schema: Schema, respondWith: { n: "not-a-number" } },
      { recorder: rec },
    );
    expect(res.status).toBe("schema_invalid");
    if (res.status === "schema_invalid") {
      expect(res.issues.length).toBeGreaterThan(0);
      expect(res.issues[0].path).toContain("n");
      expect(res.output.json).toEqual({ n: "not-a-number" }); // 原始输出仍带回供审计
    }
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].status).toBe("schema_invalid");
  });

  it("provider 抛错 → provider_error，绝不向业务抛裸异常，usage/成本归零但仍记录", async () => {
    const boom: ChatProvider = {
      id: "boom",
      complete: async () => {
        throw new Error("upstream 500");
      },
    };
    const rec = createMemoryRecorder();
    const res = await runTask({ taskKind: "research", prompt: "deep" }, { provider: boom, recorder: rec });
    expect(res.status).toBe("provider_error");
    if (res.status === "provider_error") {
      expect(res.message).toContain("upstream 500");
      expect(res.record.status).toBe("provider_error");
      expect(res.record.estimatedCostUsd).toBe(0);
      expect(res.record.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
      expect(res.record.tier).toBe("high"); // 仍按 research 路由
    }
    expect(rec.calls).toHaveLength(1);
  });

  it("embed 入口 → ok，向量维度 8", async () => {
    const res = await embed("检索文本");
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.output.embedding).toHaveLength(8);
      expect(res.record.taskKind).toBe("embedding");
    }
  });

  it("taskId 形如 <taskKind>-<n> 且跨调用递增唯一", async () => {
    const a = await generateText("1");
    const b = await generateText("2");
    expect(a.record.taskId).toMatch(/^generate_text-\d+$/);
    expect(a.record.taskId).not.toBe(b.record.taskId);
  });

  it("内存 recorder 聚合总成本", async () => {
    const rec = createMemoryRecorder();
    await generateText("a", { recorder: rec });
    await embed("b", { recorder: rec });
    expect(rec.calls).toHaveLength(2);
    expect(rec.totalCostUsd()).toBeCloseTo(
      rec.calls[0].estimatedCostUsd + rec.calls[1].estimatedCostUsd,
      6,
    );
  });

  it("成本归因 meta（agent/caseId/solutionId）透传进记录", async () => {
    const res = await runTask({
      taskKind: "structured_output",
      prompt: "p",
      respondWith: { ok: true },
      schema: z.object({ ok: z.boolean() }),
      agent: "bull",
      caseId: "case_1",
      solutionId: "sol_1",
    });
    expect(res.record.agent).toBe("bull");
    expect(res.record.caseId).toBe("case_1");
    expect(res.record.solutionId).toBe("sol_1");
  });
});
