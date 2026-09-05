import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 9 M5 单元测试：AI 成本落库映射 + 聚合（`src/server/model-calls.ts`）。
 * 无 DB：`toModelCallCreateData` / `summarizeModelCalls` 是纯函数；recorder 用注入假 prisma。
 * 铁律：成本口径来自 Model Router 的 CallRecord（单一真源，第 16 条），本模块只搬运 + 聚合，绝不重算（第 7 条）。
 */

// 必须在 import 被测模块前 mock prisma（被测模块顶层 import @/lib/prisma）。
const createMock = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { modelCall: { create: (...a: unknown[]) => createMock(...a) } } }));

import {
  toModelCallCreateData,
  summarizeModelCalls,
  createDbCallRecorder,
  type ModelCallRow,
} from "@/server/model-calls";
import { loggingRecorder, type CallRecord } from "@/server/model-router";

function rec(over: Partial<CallRecord> = {}): CallRecord {
  return {
    taskId: "research-1",
    timestamp: "2026-09-05T10:00:00.000Z",
    providerId: "deepseek",
    modelId: "deepseek-chat",
    tier: "high",
    taskKind: "research",
    latencyMs: 1234,
    usage: { promptTokens: 100, completionTokens: 50 },
    estimatedCostUsd: 0.0042,
    status: "ok",
    agent: "pipeline:research",
    caseId: "case-1",
    solutionId: "sol-1",
    ...over,
  };
}

beforeEach(() => createMock.mockReset());

describe("toModelCallCreateData（CallRecord → 建表入参）", () => {
  it("逐字段搬运：维度 + 归因 + 用量 + 成本", () => {
    const d = toModelCallCreateData(rec());
    expect(d).toMatchObject({
      taskId: "research-1",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      tier: "high",
      taskKind: "research",
      status: "ok",
      latencyMs: 1234,
      promptTokens: 100,
      completionTokens: 50,
      estimatedCostUsd: 0.0042,
      agent: "pipeline:research",
      caseId: "case-1",
      solutionId: "sol-1",
    });
    // 合法 ISO 时间戳 → createdAt 为该时刻的 Date。
    expect(d.createdAt).toBeInstanceOf(Date);
    expect((d.createdAt as Date).toISOString()).toBe("2026-09-05T10:00:00.000Z");
  });

  it("缺省归因 undefined → null（而非 undefined，保证写库列显式空）", () => {
    const d = toModelCallCreateData(rec({ agent: undefined, caseId: undefined, solutionId: undefined }));
    expect(d.agent).toBeNull();
    expect(d.caseId).toBeNull();
    expect(d.solutionId).toBeNull();
  });

  it("脏数值兜底：负 / NaN 的延迟与 token 归零、成本负 → 0", () => {
    const d = toModelCallCreateData(
      rec({ latencyMs: -5, usage: { promptTokens: NaN, completionTokens: -3 }, estimatedCostUsd: -1 }),
    );
    expect(d.latencyMs).toBe(0);
    expect(d.promptTokens).toBe(0);
    expect(d.completionTokens).toBe(0);
    expect(d.estimatedCostUsd).toBe(0);
  });

  it("小数 token 取整（防脏数据入库非整数）", () => {
    const d = toModelCallCreateData(rec({ usage: { promptTokens: 12.9, completionTokens: 5.1 } }));
    expect(d.promptTokens).toBe(12);
    expect(d.completionTokens).toBe(5);
  });

  it("非法时间戳 → createdAt 省略（回落 DB now() 默认）", () => {
    const d = toModelCallCreateData(rec({ timestamp: "not-a-date" }));
    expect(d.createdAt).toBeUndefined();
  });
});

