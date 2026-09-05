import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MODEL_CATALOG,
  StubProvider,
  runTask,
  type ModelTaskKind,
  type ProviderRequest,
} from "@/server/model-router";
import {
  DeepSeekProvider,
  deepSeekConfigFromEnv,
  createChatProvider,
  DEEPSEEK_TIER_HINT,
  type FetchLike,
  type DeepSeekConfig,
} from "@/server/deepseek-provider";

/**
 * Phase 9 M3 —— DeepSeek 真实供应商（OpenAI 兼容 `/chat/completions`）。
 *
 * 契约：**依赖注入假 fetch**，无网络、无真 key 也把「请求构造 / 响应解析 / 错误归一 / 密钥不落日志」
 *   整套离线测死。单测不加载 .env（`test:unit` 无 `--env-file`），故一律显式构造 `DeepSeekConfig`
 *   与注入 `env` 对象，**绝不依赖 `process.env`**。
 *
 * 覆盖：
 *   1. deepSeekConfigFromEnv：无/空白 key→null；有 key→默认 base；自定义 base 剥尾斜杠。
 *   2. createChatProvider：无 key→StubProvider；有 key→DeepSeekProvider（id "deepseek"）。
 *   3. 构造期早失败：空 apiKey 抛错且不回显。
 *   4. complete 请求构造：URL、方法、Authorization Bearer、body.model=真实 id、messages、
 *      结构化任务加 response_format、非结构化任务不加、signal 透传。
 *   5. complete 响应解析：文本、结构化 JSON→json、非法 JSON→仅 text（诚实）、usage 缺省→0、
 *      modelId 回落到请求 id。
 *   6. 边界：embedding 直抛不支持且不 fetch；非 2xx 抛「HTTP <status>」且不泄漏 key。
 *   7. runTask 集成：真实 provider + 假 fetch → ok + 解析 json + 程序计算成本；fetch 抛错 → provider_error 不外溢。
 */

const FAKE_KEY = "sk-SECRET-DO-NOT-LEAK-123";

/** 假 fetch：捕获每次 (url, init)，并按 spec 返回一个 OpenAI 风格响应（或抛错）。 */
function makeFetch(
  spec:
    | { kind: "json"; status?: number; body: unknown }
    | { kind: "throw"; error: Error },
): { fetch: FetchLike; calls: { url: string; init?: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (spec.kind === "throw") throw spec.error;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.body,
      text: async () => JSON.stringify(spec.body),
    };
  };
  return { fetch, calls };
}

/** 标准 chat completion 响应体。 */
function chatBody(content: string | null, usage?: { prompt_tokens?: number; completion_tokens?: number }, model?: string) {
  return {
    ...(model ? { model } : {}),
    choices: content == null ? [] : [{ message: { content } }],
    ...(usage ? { usage } : {}),
  };
}

function req(
  taskKind: ModelTaskKind,
  prompt = "你好",
  extra: Partial<Omit<ProviderRequest, "taskKind" | "prompt">> = {},
): ProviderRequest {
  return { taskKind, model: MODEL_CATALOG.medium, prompt, ...extra };
}

function providerWith(fetch: FetchLike, cfg: Partial<DeepSeekConfig> = {}): DeepSeekProvider {
  return new DeepSeekProvider({ apiKey: FAKE_KEY, baseUrl: "https://api.deepseek.com", ...cfg }, fetch);
}

/* ─────────────────────────── 1. deepSeekConfigFromEnv ─────────────────────────── */

describe("deepSeekConfigFromEnv", () => {
  it("无 key → null", () => {
    expect(deepSeekConfigFromEnv({})).toBeNull();
  });
  it("纯空白 key → null（不误判为有效）", () => {
    expect(deepSeekConfigFromEnv({ DEEPSEEK_API_KEY: "   " })).toBeNull();
  });
  it("有 key、无 base → 默认 api.deepseek.com", () => {
    const cfg = deepSeekConfigFromEnv({ DEEPSEEK_API_KEY: FAKE_KEY });
    expect(cfg).toEqual({ apiKey: FAKE_KEY, baseUrl: "https://api.deepseek.com" });
  });
  it("自定义 base 带尾斜杠 → 剥掉", () => {
    const cfg = deepSeekConfigFromEnv({
      DEEPSEEK_API_KEY: FAKE_KEY,
      DEEPSEEK_BASE_URL: "https://proxy.local/v1///",
    });
    expect(cfg?.baseUrl).toBe("https://proxy.local/v1");
  });
  it("key 首尾空白被裁剪", () => {
    const cfg = deepSeekConfigFromEnv({ DEEPSEEK_API_KEY: `  ${FAKE_KEY}  ` });
    expect(cfg?.apiKey).toBe(FAKE_KEY);
  });
});

