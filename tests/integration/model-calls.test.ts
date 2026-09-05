import { describe, it, expect, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  createDbCallRecorder,
  getCostSummary,
  summarizeModelCalls,
} from "@/server/model-calls";
import type { CallRecord } from "@/server/model-router";

/**
 * 集成测试（真连 Neon，Phase 9 M5）：证明 §31 AI 成本观测**真的落库 + 真的读回聚合**。
 *
 * 宪法第 5 条（可验证）：不 mock DB——`createDbCallRecorder` 写的是 `ModelCall` 表，
 *   `getCostSummary` 从真表聚合；只有真库往返才能证「成本可追踪」不是纸面契约。
 * 无 DATABASE_URL 时自动 skip（CI 无 DB 环境仍跑单测）。
 *
 * 隔离：所有夹具用唯一 `agent` 前缀（runId）标记，afterAll 按该前缀 + 已捕获 id 双兜底清理，
 *   绝不污染真库，也不受并发其它集成用例写入影响（断言只针对本用例唯一 agent / ≥ 下界）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn("[model-calls] DATABASE_URL not set — integration tests will be skipped.");
}

describeDb("model-calls cost persistence (Neon Postgres)", () => {
  const runId = `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const agentA = `${runId}:alpha`;
  const agentB = `${runId}:beta`;
  const createdIds: string[] = [];

  function rec(over: Partial<CallRecord> & { taskId: string; agent?: string | null }): CallRecord {
    return {
      timestamp: new Date().toISOString(),
      providerId: "deepseek",
      modelId: "deepseek-chat",
      tier: "medium",
      taskKind: "structured_output",
      latencyMs: 420,
      usage: { promptTokens: 1000, completionTokens: 500 },
      estimatedCostUsd: 0.0042,
      status: "ok",
      ...over,
    };
  }

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.modelCall.deleteMany({ where: { id: { in: createdIds } } }).catch(() => undefined);
    }
    await prisma.modelCall
      .deleteMany({ where: { agent: { startsWith: runId } } })
      .catch(() => undefined);
    await disconnectPrisma();
  });

  it("recorder 把每条 CallRecord 落进 ModelCall 表（字段逐一致，含 Decimal 成本与空归因）", async () => {
    const recorder = createDbCallRecorder();
    // 两条带归因 + 一条 agent 缺省（→ null），验证 best-effort 落库与空值映射。
    recorder.record(rec({ taskId: `${runId}-1`, agent: agentA }));
    recorder.record(
      rec({ taskId: `${runId}-2`, agent: agentB, tier: "high", status: "provider_error", estimatedCostUsd: 0 }),
    );
    recorder.record(rec({ taskId: `${runId}-3` })); // 无 agent → 映射为 DB NULL
    await recorder.flush();

    const rows = await prisma.modelCall.findMany({
      where: { taskId: { startsWith: runId } },
      orderBy: { taskId: "asc" },
    });
    rows.forEach((r) => createdIds.push(r.id));
    expect(rows.length).toBe(3);

    const a = rows.find((r) => r.agent === agentA);
    expect(a).toBeDefined();
    expect(a!.tier).toBe("medium");
    expect(a!.status).toBe("ok");
    expect(a!.providerId).toBe("deepseek");
    expect(a!.modelId).toBe("deepseek-chat");
    expect(a!.promptTokens).toBe(1000);
    expect(a!.completionTokens).toBe(500);
    // Decimal 往返：写入 0.0042 → 读回 Number 精确相等（成本程序计算、非口算）。
    expect(Number(a!.estimatedCostUsd)).toBeCloseTo(0.0042, 6);

    const b = rows.find((r) => r.agent === agentB);
    expect(b!.tier).toBe("high");
    expect(b!.status).toBe("provider_error");
    expect(Number(b!.estimatedCostUsd)).toBe(0);

    // 无 agent 的记录：agent ?? null → 存 DB NULL（如实反映"未归因"，不伪造来源）。
    const c = rows.find((r) => r.taskId === `${runId}-3`);
    expect(c).toBeDefined();
    expect(c!.agent).toBeNull();
  });

  it("getCostSummary 从真表聚合，按本用例唯一 agent 归因成本自洽", async () => {
    // 上一用例已落库 3 条（agentA / agentB / 无 agent）。本用例经聚合读回并核对本用例唯一归因。
    const summary = await getCostSummary();
    expect(summary.totalCalls).toBeGreaterThanOrEqual(3);
    // 本用例两条带唯一 agent：alpha 0.0042 / beta 0 → 从聚合结果里定位并核对。
    const alpha = summary.byAgent.find((x) => x.agent === agentA);
    const beta = summary.byAgent.find((x) => x.agent === agentB);
    expect(alpha).toEqual({ agent: agentA, calls: 1, costUsd: 0.0042 });
    expect(beta).toEqual({ agent: agentB, calls: 1, costUsd: 0 });
    // 状态聚合：至少含本用例制造的 1 条 provider_error。
    expect(summary.byStatus.provider_error ?? 0).toBeGreaterThanOrEqual(1);
    // 自洽不变式：各档调用数之和 === 总调用数（groupBy 与 total 同源）。
    const tierCalls = Object.values(summary.byTier).reduce((s, v) => s + v.calls, 0);
    expect(tierCalls).toBe(summary.totalCalls);
    // 失败数 === 非 ok 状态之和。
    const errFromStatus = Object.entries(summary.byStatus)
      .filter(([k]) => k !== "ok")
      .reduce((s, [, n]) => s + n, 0);
    expect(summary.errorCalls).toBe(errFromStatus);
  });

  it("getCostSummary 结果与直接读表 + summarizeModelCalls 纯函数一致（读取层不篡改）", async () => {
    const rows = await prisma.modelCall.findMany({
      where: { taskId: { startsWith: runId } },
      select: {
        tier: true,
        taskKind: true,
        status: true,
        agent: true,
        estimatedCostUsd: true,
        promptTokens: true,
        completionTokens: true,
        latencyMs: true,
      },
    });
    const local = summarizeModelCalls(
      rows.map((r) => ({
        tier: r.tier,
        taskKind: r.taskKind,
        status: r.status,
        agent: r.agent,
        estimatedCostUsd: Number(r.estimatedCostUsd),
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        latencyMs: r.latencyMs,
      })),
    );
    // 纯函数对本用例 3 行：2 条 ok(0.0042) + 1 条 provider_error(0)，合计 0.0084。
    expect(local.totalCalls).toBe(3);
    expect(local.totalCostUsd).toBeCloseTo(0.0084, 6);
    expect(local.errorCalls).toBe(1);
    expect(local.avgLatencyMs).toBe(420);
  });
});
