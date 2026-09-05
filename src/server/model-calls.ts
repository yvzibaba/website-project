import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { loggingRecorder, type CallRecord, type CallRecorder } from "@/server/model-router";

const log = logger.child({ module: "server/model-calls" });

// 说明：本模块「server-only」（宪法：不 import "server-only" 以免 vitest/node 抛错，仅注释标注）。
// 只读聚合与观测写入，不含任何鉴权——「谁能看」由 authz 在调用方（后台页面 / 路由）把关。

/**
 * AI 调用成本落库 + 成本聚合（Phase 9 M5，server 域逻辑）。
 *
 * 为什么（总控 §31 / 宪法第 7、16 条）：Phase 9 M1 的 `runTask` 每次调用都已产出一条 `CallRecord`
 *   （含 model / tokens / estimated_cost / latency / status + agent/case/solution 归因），但此前只
 *   经 `loggingRecorder` 打进结构化日志——**成本无法跨进程累计、无法出看板、无法据以自动选模型（§32）**。
 *   本模块把这条既有观测数据落库（`ModelCall` 表），并提供程序化的成本聚合，全程复用 Model Router 已有的
 *   `CallRecord` 契约作单一真源（第 16 条防漂移：不另立第二套成本字段/口径）。
 *
 * 成本口径铁律：`estimatedCostUsd` **由 `estimateCost` 程序计算**（宪法第 7 条：程序计算 > LLM 口算），
 *   本模块只做「搬运 + 聚合」，绝不重算、绝不臆造。
 *
 * 诚实与健壮：`dbCallRecorder` 是**尽力而为的旁路记录**——落库失败（网络抖动 / DB 不可用）只 warn 记日志、
 *   **绝不向编排链抛异常**（成本看板挂了不能拖垮一次真实的方案生成），同时仍照常走 `loggingRecorder` 保留日志。
 */

/** 把 Model Router 的 `CallRecord` 映射成 `ModelCall` 建表入参（纯函数，可脱离 DB 单测）。 */
export function toModelCallCreateData(rec: CallRecord): {
  taskId: string;
  providerId: string;
  modelId: string;
  tier: string;
  taskKind: string;
  status: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  agent: string | null;
  caseId: string | null;
  solutionId: string | null;
  createdAt?: Date;
} {
  const createdAt = new Date(rec.timestamp);
  return {
    taskId: rec.taskId,
    providerId: rec.providerId,
    modelId: rec.modelId,
    tier: rec.tier,
    taskKind: rec.taskKind,
    status: rec.status,
    // 负/NaN 延迟与 token 早在 estimateCost / runTask 归零，这里再兜一层 clamp 防脏数据入库。
    latencyMs: Math.max(0, Math.trunc(Number.isFinite(rec.latencyMs) ? rec.latencyMs : 0)),
    promptTokens: Math.max(0, Math.trunc(Number.isFinite(rec.usage.promptTokens) ? rec.usage.promptTokens : 0)),
    completionTokens: Math.max(
      0,
      Math.trunc(Number.isFinite(rec.usage.completionTokens) ? rec.usage.completionTokens : 0),
    ),
    estimatedCostUsd: Number.isFinite(rec.estimatedCostUsd) ? Math.max(0, rec.estimatedCostUsd) : 0,
    agent: rec.agent ?? null,
    caseId: rec.caseId ?? null,
    solutionId: rec.solutionId ?? null,
    // 用调用真实发生时刻归一；时间戳非法则回落 DB 默认 now()。
    createdAt: Number.isNaN(createdAt.getTime()) ? undefined : createdAt,
  };
}

/**
 * 落库记录器：把每条 `CallRecord` best-effort 写进 `ModelCall` 表，同时保留原结构化日志。
 * `record()` 是同步签名（对齐 `CallRecorder` 接口），落库发 fire-and-forget promise 并 `.catch` 吞异常——
 * 观测旁路绝不让一次业务调用失败。但因 `record()` 无法返回 promise，**请求作用域**的调用方（如生成路由）
 * 须在响应前 `await flush()` 等在途写入落定，否则进程冻结/回收可能丢记录（自托管长跑进程无此忧、仍建议 flush）。
 */
