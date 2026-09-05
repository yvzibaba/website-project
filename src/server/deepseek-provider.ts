import {
  type ChatProvider,
  type ProviderRequest,
  type ProviderResult,
  type ModelTier,
  StubProvider,
} from "@/server/model-router";

/**
 * DeepSeek 真实供应商（Phase 9 M3，OpenAI 兼容 `/chat/completions`）——把「模型经 Model Router 解耦、
 *   禁止绑定单一模型」从骨架落到实处：M1/M2 只有确定性 `StubProvider`，本模块提供第一个真接网络的
 *   `ChatProvider` 实现，**`runTask` 一行不改**，业务侧只换注入的 provider 即可从桩切到真实模型。
 *
 * 设计要点（宪法）：
 *   - **依赖注入 fetch**：`fetchImpl` 默认 `globalThis.fetch`，单测注入假 fetch → 无网络、无 key 也把
 *     请求构造 / 响应解析 / 错误归一整套契约离线测死（同 M1 StubProvider 的可测精神）。
 *   - **绝不在日志/错误里落密钥**：错误只带 HTTP 状态与短消息；`Authorization` 头只在发出的请求里，不回填。
 *   - **成本仍由 Model Router 程序计算**：本 provider 只回传真实 `usage`（prompt/completion tokens），
 *     `runTask` 据 `MODEL_CATALOG[tier]` 单价算成本——单价经 env 覆写为 DeepSeek 真实值（见 `.env.example`），
 *     不在源码硬编码为「事实」（宪法「关键数字来源可追溯、假设可标注可调」）。
 *   - **模型名不硬编码进业务**：调用用哪真实模型 = `req.model.id`（来自可被 env 覆写的目录）。
 *   - **诚实边界**：DeepSeek 无 embedding 端点 → `embedding` 任务直接抛「不支持」，交由 `runTask` 归一
 *     `provider_error`，绝不假装返回向量（宪法第 20 条）。结构化任务（§17）请求 `response_format:json_object`
 *     并把 content 解析为 `json` 交 `runTask` 的 Zod 校验；解析不出即为 undefined → 诚实 `schema_invalid`。
 */

/** 需要向模型索要结构化 JSON 的任务类型（§17：生成内容用结构化 JSON 中间格式）。 */
const JSON_RESPONSE_TASKS = new Set<string>([
  "structured_output",
  "research",
  "code",
  "vision",
]);

/** 最小 fetch 形态（够测试用；避免依赖完整 undici 类型）。 */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface DeepSeekConfig {
  /** DeepSeek API Key（仅服务端从 env 读，绝不进前端 / Git / 日志）。 */
  apiKey: string;
  /** OpenAI 兼容基址，缺省 `https://api.deepseek.com`；无尾斜杠。 */
  baseUrl: string;
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** 从 env 解析 DeepSeek 配置；无 key（或纯空白）→ null（上层据此回落到 StubProvider）。 */
export function deepSeekConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DeepSeekConfig | null {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  const base = (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "");
  return { apiKey, baseUrl: base };
}

/**
 * OpenAI 兼容的 DeepSeek ChatProvider。用 `req.model.id` 作真实模型名、`req.model.tier` 由目录决定
 * （调用方通过 env `MODEL_ID_*` 把 low/medium/high 映射到 desired DeepSeek 模型，如 deepseek-chat / deepseek-reasoner）。
 */
export class DeepSeekProvider implements ChatProvider {
  readonly id = "deepseek";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: DeepSeekConfig, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {
    if (!cfg.apiKey || cfg.apiKey.trim() === "") {
      // 早失败于构造期（不是每次请求才失败）；但**不**回显 key。
      throw new Error("DeepSeekProvider 需要非空 apiKey");
    }
    this.apiKey = cfg.apiKey.trim();
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  async complete(req: ProviderRequest): Promise<ProviderResult> {
    if (req.taskKind === "embedding") {
      throw new Error("DeepSeek 未提供 embedding 端点（§16 embedding 请配独立向量供应商）");
    }
    const wantJson = JSON_RESPONSE_TASKS.has(req.taskKind);
    // DeepSeek 硬约束（真实 API 实测：chat 与 reasoner 皆然）：启用 response_format=json_object 时，
    // prompt 必须**字面包含 "json"** 否则直接 HTTP 400（"Prompt must contain the word 'json'..."）。
    // 而 §33 流水线的中文 prompt 从不出现该词——故这一供应商专属的补强只放在**本适配器**里（业务/流水线
    // 保持供应商无关、一行不改），既满足约束又顺带提升 JSON 输出的稳定性。
    const userContent = wantJson
      ? `${req.prompt}\n\n请严格只输出一个合法的 JSON 对象（respond with valid JSON only, no extra prose）。`
      : req.prompt;
    const payload: Record<string, unknown> = {
      model: req.model.id,
      messages: [{ role: "user", content: userContent }],
    };
    if (wantJson) payload.response_format = { type: "json_object" };

    const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: req.signal,
    });

    if (!resp.ok) {
      // 仅记状态，绝不回显响应体（可能含账户信息）或 key。抛错 → runTask 归一 provider_error。
      throw new Error(`DeepSeek 调用失败：HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    const usage = {
      promptTokens: numOr0(data.usage?.prompt_tokens),
      completionTokens: numOr0(data.usage?.completion_tokens),
    };
    const modelId = data.model || req.model.id;

    if (wantJson) {
      if (content != null) {
        try {
          const json = JSON.parse(content);
          return { modelId, json, text: content, usage };
        } catch {
          // content 不是合法 JSON：诚实只回 text、不回 json → runTask 对 undefined 做 schema 校验得 schema_invalid。
          return { modelId, text: content, usage };
        }
      }
      return { modelId, text: content, usage };
    }
    return { modelId, text: content, usage };
  }
}

/** 层级默认映射（可被 env `MODEL_ID_*` 经目录覆写覆盖实际调用模型；此处仅作说明/兜底类型）。 */
export const DEEPSEEK_TIER_HINT: Record<ModelTier, string> = {
  low: "deepseek-chat",
  medium: "deepseek-chat",
  high: "deepseek-reasoner",
};

/**
 * 供应商工厂（§16「业务只经 Model Router」的落地选择点）：**有 key 用真实 DeepSeek，无 key 回落确定性 Stub**。
 * 上层（如把 §33 流水线接到真实方案生成）只需 `runTask(req, { provider: createChatProvider() })`，
 * 开发/CI 无 key 时自动走桩、离线可测，生产配 key 即真实调用，无需分支判断散落各处。
 */
export function createChatProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): ChatProvider {
  const cfg = deepSeekConfigFromEnv(env);
  return cfg ? new DeepSeekProvider(cfg, fetchImpl) : new StubProvider();
}
