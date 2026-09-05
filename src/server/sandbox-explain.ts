import { z } from "zod";
import { logger } from "@/lib/logger";
import {
  runTask,
  type CallRecord,
  type CallRecorder,
  type ChatProvider,
  type ModelTier,
} from "@/server/model-router";
import { createChatProvider } from "@/server/deepseek-provider";

/**
 * 沙盘「AI 解释」编排（中途重构 R6.2 · §7「关键数字必须程序算、LLM 只解释」里 **LLM 负责的那一半**）。
 *
 * 为什么存在：R6.1（v0.43.0）已把引擎输出确定性地叙述成一份中文报告（`buildSandboxReport`），
 *   但报告只讲「是什么」，不讲「为什么」——用户拖了参数后想知道「为何 NPV 这样、哪个变量最左右结果、
 *   若再改某参数会怎么走」（§14 优先级第 10 项 AI 解释 / 总控「AI 解释『为何变/最敏感/what-if』」）。
 *   本模块把这条**自然语言解释**接到现成的 Model Router（`runTask`）+ 真实 DeepSeek（`createChatProvider`，
 *   无 key 回落确定性桩）上，成本经 `ModelCall` 表追踪（§31，复用 Phase 9 M5 的记录器注入 + flush 惯例）。
 *
 * ★ 铁律「只解释、绝不算数」（§7 / 第 16 条单一真源 / 第 20 条诚实）：
 *   - LLM 的**唯一输入**是 R6.1 已经算好的确定性报告（`SandboxReport` 的 JSON），它的每个数字都是程序算出的；
 *   - 提示词明令：**不得重算 / 修改 / 杜撰任何数字**，只能引用报告已出现的数字与原话；what-if 只允许**定性**
 *     描述（「若充电单价上升，NPV 通常随之改善」），**不得给出新的具体数值**；
 *   - 输出经 Zod 结构校验（§17 中间格式），provider 报错 / 不合 schema 一律**诚实归一**、绝不裸抛、绝不半渲染；
 *   - 报告本身 `ok=false`（参数不足以出结论）时**诚实拒绝解释**（blocked），绝不给脏场景编一段看似合理的解读。
 *
 * 为什么是 server-only + HTTP 端点（不同于 R4/R6.1 纯前端）：真实 DeepSeek 调用要带**服务端密钥**，
 *   绝不可打进浏览器 bundle；故解释必须走一条受门禁的 `POST /api/sandbox/explain`（登录用户方可消耗真实额度）。
 *   provider 经依赖注入解耦：生产有 key 走真实模型、离线单测注入确定性 `StubProvider + fixture` 把整条契约测死
 *   （与 `research-pipeline` / `solution-generation` / `model-router` 同构）。本文件按 server 域逻辑对待
 *   （**本仓约定不 `import "server-only"`**，vitest / 纯 node 下会抛错）。
 */

const log = logger.child({ module: "server/sandbox-explain" });

/* ─────────────────────────── 版本（第 13 条：可回滚、改契约须升版记因） ─────────────────────────── */

/** 解释契约版本（提示词口径 / 输出 schema / 归因标签变更须升版并说明原因）。 */
export const EXPLAIN_VERSION = "1.0.0";

/** 路由层级（v1 设计假设，§32「非所有任务都用最贵模型」）：沙盘解释是在既有确定结论上的中等难度解读 → medium。 */
export const EXPLAIN_TIER: ModelTier = "medium";

/** ModelCall 成本归因标签（§31 看板按 agent 维度聚合）。 */
export const EXPLAIN_AGENT = "sandbox:explain";

/* ─────────────────────────── 入参 schema（R6.1 确定性报告的输入侧契约） ─────────────────────────── */

/**
 * 客户端回传的「当前沙盘报告」的最小结构校验（与 `@/lib/sandbox-report` 的 `SandboxReport` 对齐）。
 * 刻意只校验解释真正要用的字段（ok / title / regionName / sections / disclaimers），
 * `generatedFrom` 等纯溯源字段留 `unknown` 透传不深校验，避免为校验而 coupling 全部内部结构（第 15 条少依赖）。
 */