export function createDbCallRecorder(): CallRecorder & { flush(): Promise<void> } {
  const inflight = new Set<Promise<unknown>>();
  return {
    record(rec: CallRecord) {
      loggingRecorder.record(rec); // 先照常打日志（保留既有可观测性、绝不丢）
      const data = toModelCallCreateData(rec);
      // 从 Promise.resolve() 起链，保证 create 的同步抛错 / 拒绝都被同一条链的 .catch 收住，
      // 不留任何未处理的中间拒绝 promise（否则 vitest 会记 unhandled rejection）。
      const p = Promise.resolve()
        .then(() => prisma.modelCall.create({ data }))
        .then(() => {
          log.debug("model call persisted", { taskId: rec.taskId, status: rec.status });
        })
        .catch((err: unknown) => {
          // 成本落库失败不影响主流程：warn（不带密钥/敏感体）后继续。
          log.warn("model call persist failed (cost dashboard may lag)", {
            taskId: rec.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    },
    async flush() {
      // 快照后等待，避免 settle 回调修改集合导致竞态。
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

/* ─────────────────────────── 成本聚合（供看板） ─────────────────────────── */

/** 聚合输入的最小规范化行（Decimal 已在读取层转 number；单测可直接构造，无需 DB）。 */
export interface ModelCallRow {
  tier: string;
  taskKind: string;
  status: string;
  agent: string | null;
  estimatedCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface BucketCost {
  calls: number;
  costUsd: number;
}

export interface CostSummary {
  totalCalls: number;
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** 平均延迟（毫秒，四舍五入整数）；无调用记录时为 null。 */
  avgLatencyMs: number | null;
  /** status ≠ "ok" 的调用数（schema_invalid + provider_error 等失败态）。 */
  errorCalls: number;
  byTier: Record<string, BucketCost>;
  byStatus: Record<string, number>;
  /** 按成本倒序的 Agent 归因（null agent 归入 "(unattributed)"）；同成本按调用数、再按名字稳定排序。 */
  byAgent: Array<{ agent: string } & BucketCost>;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * 纯函数成本聚合（确定性、可复算、无 DB）：把规范化行汇总成看板指标。
 * 宪法第 7 条：全部数值由程序对既有记录求和/分组得出，绝不口算。
 */
export function summarizeModelCalls(rows: readonly ModelCallRow[]): CostSummary {
  const byTier: Record<string, BucketCost> = {};
  const byStatus: Record<string, number> = {};
  const agentMap: Record<string, BucketCost> = {};
  let totalCost = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalLatency = 0;
  let errorCalls = 0;

  for (const r of rows) {
    totalCost += Number.isFinite(r.estimatedCostUsd) ? r.estimatedCostUsd : 0;
    totalPrompt += r.promptTokens;
    totalCompletion += r.completionTokens;
    totalLatency += r.latencyMs;
    if (r.status !== "ok") errorCalls += 1;

    const t = (byTier[r.tier] ??= { calls: 0, costUsd: 0 });
    t.calls += 1;
    t.costUsd += r.estimatedCostUsd;

    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

    const key = r.agent ?? "(unattributed)";
    const a = (agentMap[key] ??= { calls: 0, costUsd: 0 });
    a.calls += 1;
    a.costUsd += r.estimatedCostUsd;
  }

  const byAgent = Object.entries(agentMap)
    .map(([agent, v]) => ({ agent, calls: v.calls, costUsd: round6(v.costUsd) }))
    .sort((x, y) => y.costUsd - x.costUsd || y.calls - x.calls || x.agent.localeCompare(y.agent));

  return {
    totalCalls: rows.length,
    totalCostUsd: round6(totalCost),
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    avgLatencyMs: rows.length > 0 ? Math.round(totalLatency / rows.length) : null,
    errorCalls,
    byTier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, { calls: v.calls, costUsd: round6(v.costUsd) }])),
    byStatus,
    byAgent,
  };
}

/**
 * 读取看板成本：从 `ModelCall` 拉取（可选起始时间过滤）→ Decimal 归一为 number → 纯函数聚合。
 * `since` 省略则统计全量；limit 兜底防极端大表拖垮页面（看板取近期即可）。DB 异常向上抛，由调用方 error 边界处理。
 */
export async function getCostSummary(opts: { since?: Date; limit?: number } = {}): Promise<CostSummary> {
  const limit = Math.max(1, Math.min(opts.limit ?? 2000, 10000));
  const where = opts.since ? { createdAt: { gte: opts.since } } : {};
  const rows = await prisma.modelCall.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
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
  const normalized: ModelCallRow[] = rows.map((r) => ({
    tier: r.tier,
    taskKind: r.taskKind,
    status: r.status,
    agent: r.agent,
    estimatedCostUsd: Number(r.estimatedCostUsd),
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    latencyMs: r.latencyMs,
  }));
  log.info("cost summary computed", { rows: normalized.length, since: opts.since?.toISOString() ?? "all" });
  return summarizeModelCalls(normalized);
}