/* ─────────────────────────── 2. createChatProvider 工厂 ─────────────────────────── */

describe("createChatProvider", () => {
  it("无 key → 回落确定性 StubProvider（离线/CI 可跑）", () => {
    const p = createChatProvider({});
    expect(p).toBeInstanceOf(StubProvider);
    expect(p.id).toBe("stub");
  });
  it("有 key → 真实 DeepSeekProvider（id 'deepseek'）", () => {
    const { fetch } = makeFetch({ kind: "json", body: chatBody("x") });
    const p = createChatProvider({ DEEPSEEK_API_KEY: FAKE_KEY }, fetch);
    expect(p).toBeInstanceOf(DeepSeekProvider);
    expect(p.id).toBe("deepseek");
  });
});

/* ─────────────────────────── 3. 构造期早失败 ─────────────────────────── */

describe("DeepSeekProvider 构造", () => {
  it("空 apiKey → 抛错，且错误信息不回显 key", () => {
    let msg = "";
    try {
      new DeepSeekProvider({ apiKey: "  ", baseUrl: "https://api.deepseek.com" }, () => {
        throw new Error("不应被调用");
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("apiKey");
    expect(msg).not.toContain(FAKE_KEY);
  });
});

/* ─────────────────────────── 4. 请求构造契约 ─────────────────────────── */

describe("DeepSeekProvider.complete 请求构造", () => {
  it("generate_text：POST 到 /chat/completions、Bearer 头、model 用真实 id、无 response_format", async () => {
    const { fetch, calls } = makeFetch({ kind: "json", body: chatBody("pong", { prompt_tokens: 5, completion_tokens: 3 }, "deepseek-chat") });
    const p = providerWith(fetch);
    const res = await p.complete(req("generate_text", "ping"));

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    const payload = JSON.parse(init!.body as string);
    expect(payload.model).toBe(MODEL_CATALOG.medium.id);
    expect(payload.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(payload.response_format).toBeUndefined();

    expect(res.text).toBe("pong");
    expect(res.modelId).toBe("deepseek-chat");
    expect(res.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
  });

  it("结构化任务：带 response_format:{type:json_object}", async () => {
    const { fetch, calls } = makeFetch({ kind: "json", body: chatBody('{"ok":true}') });
    const p = providerWith(fetch);
    await p.complete(req("structured_output", "give json"));
    const payload = JSON.parse(calls[0].init!.body as string);
    expect(payload.response_format).toEqual({ type: "json_object" });
  });

  it("signal 透传给 fetch", async () => {
    const ctrl = new AbortController();
    const { fetch, calls } = makeFetch({ kind: "json", body: chatBody("ok") });
    const p = providerWith(fetch);
    await p.complete(req("generate_text", "hi", { signal: ctrl.signal }));
    expect(calls[0].init?.signal).toBe(ctrl.signal);
  });

  it("自定义 baseUrl（无尾斜杠）拼进请求 URL", async () => {
    const { fetch, calls } = makeFetch({ kind: "json", body: chatBody("ok") });
    const p = providerWith(fetch, { baseUrl: "https://gw.internal/v1/" });
    await p.complete(req("generate_text"));
    expect(calls[0].url).toBe("https://gw.internal/v1/chat/completions");
  });
});

/* ─────────────────────────── 5. 响应解析 ─────────────────────────── */

describe("DeepSeekProvider.complete 响应解析", () => {
  it("结构化：合法 JSON content → 同时回 json 与 text", async () => {
    const { fetch } = makeFetch({ kind: "json", body: chatBody('{"answer":"42"}') });
    const p = providerWith(fetch);
    const res = await p.complete(req("structured_output"));
    expect(res.json).toEqual({ answer: "42" });
    expect(res.text).toBe('{"answer":"42"}');
  });

  it("结构化：非法 JSON content → 诚实只回 text、json undefined", async () => {
    const { fetch } = makeFetch({ kind: "json", body: chatBody("这不是 JSON") });
    const p = providerWith(fetch);
    const res = await p.complete(req("structured_output"));
    expect(res.json).toBeUndefined();
    expect(res.text).toBe("这不是 JSON");
  });

  it("usage 缺失 → 归零（不 NaN）", async () => {
    const { fetch } = makeFetch({ kind: "json", body: chatBody("hi") });
    const p = providerWith(fetch);
    const res = await p.complete(req("generate_text"));
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it("响应无 model → 回落请求的 model id", async () => {
    const { fetch } = makeFetch({ kind: "json", body: chatBody("hi", { prompt_tokens: 1, completion_tokens: 1 }) });
    const p = providerWith(fetch);
    const res = await p.complete(req("generate_text"));
    expect(res.modelId).toBe(MODEL_CATALOG.medium.id);
  });

  it("负数 token 归零（numOr0 护栏）", async () => {
    const { fetch } = makeFetch({ kind: "json", body: chatBody("hi", { prompt_tokens: -7, completion_tokens: 4 }) });
    const p = providerWith(fetch);
    const res = await p.complete(req("generate_text"));
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 4 });
  });
});

/* ─────────────────────────── 6. 边界与错误归一 ─────────────────────────── */

describe("DeepSeekProvider 边界", () => {
  it("embedding → 直抛不支持，且绝不发起 fetch", async () => {
    const { fetch, calls } = makeFetch({ kind: "json", body: chatBody("nope") });
    const p = providerWith(fetch);
    await expect(p.complete(req("embedding"))).rejects.toThrow(/embedding/);
    expect(calls).toHaveLength(0);
  });

  it("非 2xx → 抛「HTTP <status>」，错误信息不含 key、不含响应体", async () => {
    const { fetch } = makeFetch({ kind: "json", status: 401, body: { error: { message: `bad key ${FAKE_KEY}` } } });
    const p = providerWith(fetch);
    let msg = "";
    try {
      await p.complete(req("generate_text"));
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("HTTP 401");
    expect(msg).not.toContain(FAKE_KEY);
  });
});

/* ─────────────────────────── 7. runTask 集成（provider 可插拔接缝） ─────────────────────────── */

describe("runTask × DeepSeekProvider（接缝验证）", () => {
  it("结构化：真实 provider + 假 fetch → status ok + 解析 json + 程序计算成本", async () => {
    const { fetch } = makeFetch({
      kind: "json",
      body: chatBody('{"answer":"42"}', { prompt_tokens: 1000, completion_tokens: 1000 }),
    });
    const provider = providerWith(fetch);
    const schema = z.object({ answer: z.string() });

    const r = await runTask(
      { taskKind: "structured_output", prompt: "answer?", schema, provider },
      { recorder: { record() {} } },
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.output.json).toEqual({ answer: "42" });
      // medium 默认单价 in 0.002 / out 0.006，1K+1K → 0.008（程序计算，非模型口算）
      expect(r.record.estimatedCostUsd).toBe(0.008);
      expect(r.record.providerId).toBe("deepseek");
      expect(r.record.status).toBe("ok");
    }
  });

  it("provider 抛错 → runTask 归一 provider_error，绝不向业务外溢异常", async () => {
    const { fetch } = makeFetch({ kind: "throw", error: new Error("network down") });
    const provider = providerWith(fetch);
    const r = await runTask(
      { taskKind: "generate_text", prompt: "hi", provider },
      { recorder: { record() {} } },
    );
    expect(r.status).toBe("provider_error");
    if (r.status === "provider_error") {
      expect(r.message).toContain("network down");
      expect(r.record.status).toBe("provider_error");
    }
  });

  it("结构化返回非法 JSON → schema_invalid（诚实暴露，不静默放过）", async () => {
    const { fetch } = makeFetch({ kind: "json", body: chatBody("plain text", { prompt_tokens: 10, completion_tokens: 5 }) });
    const provider = providerWith(fetch);
    const schema = z.object({ answer: z.string() });
    const r = await runTask(
      { taskKind: "structured_output", prompt: "answer?", schema, provider },
      { recorder: { record() {} } },
    );
    // content 不是合法 JSON → provider 只回 text、json undefined → runTask 对 undefined 校验失败
    expect(r.status).toBe("schema_invalid");
  });
});

/* ─────────────────────────── 8. 层级映射提示（文档常量） ─────────────────────────── */

describe("DEEPSEEK_TIER_HINT", () => {
  it("三层级都有提示，high 用推理模型", () => {
    expect(DEEPSEEK_TIER_HINT.low).toBe("deepseek-chat");
    expect(DEEPSEEK_TIER_HINT.medium).toBe("deepseek-chat");
    expect(DEEPSEEK_TIER_HINT.high).toBe("deepseek-reasoner");
  });
});