export const sandboxReportInputSchema = z.object({
  reportVersion: z.string().min(1),
  ok: z.boolean(),
  title: z.string().min(1),
  regionName: z.string().min(1),
  generatedFrom: z.unknown().optional(),
  sections: z
    .array(
      z.object({
        key: z.string().min(1),
        title: z.string().min(1),
        kind: z.enum(["prose", "bullets", "list"]),
        paragraphs: z.array(z.string()).optional(),
        items: z
          .array(z.object({ label: z.string(), value: z.string() }))
          .optional(),
      }),
    )
    .min(1)
    .max(40),
  disclaimers: z.array(z.string()).optional(),
});
export type SandboxReportInput = z.infer<typeof sandboxReportInputSchema>;

/* ─────────────────────────── 输出 schema（§17 结构化中间格式） ─────────────────────────── */

const strArray = z.array(z.string().min(1)).default([]);

export const explanationSchema = z.object({
  // 「为何当前结果如此」——只引用报告已给数字做解读。
  interpretation: z.string().min(1),
  // 最敏感 / 最关键变量的定性点评。
  keyDrivers: strArray,
  // what-if 定性走势（严禁新的具体数值）。
  whatIf: strArray,
  // 需人工核实 / 风险提醒。
  risks: strArray,
  // 恒应需人工复核；缺省 true（宁可多标不可漏标）。
  needsHumanReview: z.boolean().default(true),
});
export type Explanation = z.infer<typeof explanationSchema>;

/* ─────────────────────────── 提示词构造（确定性：无时钟 / 无随机） ─────────────────────────── */

function roleInstruction(): string {
  return [
    "你是「产业项目可视化决策沙盘」的解释助手。下面是一份**由确定性计算引擎算好、已经生成完毕**的沙盘报告（中文、结构化）。",
    "你的**唯一任务**是向非专业用户**解释**这份报告：为什么得到这样的结论、哪些变量最左右结果、以及定性的 what-if 走势。",
    "铁律一（只解释不算数）：你**不得**重新计算、修改或杜撰任何数字；只能引用报告中**已经出现**的数字与原话。",
    "铁律二（what-if 只定性）：任何假设性推演只能做**定性**描述（例如「若充电单价上升，NPV 通常会随之改善」），**严禁**给出报告里没有的新具体数值。",
    "铁律三（诚实与风险）：必须提醒用户——所有入参均为占位假设、经济口径为透明简化的 E1–E8 而非可研级、结论需专业人工确认、不得作为投资或并网决策依据。",
    "用简体中文作答，语气中立审慎，不得把假设/推断包装成既定事实。",
    '严格只输出一个 JSON 对象，结构为 {"interpretation": 非空字符串, "keyDrivers": 字符串数组, "whatIf": 字符串数组, "risks": 字符串数组, "needsHumanReview": 布尔}。',
  ].join("\n");
}

/** 把确定性报告压平成 prompt 里的「已知事实」段（bullets→键值串、prose/list→段落串），不新增任何数值。 */
function flattenReportForPrompt(report: SandboxReportInput): string {
  const lines: string[] = [];
  lines.push(`标题：${report.title}`);
  lines.push(`地区：${report.regionName}`);
  for (const s of report.sections) {
    const body =
      s.kind === "bullets"
        ? (s.items ?? []).map((i) => `${i.label}=${i.value}`).join("；")
        : (s.paragraphs ?? []).join("　");
    lines.push(`【${s.title}】${body}`);
  }
  if (report.disclaimers && report.disclaimers.length) {
    lines.push(`既有声明：${report.disclaimers.join(" ")}`);
  }
  return lines.join("\n");
}

/**
 * 纯函数：拼装发给模型的 prompt（确定性、可单测）。`question` 为用户可选追问（截断防灌入）。
 */
export function buildExplainPrompt(report: SandboxReportInput, question?: string): string {
  const parts = [roleInstruction(), "=== 沙盘报告（确定性引擎已算好，仅供解释、不得改动） ==="];
  parts.push(flattenReportForPrompt(report));
  const q = question?.trim();
  if (q) parts.push(`=== 用户追问 ===\n${q.slice(0, 2000)}`);
  return parts.join("\n");
}

