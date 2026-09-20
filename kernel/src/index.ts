/**
 * @app/kernel —— 领域内核公共入口（barrel）。
 *
 * ## 这是什么
 *
 * 光储充重卡项目的**确定性技术经济计算内核**：参数分层解析 → 技术能耗模型 → 逐年现金流 →
 * NPV / IRR / ROI / 回收期 → 敏感性 tornado → 动态报告，外加评分内核、研究流水线与 Model Router。
 *
 * ## 为什么用命名空间导出而不是 `export *`
 *
 * 内核有 40 个模块、导出面数百个符号。历史上 `lib/` 与 `server/` 下曾存在**同名**模块
 * （`sandbox-solution-source` 两侧各一个：一个是 client-safe 的纯映射，一个是服务端查库编排），
 * 平铺 `export *` 会静默丢失重名符号（TS 不报错，运行时拿到 `undefined`）——
 * 这是最阴险的一类缺陷。命名空间导出把这种碰撞变成**编译期不可能**。
 *
 * V2 P-1 已把服务端那一侧改名（`solution-source-server`），当前两侧**已无重名模块**；
 * 命名空间导出照旧保留——它不只是修当时的 bug，而是**结构性防再犯**：把公开 API 面钉在
 * 「命名空间.符号」，日后新增同名模块或拆分模块都不会悄悄改变既有调用点的含义。
 *
 * ## 两种消费方式
 *
 * ```ts
 * // 方式一：从 barrel 取（推荐，公开 API 面稳定）
 * import { projectParams, parameterEngine } from "@app/kernel";
 *
 * // 方式二：深路径直取（细粒度、tree-shaking 友好；由 package.json exports 的 "./*" 支持）
 * import { PARAMS_VERSION } from "@app/kernel/server/project-params";
 * ```
 *
 * ## 边界（不可越）
 *
 * 本包**零框架依赖**：不得出现 `next` / `react` / `next-auth` / UI 组件 / Route Handler。
 * 允许的外部依赖仅：`zod`、`@prisma/client`、`node:crypto`、`node:util`。
 * 守卫命令：`npm run kernel:verify`（见 `.kernel-tools/verify_kernel.mjs`）。
 *
 * 内核**不知道**谁在鉴权、用什么底座、页面长什么样。宿主把自己的会话适配成
 * `roles.SessionUser` 形状后传进来，其余交给内核。
 */

/* ───────────────────────────── lib（纯工具与 client-safe 映射） ───────────────────────────── */

export * as logger from "./lib/logger";
export * as password from "./lib/password";
export * as prisma from "./lib/prisma";
export * as roles from "./lib/roles";
export * as validation from "./lib/validation";
export * as projectRestore from "./lib/project-restore";
export * as decisionReport from "./lib/decision-report";
export * as solutionLineage from "./lib/solution-lineage";
export * as solutionProvenance from "./lib/solution-provenance";
/** client-safe 的纯映射（可进浏览器 bundle）。服务端查库编排见下方 `solutionSourceServer`。 */
export * as solutionSource from "./lib/solution-source";
export * as solutionDraft from "./lib/solution-draft";
export * as decisionView from "./lib/decision-view";

/* ───────────────────────────── server（服务端领域逻辑，直接 import prisma） ───────────────────────────── */

export * as caseScores from "./server/case-scores";
export * as deepseekProvider from "./server/deepseek-provider";
export * as modelRouter from "./server/model-router";
export * as parameterEngine from "./server/parameter-engine";
export * as researchPipeline from "./server/research-pipeline";
export * as demoProject from "./server/demo-project";
export * as decisionExplain from "./server/decision-explain";
export * as finance from "./server/finance";
export * as projectModel from "./server/project-model";
export * as projectParams from "./server/project-params";
export * as profiles from "./server/profiles";
export * as projectService from "./server/project-service";
export * as provenanceStore from "./server/provenance-store";
export * as regionFacts from "./server/region-facts";
export * as regions from "./server/regions";
export * as sensitivity from "./server/sensitivity";
/** 服务端查库编排（与上方 client-safe 同名模块配对）。 */
export * as solutionSourceServer from "./server/solution-source-server";
export * as solutionStore from "./server/solution-store";
export * as storageValue from "./server/storage-value";
export * as projectStore from "./server/project-store";
export * as tech from "./server/tech";
export * as scoring from "./server/scoring";
export * as scout from "./server/scout";
export * as scoutGithub from "./server/scout-github";
export * as scoutIngest from "./server/scout-ingest";
export * as solutionAdmin from "./server/solution-admin";
export * as solutionBody from "./server/solution-body";
export * as solutionGeneration from "./server/solution-generation";

/* ───────────────────────── engine（V2 生产计算引擎：纯函数、零框架依赖、确定性） ───────────────────────── */

/**
 * V2 引擎是"唯一的生产计算路径"。与上方 `server/*` 的区别：
 *   - `server/*` 里的模型会读库、会编排、会依赖 Prisma；
 *   - `engine/*` 只吃 `ScenarioInput`、只吐 `CalculationResult`，不碰任何 IO。
 *
 * 分层顺序即依赖方向：`types` → `time`/`benchmark` → 各技术域 → `economics` → `decision`，
 * 最后由 `engine.runCalculation` 收口。UI 与 API 只允许调用 `engine.runCalculation`。
 */
export * as engineTypes from "./engine/types";
export * as engineTime from "./engine/time";
export * as engineBenchmark from "./engine/benchmark";
export * as engineTruckDemand from "./engine/truck-demand";
export * as engineCharging from "./engine/charging";
export * as enginePv from "./engine/pv";
export * as engineBess from "./engine/bess";
export * as engineBalance from "./engine/balance";
export * as engineGrid from "./engine/grid";
export * as engineEconomics from "./engine/economics";
export * as engineScenario from "./engine/scenario";
export * as engineDecision from "./engine/decision";
export * as engineReport from "./engine/report";
export * as engine from "./engine/engine";
