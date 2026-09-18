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
 * 内核有 40 个模块、导出面数百个符号，且 lib 与 server 下存在同名模块
 * （`sandbox-solution-source` 两侧各一个：一个是 client-safe 的纯映射，一个是服务端查库编排）。
 * 平铺 `export *` 会静默丢失重名符号（TS 不报错，运行时拿到 `undefined`）——
 * 这是最阴险的一类缺陷。命名空间导出把这种碰撞变成**编译期不可能**。
 *
 * ## 两种消费方式
 *
 * ```ts
 * // 方式一：从 barrel 取（推荐，公开 API 面稳定）
 * import { sandboxParams, parameterEngine } from "@app/kernel";
 *
 * // 方式二：深路径直取（细粒度、tree-shaking 友好；由 package.json exports 的 "./*" 支持）
 * import { SANDBOX_PARAMS_VERSION } from "@app/kernel/server/sandbox-params";
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
export * as sandboxProjectRestore from "./lib/sandbox-project-restore";
export * as sandboxReport from "./lib/sandbox-report";
export * as sandboxSolutionLineage from "./lib/sandbox-solution-lineage";
export * as sandboxSolutionProvenance from "./lib/sandbox-solution-provenance";
/** client-safe 的纯映射（可进浏览器 bundle）。服务端查库编排见下方 `sandboxSolutionSourceServer`。 */
export * as sandboxSolutionSource from "./lib/sandbox-solution-source";
export * as sandboxSolution from "./lib/sandbox-solution";
export * as sandboxView from "./lib/sandbox-view";

/* ───────────────────────────── server（服务端领域逻辑，直接 import prisma） ───────────────────────────── */

export * as caseScores from "./server/case-scores";
export * as deepseekProvider from "./server/deepseek-provider";
export * as modelRouter from "./server/model-router";
export * as parameterEngine from "./server/parameter-engine";
export * as researchPipeline from "./server/research-pipeline";
export * as sandboxDemo from "./server/sandbox-demo";
export * as sandboxExplain from "./server/sandbox-explain";
export * as sandboxFinance from "./server/sandbox-finance";
export * as sandboxModel from "./server/sandbox-model";
export * as sandboxParams from "./server/sandbox-params";
export * as sandboxProfiles from "./server/sandbox-profiles";
export * as sandboxProjects from "./server/sandbox-projects";
export * as sandboxProvenanceStore from "./server/sandbox-provenance-store";
export * as sandboxRegionFacts from "./server/sandbox-region-facts";
export * as sandboxRegions from "./server/sandbox-regions";
export * as sandboxSensitivity from "./server/sandbox-sensitivity";
/** 服务端查库编排（与上方 client-safe 同名模块配对）。 */
export * as sandboxSolutionSourceServer from "./server/sandbox-solution-source";
export * as sandboxSolutionStore from "./server/sandbox-solution-store";
export * as sandboxStorageValue from "./server/sandbox-storage-value";
export * as sandboxStore from "./server/sandbox-store";
export * as sandboxTech from "./server/sandbox-tech";
export * as scoring from "./server/scoring";
export * as scout from "./server/scout";
export * as scoutGithub from "./server/scout-github";
export * as scoutIngest from "./server/scout-ingest";
export * as solutionAdmin from "./server/solution-admin";
export * as solutionBody from "./server/solution-body";
export * as solutionGeneration from "./server/solution-generation";