/* ─────────────────────────── 依赖 & 结果（判别联合，永不裸抛） ─────────────────────────── */

export interface ExplainDeps {
  /** 覆盖 provider（测试注入 StubProvider+fixture 离线跑；缺省 `createChatProvider()`）。 */
  provider?: ChatProvider;
  /** 成本记录器（路由注入 `createDbCallRecorder()` 落 ModelCall 表；缺省走结构化日志）。 */
  recorder?: CallRecorder;
  /** 层级覆写（缺省 `EXPLAIN_TIER`）。 */
  tier?: ModelTier;
  /** 离线确定性回放（仅 StubProvider 生效，真实 provider 忽略）：直接给定期望结构化解释。 */
  fixture?: unknown;
}

export interface ExplainOkPayload {
  status: "ok";
  explanation: Explanation;
  /** 本次调用的模型 id（真实 DeepSeek 或桩），供前端透明展示。 */
  modelId: string;
  /** 归因 agent 与本次程序计算成本（§31）。 */
  agent: string;
  cost: { calls: number; totalCostUsd: number };
  explainVersion: string;
}

/**
 * 判别联合，状态字面量对齐 `api-guard.mutationResponse` 可翻译的集合（ok/invalid/blocked/error），
 * 便于路由一行 `mutationResponse(...)` 统一口径翻译（第 16 条）。
 */
export type ExplainResult =
  | ExplainOkPayload
  | { status: "invalid"; fieldErrors: Record<string, string[]> }
  | { status: "blocked"; fieldErrors?: Record<string, string[]>; error?: string }
  | { status: "error"; error: string };

/**
 * 解释一份沙盘报告。契约：
 *   1. `report.ok=false` → **诚实拒绝解释**（blocked），绝不给脏场景编解读；
 *   2. 拼确定性 prompt → `runTask`（`structured_output`、经 Zod `explanationSchema` 校验、成本入 recorder、
 *      `agent=sandbox:explain`）；
 *   3. provider 报错 → error（透出短消息，不带密钥）；不合 schema → error（附字段级 issues 计数，不半渲染）；
 *   4. 成功 → 回解释正文 + 模型 id + 程序计算成本（§31），并**始终保留人工复核**声明。
 */
export async function explainSandboxScenario(
  report: SandboxReportInput,
  opts: { question?: string } = {},
  deps: ExplainDeps = {},
): Promise<ExplainResult> {
  if (!report.ok) {
    log.info("explain refused: report not ok", { reason: "report.ok=false" });
    return {
      status: "blocked",
      fieldErrors: { report: ["当前参数不足以形成有效结论，AI 拒绝解释不完整的报告；请先修正参数再试。"] },
    };
  }

  const provider = deps.provider ?? createChatProvider();
  const prompt = buildExplainPrompt(report, opts.question);

  const res = await runTask(
    {
      taskKind: "structured_output",
      prompt,
      schema: explanationSchema,
      tier: deps.tier ?? EXPLAIN_TIER,
      provider,
      respondWith: deps.fixture,
      agent: EXPLAIN_AGENT,
    },
    { recorder: deps.recorder },
  );

  if (res.status === "provider_error") {
    log.warn("explain provider error", { message: res.message });
    return { status: "error", error: `AI 解释调用失败：${res.message}` };
  }
  if (res.status === "schema_invalid") {
    log.warn("explain schema invalid", { issues: res.issues.length });
    return {
      status: "error",
      error: "AI 返回的解释未通过结构校验，已丢弃以避免呈现脏解读，请稍后重试。",
    };
  }

  const explanation = res.output.json as Explanation;
  log.info("explained sandbox scenario", {
    modelId: res.record.modelId,
    costUsd: res.record.estimatedCostUsd,
  });
  return {
    status: "ok",
    explanation,
    modelId: res.record.modelId,
    agent: EXPLAIN_AGENT,
    cost: { calls: 1, totalCostUsd: res.record.estimatedCostUsd },
    explainVersion: EXPLAIN_VERSION,
  };
}

/** 复用既有 CallRecord 成本口径，导出一份给测试/路由校验用的类型引用（避免重复定义成本字段）。 */
export type { CallRecord };