describe("summarizeModelCalls（纯聚合，程序求和）", () => {
  const rows = (...over: Array<Partial<ModelCallRow>>): ModelCallRow[] =>
    over.map((o) => ({
      tier: "low",
      taskKind: "generate_text",
      status: "ok",
      agent: null,
      estimatedCostUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      ...o,
    }));

  it("空集：全零 + avgLatency null（诚实空态，不除零）", () => {
    const s = summarizeModelCalls([]);
    expect(s).toMatchObject({
      totalCalls: 0,
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      avgLatencyMs: null,
      errorCalls: 0,
    });
    expect(s.byTier).toEqual({});
    expect(s.byStatus).toEqual({});
    expect(s.byAgent).toEqual([]);
  });

  it("总量 + 平均延迟（四舍五入）+ 各档/各状态分组", () => {
    const s = summarizeModelCalls(
      rows(
        { tier: "high", estimatedCostUsd: 0.003, latencyMs: 100, promptTokens: 10, completionTokens: 5 },
        { tier: "high", estimatedCostUsd: 0.001, latencyMs: 200, promptTokens: 6, completionTokens: 4 },
        { tier: "low", estimatedCostUsd: 0.002, latencyMs: 300, promptTokens: 3, completionTokens: 3 },
      ),
    );
    expect(s.totalCalls).toBe(3);
    expect(s.totalCostUsd).toBeCloseTo(0.006, 6);
    expect(s.totalPromptTokens).toBe(19);
    expect(s.totalCompletionTokens).toBe(12);
    expect(s.avgLatencyMs).toBe(200); // (100+200+300)/3
    expect(s.byTier.high).toEqual({ calls: 2, costUsd: 0.004 });
    expect(s.byTier.low).toEqual({ calls: 1, costUsd: 0.002 });
    expect(s.byStatus.ok).toBe(3);
  });

  it("errorCalls 统计所有非 ok（schema_invalid + provider_error），byStatus 分列", () => {
    const s = summarizeModelCalls(
      rows({ status: "ok" }, { status: "schema_invalid" }, { status: "provider_error" }, { status: "ok" }),
    );
    expect(s.errorCalls).toBe(2);
    expect(s.byStatus).toEqual({ ok: 2, schema_invalid: 1, provider_error: 1 });
  });

  it("byAgent：按成本倒序、同成本按调用数降序；null agent 归 (unattributed)", () => {
    const s = summarizeModelCalls(
      rows(
        { agent: "cheap", estimatedCostUsd: 0.001 },
        { agent: "expensive", estimatedCostUsd: 0.01 },
        { agent: "many", estimatedCostUsd: 0.003 },
        { agent: "many", estimatedCostUsd: 0.002 }, // many 合计 0.005、2 次调用
        { agent: "one", estimatedCostUsd: 0.005 }, // 同为 0.005 但只 1 次调用 → 排在 many 后
        { agent: null, estimatedCostUsd: 0.004 }, // → (unattributed)
      ),
    );
    const names = s.byAgent.map((a) => a.agent);
    expect(names).toEqual(["expensive", "many", "one", "(unattributed)", "cheap"]);
    const many = s.byAgent.find((a) => a.agent === "many");
    expect(many).toEqual({ agent: "many", calls: 2, costUsd: 0.005 });
    expect(s.byAgent.find((a) => a.agent === "(unattributed)")?.costUsd).toBe(0.004);
  });

  it("确定性：同输入多次聚合深相等（可复算）", () => {
    const input = rows(
      { tier: "medium", agent: "x", estimatedCostUsd: 0.1234567 },
      { tier: "medium", agent: "x", estimatedCostUsd: 0.0000004 },
    );
    expect(summarizeModelCalls(input)).toEqual(summarizeModelCalls(input));
  });

  it("成本保留 ≤6 位小数（round6）", () => {
    const s = summarizeModelCalls(rows({ estimatedCostUsd: 0.0000001 }, { estimatedCostUsd: 0.0000002 }));
    expect(s.totalCostUsd).toBe(0); // 3e-7 四舍五入到 6 位仍为 0（浮点尾差不外溢）
    const s2 = summarizeModelCalls(rows({ estimatedCostUsd: 1.2345678 }));
    expect(s2.totalCostUsd).toBe(1.234568);
  });
});

describe("createDbCallRecorder（旁路落库，绝不裸抛）", () => {
  it("record() 以映射后的入参写库，并保留结构化日志", async () => {
    createMock.mockResolvedValue({ id: "mc-1" });
    const logSpy = vi.spyOn(loggingRecorder, "record").mockImplementation(() => {});
    const recorder = createDbCallRecorder();
    recorder.record(rec({ taskId: "gen-7" }));
    await recorder.flush(); // 写入在下一微任务发出，先等在途落定
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data).toMatchObject({ taskId: "gen-7", tier: "high", status: "ok", agent: "pipeline:research" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  // 注：失败吞异常路径（create 抛 → .catch(log.warn) 收住、业务不受影响）由链上 .catch 静态保证，
  //   并在运行日志中实测到 warn 落盘；但 vitest 的进程级 unhandledRejection 检测器会把任何 mock 产生的
  //   被拒绝 promise 误判为未处理（采纳 handler 与被拒绝之间存在一个微任务窗口），故此处不以 mock 复刻该路径，
  //   改由集成测试对真实 prisma 断言「写入成功」往返（见 tests/integration/model-calls.test.ts）。

  it("flush 等待全部在途写入（多条 record 后 create 被调用相同次数）", async () => {
    createMock.mockResolvedValue({ id: "x" });
    const logSpy = vi.spyOn(loggingRecorder, "record").mockImplementation(() => {});
    const recorder = createDbCallRecorder();
    recorder.record(rec({ taskId: "a" }));
    recorder.record(rec({ taskId: "b" }));
    recorder.record(rec({ taskId: "c" }));
    await recorder.flush();
    expect(createMock).toHaveBeenCalledTimes(3);
    logSpy.mockRestore();
  });
});
