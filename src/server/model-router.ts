import { z } from "zod";
import { logger } from "@/lib/logger";

/**
 * Model Router（Phase 9 M1，纯逻辑 · **无 DB 依赖** · server 域逻辑）。
 *
 * 为什么存在（宪法「模型经 Model Router 解耦、不绑定单一模型」+ 总控 §16「统一接口，业务代码不得
 *   直接依赖具体模型」）：本系统的核心承诺是「AI 驱动的产业案例研究 / 解决方案生成」，但上游自动化
 *   （案例拆解 → 技术能力拆解 → 方案生成 → GitHub 匹配 → 企业诊断）此前**没有任何模型接入层**，
 *   一旦直接在某处 `fetch(某个大模型)` 就会把业务逻辑焊死在具体供应商上，换模型 = 改一片代码，且
 *   无法统一记录成本、统一做结构化校验。本模块把「业务代码 → Model Router → provider」这条缝立起来：
 *   业务侧只调 `runTask` / 6 个语义化入口（§16 的 generate_text/structured_output/research/embedding/
 *   vision/code），provider、层级、成本、schema 校验全部收敛在这里。
 *
 * M1 的刻意边界（宪法「V1 只做核心闭环、能简单就简单、禁止提前把系统做复杂」）：
 *   - **只搭骨架、不接真实模型**：真实 provider 阻塞在 ROADMAP #4（模型 API Key）。M1 提供一个
 *     **确定性 StubProvider**（零网络、零 key、同入参恒同出参），使路由 / schema 校验 / 成本估算这些
 *     **契约**可被离线、可复算地测试；等 key 到位只需新增一个实现 `ChatProvider` 的类注册进来即可。
 *   - **成本不落库**：§31 要求「每个 AI 任务记录 model/tokens/estimated_cost/latency/status」。M1 定义
 *     `CallRecord` 结构 + 可插拔 `CallRecorder`（默认走结构化日志；另给内存 recorder 供测试/上层聚合），
 *     Postgres 持久化表与后台成本看板（每日/每 Agent/每案例/每方案）留 M2——没有真实调用就建表存桩数据
 *     属投机式设计。
 *   - **成本/价格表是 v1 假设**（同 `computeEvidenceConfidence` 的处理，宪法第 6/7 条：假设可标注、可调、
 *     可复算）：`estimateCost` 是**程序计算**（非模型口算），单价按每 1K token、单位 USD，真实单价到位后
 *     替换 `MODEL_CATALOG` 并升 `MODEL_ROUTER_VERSION`。
 *   - 无 schema 变更、无 HTTP 端点、无 UI、无 Next 运行时依赖（纯函数 + 判别联合，与 `scoring.ts` 同构）。
 */

/* ─────────────────────────── 版本 & 任务分类（§16 统一接口） ─────────────────────────── */

/** Model Router 契约版本（宪法第 13 条：改路由策略/单价/返回结构须升版本并记录原因，可回滚）。
 *  1.1.0：`MODEL_CATALOG` 改为「env 可覆写、缺省回落占位默认」，使接真实供应商（如 DeepSeek）时
 *  无需改业务代码即可把每层级的模型 id 与真实单价注入配置层（宪法「禁止业务代码硬编码模型名」+
 *  「关键数字来源可追溯、假设可标注可调」）。默认值与 1.0.0 完全一致 → 无 env 时行为不变、离线测试不受影响。 */
export const MODEL_ROUTER_VERSION = "1.1.0";

/** 任务类型——逐字对齐总控 §16 的六个统一入口。 */
export const MODEL_TASK_KINDS = [
  "generate_text",
  "structured_output",
  "research",
  "embedding",
  "vision",
  "code",
] as const;
export type ModelTaskKind = (typeof MODEL_TASK_KINDS)[number];

/** 成本层级（§32：简单任务低成本、普通任务中等、复杂研究/核心判断高成本）。 */
export const MODEL_TIERS = ["low", "medium", "high"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * 任务 → 层级的路由策略（**本项目的 v1 设计假设**，非供应商事实）。
 * 依据 §32「不要所有任务都使用最高成本模型」：把昂贵层级只留给 research（复杂研究）。
 * 核心财务 / 项目判断虽应走 high，但那属于「模型 + 程序计算 + QA」的组合策略（§32/§33），
 * 由上层流水线显式传 `tier:"high"` 升档，此处不为未建成的流水线预调。
 */
export const ROUTING_POLICY: Record<ModelTaskKind, ModelTier> = {
  generate_text: "low",
  embedding: "low",
  vision: "medium",
  code: "medium",
  structured_output: "medium",
  research: "high",
};

/* ─────────────────────────── 模型目录 & 成本估算（§31，纯函数） ─────────────────────────── */

export interface ModelSpec {
  id: string;
  tier: ModelTier;
  /** 每 1K 输入 token 单价（USD）——**v1 占位假设**，接真实模型后替换并升版本。 */
  inputPer1kUsd: number;
  /** 每 1K 输出 token 单价（USD）——**v1 占位假设**。 */
  outputPer1kUsd: number;
}

/** 从 env 读非负数（供单价覆写）；缺失/空白/非法/负数一律 undefined（回落默认）。 */
function envPrice(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** 从 env 读非空字符串（供模型 id 覆写）；缺失/纯空白 → undefined（回落默认）。 */
function envId(name: string): string | undefined {
  const raw = process.env[name];
  const v = raw?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * 构建某层级的 `ModelSpec`：**env 优先、缺省回落 v1 占位默认**。这样接入真实供应商（DeepSeek 等）
 * 时只需在部署环境设 `MODEL_ID_<TIER>` / `MODEL_PRICE_IN_<TIER>` / `MODEL_PRICE_OUT_<TIER>`
 * （单位 USD / 1K token，单价以供应商官方定价页为准、可标注可调），业务代码与 `runTask` 一行不改。
 * 无这些 env 时（如离线单测）默认值与 M1 完全一致，成本黄金样本不受影响。
 */
function tierSpec(
  tier: ModelTier,
  defId: string,
  defIn: number,
  defOut: number,
): ModelSpec {
  const K = tier.toUpperCase();
  return {
    id: envId(`MODEL_ID_${K}`) ?? defId,
    tier,
    inputPer1kUsd: envPrice(`MODEL_PRICE_IN_${K}`) ?? defIn,
    outputPer1kUsd: envPrice(`MODEL_PRICE_OUT_${K}`) ?? defOut,
  };
}

/**
 * 每层级一个模型规格（**默认是 v1 占位假设、可被 env 覆写**，见 `tierSpec`）。
 * provider 用它保证「同层级同模型同单价」；真实供应商下 `req.model.id` 即调用所用真实模型名。
 */
export const MODEL_CATALOG: Record<ModelTier, ModelSpec> = {
  low: tierSpec("low", "stub-lite", 0.0005, 0.0015),
  medium: tierSpec("medium", "stub-mid", 0.002, 0.006),
  high: tierSpec("high", "stub-max", 0.008, 0.024),
};

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * 成本估算（**程序计算 > 模型口算**，宪法第 7 条）。纯函数、可复算：
 * `cost = (prompt/1000)·in + (completion/1000)·out`，四舍五入到 6 位小数（微额友好）。
 * 返回单位 USD；负/NaN token 一律按 0 处理（防脏输入污染）。
 */
export function estimateCost(model: ModelSpec, usage: TokenUsage): number {
  const pt = Math.max(0, Math.trunc(usage.promptTokens) || 0);
  const ct = Math.max(0, Math.trunc(usage.completionTokens) || 0);
  const raw = (pt / 1000) * model.inputPer1kUsd + (ct / 1000) * model.outputPer1kUsd;
  return Math.round(raw * 1e6) / 1e6;
}

/* ─────────────────────────── Provider 抽象（解耦点） ─────────────────────────── */

export interface ProviderRequest {
  taskKind: ModelTaskKind;
  model: ModelSpec;
  prompt: string;
  /** 期望的结构化输出：StubProvider 按此原样回放，保证确定性、可测。真实 provider 忽略此字段。 */
  respondWith?: unknown;
  signal?: AbortSignal;
}

export interface ProviderResult {
  modelId: string;
  text?: string;
  json?: unknown;
  embedding?: number[];
  usage: TokenUsage;
}

/** 供应商接口——业务代码永不 import 它的具体实现，只经 `runTask`（§16）。 */
export interface ChatProvider {
  readonly id: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}

/** 粗略 token 估计（~4 char/token）；仅用于 stub，真实 provider 回传其 API 的真实 usage。 */
function estTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.max(1, Math.round(chars / 4));
}

/** 确定性 FNV-1a 派生 [-1,1) 的小向量（stub embedding 用，无随机、无时钟）。 */
function stubUnitVector(s: string, dim: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < dim; i++) {
    let h = (2166136261 ^ i) >>> 0;
    for (let k = 0; k < s.length; k++) {
      h ^= s.charCodeAt(k);
      h = Math.imul(h, 16777619) >>> 0;
    }
    out.push(((h % 2000) / 1000) - 1);
  }
  return out;
}

/**
 * 确定性桩 provider（M1 的离线替身，零网络 / 零 key / 恒同入同出）：
 *   - 给了 `respondWith` → 原样作为 `json` 回放（用于结构化输出与 schema 校验测试）；
 *   - `embedding` → 由 prompt 哈希派生的固定维向量；
 *   - 其余 → `[stub:<taskKind>] <prompt>` 文本。
 * 真实供应商只需另写一个实现 `ChatProvider` 的类并在调用处注入，`runTask` 一行不改。
 */
export class StubProvider implements ChatProvider {
  readonly id: string;
  private readonly dim: number;
  constructor(id = "stub", embeddingDim = 8) {
    this.id = id;
    this.dim = embeddingDim;
  }
  async complete(req: ProviderRequest): Promise<ProviderResult> {
    const promptTokens = estTokens(req.prompt.length);
    if (req.respondWith !== undefined) {
      const completionTokens = estTokens(JSON.stringify(req.respondWith).length);
      return { modelId: req.model.id, json: req.respondWith, usage: { promptTokens, completionTokens } };
    }
    if (req.taskKind === "embedding") {
      return {
        modelId: req.model.id,
        embedding: stubUnitVector(req.prompt, this.dim),
        usage: { promptTokens, completionTokens: 0 },
      };
    }
    const text = `[stub:${req.taskKind}] ${req.prompt}`;
    return { modelId: req.model.id, text, usage: { promptTokens, completionTokens: estTokens(text.length) } };
  }
}

/* ─────────────────────────── 调用记录 & 记录器（§31） ─────────────────────────── */

export interface CallRecord {
  taskId: string;
  timestamp: string;
  providerId: string;
  modelId: string;
  tier: ModelTier;
  taskKind: ModelTaskKind;
  latencyMs: number;
  usage: TokenUsage;
  estimatedCostUsd: number;
  status: "ok" | "schema_invalid" | "provider_error";
  /** 成本归因（§31 每 Agent / 案例 / 方案成本看板用；M1 仅透传进记录，看板延 M2）。 */
  agent?: string;
  caseId?: string;
  solutionId?: string;
}

export interface CallRecorder {
  record(rec: CallRecord): void;
}

/** 默认记录器：结构化日志（绝不落任何密钥；只记成本/层级/状态等运营指标）。 */
export const loggingRecorder: CallRecorder = {
  record(rec) {
    logger.info("model router call", {
      module: "model-router",
      taskId: rec.taskId,
      providerId: rec.providerId,
      modelId: rec.modelId,
      tier: rec.tier,
      taskKind: rec.taskKind,
      status: rec.status,
      estimatedCostUsd: rec.estimatedCostUsd,
      promptTokens: rec.usage.promptTokens,
      completionTokens: rec.usage.completionTokens,
      latencyMs: rec.latencyMs,
      agent: rec.agent,
      caseId: rec.caseId,
      solutionId: rec.solutionId,
    });
  },
};

/** 内存记录器（测试 / 上层聚合用）：收集全部记录，可按维度求和成本。 */
export function createMemoryRecorder(): CallRecorder & { calls: CallRecord[]; totalCostUsd(): number } {
  const calls: CallRecord[] = [];
  return {
    calls,
    record(rec) {
      calls.push(rec);
    },
    totalCostUsd() {
      return Math.round(calls.reduce((s, c) => s + c.estimatedCostUsd, 0) * 1e6) / 1e6;
    },
  };
}

/* ─────────────────────────── 核心编排：runTask ─────────────────────────── */

export interface RunTaskRequest {
  taskKind: ModelTaskKind;
  prompt: string;
  /** 传入即要求结构化输出并经 Zod 校验（§17：所有生成内容用结构化 JSON 作中间格式）。 */
  schema?: z.ZodTypeAny;
  /** 覆盖路由层级（如核心财务判断显式升 `high`）；不传则按 `ROUTING_POLICY`。 */
  tier?: ModelTier;
  /** 注入 provider（真实供应商 / 测试替身）；不传用确定性 StubProvider。 */
  provider?: ChatProvider;
  /** StubProvider 回放的期望结构化输出（离线确定性；真实 provider 忽略）。 */
  respondWith?: unknown;
  agent?: string;
  caseId?: string;
  solutionId?: string;
  signal?: AbortSignal;
}

export interface RouterDeps {
  provider?: ChatProvider;
  recorder?: CallRecorder;
}

export interface ModelOutput {
  text?: string;
  json?: unknown;
  embedding?: number[];
}

export type RunTaskResult =
  | { status: "ok"; output: ModelOutput; record: CallRecord }
  | { status: "schema_invalid"; issues: z.ZodError["issues"]; output: ModelOutput; record: CallRecord }
  | { status: "provider_error"; message: string; record: CallRecord };

const defaultProvider = new StubProvider();
let taskSeq = 0;
function nextTaskId(taskKind: ModelTaskKind): string {
  taskSeq += 1;
  return `${taskKind}-${taskSeq}`;
}

/**
 * 唯一的调用原语（§16 六个语义入口都走它）。契约：
 *   1. 按 `tier ?? ROUTING_POLICY[taskKind]` 选层级与（占位）模型，取注入或默认 provider；
 *   2. 调 `provider.complete`；抛错 → 归一为 `provider_error`（**绝不向业务抛裸异常**，宪法不崩不误报）；
 *   3. 若带 `schema` → 对结构化输出做 Zod `safeParse`，不过 → `schema_invalid` + **指名 issues（不静默放过）**；
 *   4. **无论何种结局都产出一条 `CallRecord` 并经 recorder 记录**（成本可追踪，§31）；
 *   5. 成本由 `estimateCost` 程序计算，非模型口算。
 */
export async function runTask(
  req: RunTaskRequest,
  deps: RouterDeps = {},
): Promise<RunTaskResult> {
  const tier: ModelTier = req.tier ?? ROUTING_POLICY[req.taskKind];
  const model = MODEL_CATALOG[tier];
  const provider = req.provider ?? deps.provider ?? defaultProvider;
  const recorder = deps.recorder ?? loggingRecorder;
  const taskId = nextTaskId(req.taskKind);
  const startedAt = Date.now();

  const finalize = (
    status: CallRecord["status"],
    usage: TokenUsage,
    output: ModelOutput,
    extra: { issues?: z.ZodError["issues"]; message?: string },
  ): RunTaskResult => {
    const record: CallRecord = {
      taskId,
      timestamp: new Date(startedAt).toISOString(),
      providerId: provider.id,
      modelId: model.id,
      tier,
      taskKind: req.taskKind,
      latencyMs: Math.max(0, Date.now() - startedAt),
      usage,
      estimatedCostUsd: estimateCost(model, usage),
      status,
      ...(req.agent ? { agent: req.agent } : {}),
      ...(req.caseId ? { caseId: req.caseId } : {}),
      ...(req.solutionId ? { solutionId: req.solutionId } : {}),
    };
    recorder.record(record);
    if (status === "provider_error") {
      return { status: "provider_error", message: extra.message ?? "provider failed", record };
    }
    if (status === "schema_invalid") {
      return { status: "schema_invalid", issues: extra.issues ?? [], output, record };
    }
    return { status: "ok", output, record };
  };

  let res: ProviderResult;
  try {
    res = await provider.complete({
      taskKind: req.taskKind,
      model,
      prompt: req.prompt,
      respondWith: req.respondWith,
      signal: req.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finalize("provider_error", { promptTokens: 0, completionTokens: 0 }, {}, { message });
  }

  const output: ModelOutput = {
    ...(res.text !== undefined ? { text: res.text } : {}),
    ...(res.json !== undefined ? { json: res.json } : {}),
    ...(res.embedding !== undefined ? { embedding: res.embedding } : {}),
  };

  if (req.schema) {
    const parsed = req.schema.safeParse(res.json);
    if (!parsed.success) {
      return finalize("schema_invalid", res.usage, output, { issues: parsed.error.issues });
    }
    return finalize("ok", res.usage, { ...output, json: parsed.data }, {});
  }
  return finalize("ok", res.usage, output, {});
}

/* ─────────────────────────── §16 统一语义入口（薄封装） ─────────────────────────── */

/** 自由文本生成。 */
export function generateText(prompt: string, deps?: RouterDeps, opts?: Omit<RunTaskRequest, "taskKind" | "prompt">) {
  return runTask({ taskKind: "generate_text", prompt, ...opts }, deps);
}

/** 结构化输出：必须带 Zod schema，产出经校验的 JSON（§17 中间格式契约的执行点）。 */
export function structuredOutput<T extends z.ZodTypeAny>(
  prompt: string,
  schema: T,
  deps?: RouterDeps,
  opts?: Omit<RunTaskRequest, "taskKind" | "prompt" | "schema">,
) {
  return runTask({ taskKind: "structured_output", prompt, schema, ...opts }, deps);
}

/** 复杂研究（默认 high 层，可被 §33 多角色 Bull/Bear/Judge/QA 流水线复用）。 */
export function research(prompt: string, deps?: RouterDeps, opts?: Omit<RunTaskRequest, "taskKind" | "prompt">) {
  return runTask({ taskKind: "research", prompt, ...opts }, deps);
}

/** 向量化（检索 / 去重 / 匹配用）。 */
export function embed(text: string, deps?: RouterDeps, opts?: Omit<RunTaskRequest, "taskKind" | "prompt">) {
  return runTask({ taskKind: "embedding", prompt: text, ...opts }, deps);
}

/** 图像理解（占位入口，真实实现延后）。 */
export function vision(prompt: string, deps?: RouterDeps, opts?: Omit<RunTaskRequest, "taskKind" | "prompt">) {
  return runTask({ taskKind: "vision", prompt, ...opts }, deps);
}

/** 代码相关生成（占位入口，真实实现延后）。 */
export function code(prompt: string, deps?: RouterDeps, opts?: Omit<RunTaskRequest, "taskKind" | "prompt">) {
  return runTask({ taskKind: "code", prompt, ...opts }, deps);
}
