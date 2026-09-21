/**
 * R9 · V1 退役登记表（mandate §十二–§十三 · 纯派生 · 只登记状态、绝不删 V1）。
 *
 * ## 为什么这份文件"什么也不做"
 * mandate §十二 白纸黑字：**R9 不按代码时间点触发**，必须满足真实项目条件——至少一个真实项目
 *   走完 `真实项目 → 输入 → 计算 → 版本冻结 → 报告 → 商品 → 人工审核 → 发布 → 真实交付
 *   → Actual → Deviation` 全链，之后才能开始退役；且 §十三 明确"禁止一步删除"（分五档：标 deprecated
 *   → 移出主导航 → 加迁移说明 → 确认 V2 入口稳定 → 再删除旧面）。
 *   审计现状：R7-C V2 发布门已代码化 + R7-B DOCX 已交付 + R8 池仅**代码 complete 未迁移** +
 *   没有任何真实客户走完全链 + 无 Actual 回流 + 无 Deviation 复盘。§十二 前置**远未满足**。
 *   所以本批的正确交付形态是：**"什么都不删、什么都不改，只把 V1 面盘清楚 + 每一面卡在
 *   RETAIN 档 + 逐条列出解锁下一档的**真实业务条件**"**——把"能不能删"从**代码里的隐性判断**
 *   升级成**代码里显式登记的可审计事实**（宪法第 20 条诚实、第 13 条版本化、第 16 条单一真源）。
 *
 * ## 与"注释里的 TODO"的差别
 *   - 版本常量 `V1_RETIREMENT_REGISTRY_VERSION` 可升版可回滚（改一条 blocking 要写原因，规则 13）；
 *   - 单测钉死"零 READY_TO_DELETE / 零 DELETED / 全 RETAIN"——任何后来人想把某面推进一档，
 *     必先改这份表 + 破测试 → 逼他在 code review 里公开解释"真实项目链哪一段现在满足了"；
 *   - 每一面的 `conditions[]` 是**可勾选的**真实业务事件（不是"等 V2 稳定"这种含混话），
 *     解锁一档只能靠这些事件真发生，不能靠"看起来差不多了"。
 *
 * ## 边界
 *   - 本文件是纯数据 + 纯函数，**不 import prisma / engine / benchmark**——它只是登记表，
 *     不该碰任何一条链路的运行时。放宿主 `src/server/` 与 `lead-pipeline-model.ts` 同级（同"零依赖
 *     纯逻辑、UI 可测"的项目约定）。
 *   - 这份表**不接管鉴权 / 不接管路由挂载 / 不接管 V1 页面渲染**——那些仍走各自原路径，
 *     本文件只回答"这一面今天到底能不能退役"。
 */

export const V1_RETIREMENT_REGISTRY_VERSION = "1.1.0"; // 1.1.0（R9 持续守卫 · mandate §十三）：additive 新增可选 `diskPath`（把"登记不删"从注释升级为可执行断言——单测 fs 校验已登记 V1 面文件仍在盘）；**未改任何 status / 未翻任何 PRECONDITION_MET / 12 面仍全 RETAIN**。1.0.0（R9 首版）：登记 12 面、全 RETAIN；链上真实业务事件未发生。

/**
 * 退役进度五档（严格对齐 mandate §十三 执行方式，顺序不可跳）：
 *   RETAIN          保留原样（当前所有 V1 面所处档）
 *   DEPRECATE_MARK  标 deprecated（页面顶挂黄条 + meta robots 关索引）
 *   NAV_REMOVE      移出主导航（保留 URL 但导航/入口撤下）
 *   MIGRATION_NOTE  增迁移说明（引导到 V2 对应入口 + 差异点写清）
 *   READY_TO_DELETE 已可删除（V2 稳定 + 观察期结束）
 *   DELETED         已删除（本批次及 R9 内**绝不允许任何一面到达此档**）
 */
export type RetirementStatus =
  | "RETAIN"
  | "DEPRECATE_MARK"
  | "NAV_REMOVE"
  | "MIGRATION_NOTE"
  | "READY_TO_DELETE"
  | "DELETED";

/**
 * mandate §十二 前置链的 11 环（严格照 mandate 原文顺序）。任一环未闭合 → 全表一律 RETAIN。
 *   本审计以「已发生的真实业务事件」为唯一准；代码到位**不算**（R7-A/B/C/D/E + R8 均已代码到位）。
 */
export const RETIREMENT_PRECONDITION_CHAIN = [
  "REAL_PROJECT_SIGNED",         // 真实项目签约
  "REAL_INPUT_RECORDED",         // 真实输入入库
  "REAL_COMPUTATION_RUN",        // 真实计算完成
  "VERSION_FROZEN",              // 版本冻结（DecisionSnapshot 落库）
  "REPORT_ISSUED",               // 报告出具（客户可见）
  "PRODUCTIZED",                 // 商品化（Solution DRAFT 建出）
  "HUMAN_REVIEWED",              // 人工审核（UNDER_HUMAN_REVIEW → PUBLISHED）
  "PUBLISHED",                   // 上架可售
  "REAL_DELIVERY",               // 真实交付（客户已收 / 已用）
  "ACTUAL_CAPTURED",             // 实际值回流（Actual 记录）
  "DEVIATION_REVIEWED",          // 偏差复盘（Deviation vs 预测）
] as const;
export type RetirementPrecondition = (typeof RETIREMENT_PRECONDITION_CHAIN)[number];

/**
 * 每一条前置今天是否已真发生。**必须全部 false**，任何一条被人为翻 true 都须 §23 创始人拍板 +
 *   出具真实项目 ID / 客户合同号 / 交付凭证链接，才允许改。测试钉死"当前 all false"。
 */
export const PRECONDITION_MET: Record<RetirementPrecondition, boolean> = {
  REAL_PROJECT_SIGNED: false,
  REAL_INPUT_RECORDED: false,
  REAL_COMPUTATION_RUN: false,
  VERSION_FROZEN: false,
  REPORT_ISSUED: false,
  PRODUCTIZED: false,
  HUMAN_REVIEWED: false,
  PUBLISHED: false,
  REAL_DELIVERY: false,
  ACTUAL_CAPTURED: false,
  DEVIATION_REVIEWED: false,
};

/** 单面登记项。 */
export interface V1Surface {
  id: string;                   // slug
  path: string;                 // 主文件 / 主路由（相对仓库根·可能带 glob 或描述后缀）
  /**
   * 可选：把可能含 glob / 描述后缀的 `path` 落到**一个具体存在的文件**上，供 R9 持续守卫
   * （mandate §十三"登记不删"）做 fs 存在性断言——若将来有人误删已登记 V1 面，此路径消失即破测。
   * 仅对**文件锚定**的面填；纯 JSONB 字段指针（无单一文件）留空、由测跳过。
   */
  diskPath?: string;
  kind: "PAGE" | "API" | "STORE" | "LIB" | "COMPONENT" | "JSONB_POINTER";
  v2Replacement: string | null; // 对应 V2 落点（若已有），null = 无对应
  status: RetirementStatus;
  blockingReason: string;       // 为何今天**不能**推进到下一档
  conditions: string[];         // 逐条列出可勾选的真实业务事件
}

/**
 * V1 面清单（**手工枚举**，与代码路径一一对齐；不动态扫盘——扫盘易漂、且这份表本就要"人签字"）。
 * 12 面覆盖：主页面 3 + API 5 + 内核 store/lib 3 + Solution↔V1 情景 JSONB 指针 1。
 */
export const V1_SURFACES: readonly V1Surface[] = [
  {
    id: "workbench-root",
    path: "src/app/workbench/page.tsx",
    diskPath: "src/app/workbench/page.tsx",
    kind: "PAGE",
    v2Replacement: "src/app/workbench/projects/page.tsx（V2 决策项目列表已并存）",
    status: "RETAIN",
    blockingReason:
      "V2 决策项目链代码到位但**未跑通一条真实项目**（mandate §十二 全链未闭合），删主页面 = 断用户路。",
    conditions: [
      "至少 1 条真实客户项目走完 §十二 全链至 DEVIATION_REVIEWED",
      "V2 `/workbench/projects/[id]` 已稳定 ≥ 30 天（真实流量而非内测）",
      "运营在真实跟进中**首选 V2 入口**（可从 lead-pipeline furthest 分布验证）",
    ],
  },
  {
    id: "workbench-project-detail",
    path: "src/app/workbench/projects/[id]/page.tsx",
    diskPath: "src/app/workbench/projects/[id]/page.tsx",
    kind: "PAGE",
    v2Replacement: "同路由（页面同时挂 V1 沙盘块 + V2 决策块·R4 起共存·非替代）",
    status: "RETAIN",
    blockingReason:
      "V1 沙盘与 V2 决策共挂同一页；单删 V1 块会牵动页面结构，须先经 R9 §十三 DEPRECATE_MARK 档过渡。",
    conditions: [
      "V2 决策块在真实项目上稳定运行 ≥ 一个完整交付周期（含 Actual 回流）",
      "V1 沙盘块先在页面顶部挂 deprecated 黄条 ≥ 14 天，观察用户是否还在用它建单",
    ],
  },
  {
    id: "workbench-api-projects",
    path: "src/app/api/workbench/projects/**",
    diskPath: "src/app/api/workbench/projects/route.ts",
    kind: "API",
    v2Replacement: "src/app/api/workbench/decision/projects/**",
    status: "RETAIN",
    blockingReason:
      "V1 项目 CRUD 与 V2 决策项目**并存且数据形状不同**（V1 只 Project+ProjectScenario，V2 加 DecisionSnapshot + report）；V1 现网历史数据仍靠它读。",
    conditions: [
      "所有历史 Project/ProjectScenario 已 backfill 出对应 DecisionSnapshot（或明确归档为只读）",
      "线上真实调用日志显示该路径 7 日 0 新写入（除读取历史）",
    ],
  },
  {
    id: "workbench-api-scenarios",
    path: "src/app/api/workbench/scenarios/**",
    diskPath: "src/app/api/workbench/scenarios/[id]/route.ts",
    kind: "API",
    v2Replacement: "src/app/api/workbench/decision/scenarios/**",
    status: "RETAIN",
    blockingReason:
      "同上（§十二 全链未闭合）：V1 情景读写含 calcStatus/`report` 快照，与 V2 情景共用 `ProjectScenario` 表但走不同 store 层；删 V1 API = 断旧情景编辑入口，历史数据无法回放。",
    conditions: [
      "V1 store 写路径（project-store.updateScenarioLayers）与 V2 写路径（decision-store）完成字段级合并方案，经创始人裁决",
      "真实客户已建过的情景 100% 可在 V2 侧只读回放",
    ],
  },
  {
    id: "workbench-api-solution-draft",
    path: "src/app/api/workbench/solution/route.ts",
    diskPath: "src/app/api/workbench/solution/route.ts",
    kind: "API",
    v2Replacement: "src/app/api/workbench/decision/scenarios/[id]/export/route.ts（R7-A）",
    status: "RETAIN",
    blockingReason:
      "R7-A 已提供 V2 侧的 决策报告→DRAFT Solution 通道，但 V1 侧手工建方案仍在被 staff 用（真实数据未产生前，禁断旧口）。",
    conditions: [
      "运营 + 至少一位审核 staff 确认「未来新单只从 V2 出口」并留书面记录",
      "V1 buildSolutionDraft 建出的方案历史条数清零 30 天（无新增）",
    ],
  },
  {
    id: "workbench-api-solution-provenance",
    path: "src/app/api/workbench/solution/provenance/route.ts",
    diskPath: "src/app/api/workbench/solution/provenance/route.ts",
    kind: "API",
    v2Replacement:
      "无（该路由服务的是**SolutionFinancial.assumptions.sandboxSource** 溯源升级，V1 与 V2 都会写这套 extra；不属可退役面）",
    status: "RETAIN",
    blockingReason:
      "R8.5 provenance-store 是**跨 V1/V2 的通用溯源写路径**（把占位假设升级为 FACT），不属 V1 商业面、永久保留至溯源模型整体重构（§十二 退役链不适用此面）。",
    conditions: ["不适用（永久保留，直至 Solution 溯源模型整体重构）"],
  },
  {
    id: "workbench-api-source-solutions",
    path: "src/app/api/workbench/source/solutions/route.ts",
    diskPath: "src/app/api/workbench/source/solutions/route.ts",
    kind: "API",
    v2Replacement: "无（是 V1→V2 单向的 Solution 反查，用于 R8.4 溯源体检报告）",
    status: "RETAIN",
    blockingReason: "R8.4 溯源体检报告的**读侧数据源**，属跨链基础设施、非 V1 商业面。",
    conditions: ["不适用（永久保留，直至溯源模型整体重构）"],
  },
  {
    id: "kernel-project-store",
    path: "kernel/src/server/project-store.ts",
    diskPath: "kernel/src/server/project-store.ts",
    kind: "STORE",
    v2Replacement: "kernel/src/server/decision-store.ts（V2 决策快照）",
    status: "RETAIN",
    blockingReason:
      "V1 store 仍承载现网所有历史 Project/ProjectScenario 的读写与 `runProjectModel` 引擎调用；删除 = 现网读旧数据即 500。",
    conditions: [
      "所有历史 Project/ProjectScenario 完成只读归档（DB 端加 archive 位 或 迁到冷表）",
      "V2 决策 store 完整覆盖同一批历史数据的读侧（backfill DecisionSnapshot）",
      "至少 30 天零 V1 store 新写入",
    ],
  },
  {
    id: "kernel-solution-draft-lib",
    path: "kernel/src/lib/solution-draft.ts",
    diskPath: "kernel/src/lib/solution-draft.ts",
    kind: "LIB",
    v2Replacement:
      "kernel/src/lib/decision-to-solution.ts（R7-A · V2 决策报告 → DRAFT Solution 的纯投影）",
    status: "RETAIN",
    blockingReason:
      "V1 buildSolutionDraft 仍被 `/api/workbench/solution` 与 staff 手工建方案流使用；未跑通真实项目前禁断。",
    conditions: [
      "V2 出口在真实客户项目上跑通 ≥ 3 单（覆盖不同行业/规模）",
      "运营确认「V1 手工建方案不再需要」（例如复杂非标场景 V2 也能承载）",
    ],
  },
  {
    id: "kernel-project-model",
    path: "kernel/src/server/project-model.ts",
    diskPath: "kernel/src/server/project-model.ts",
    kind: "STORE",
    v2Replacement:
      "kernel/src/engine/scenario.ts + kernel/src/server/decision-service.ts（V2 逐时引擎 + 决策服务）",
    status: "RETAIN",
    blockingReason:
      "V1 沙盘**日粒度模型**（project-model.runProjectModel）与 V2 **15 分钟逐时引擎**并存；S1 完成前二者口径不同，绝不可先删 V1 侧（否则历史数据无对应引擎可复算，破规则 7 可复算）。",
    conditions: [
      "S1 逐时储能统一模型完成并通过黄金基线（含 φ 系数退役 or 保留的裁决落地）",
      "现网所有 V1 历史 Project 都能用 V2 引擎复算出**逐位对齐**的结果（或有明确的「旧口径不复算，只读归档」策略）",
    ],
  },
  {
    id: "solution-v1-sandbox-source-pointer",
    path: "SolutionFinancial.assumptions.sandboxSource (JSONB 字段)",
    kind: "JSONB_POINTER",
    v2Replacement:
      "body.extras.decisionReport.provenance.scenarioId（R7-A V2 侧溯源指针）",
    status: "RETAIN",
    blockingReason:
      "现网所有由 V1 沙盘建的历史 Solution 都靠 `sandboxSource` 反查回情景；删该指针 = 断历史链、破 R8.4 可复算审计（§十二 前置未闭合禁动）。",
    conditions: [
      "所有 V1 侧 Solution 已 backfill 一份 V2 形状 provenance（保留 V1 指针为历史戳，不改写）",
      "至少一位 staff 复核过 backfill 后数字与源报告逐位对齐",
    ],
  },
  {
    id: "publish-v1-direct-draft-to-published",
    path: "kernel/src/server/solution-admin.ts · `publishGuard` 允许 V1 手工方案 DRAFT→PUBLISHED 直跳",
    diskPath: "kernel/src/server/solution-admin.ts",
    kind: "LIB",
    v2Replacement:
      "R7-C 发布门 `humanReviewGateForV2`（V2 决策导出方案禁 DRAFT→PUBLISHED 直跳）",
    status: "RETAIN",
    blockingReason:
      "R7-C 门只**加**在 V2 body 形态上（`body.decisionReport` 存在），V1 手工方案的 DRAFT→PUBLISHED 直发通道**刻意保留**（mandate §四 硬约束「不破坏既有 V1 手工沙盘流程」）。真实客户签约前禁动。",
    conditions: [
      "V2 决策导出方案在真实客户上跑通 ≥ 5 单（覆盖不同行业）",
      "创始人 §23 明确签字允许 V1 手工方案也走 UNDER_HUMAN_REVIEW 门",
    ],
  },
];

/* ─────────────────────────── 派生查询（可测死） ─────────────────────────── */

/** 前置链是否**全 11 环真发生**（今天必须 false；改这个函数需附真实项目 ID 与凭证链接）。 */
export function areAllPreconditionsMet(): boolean {
  return RETIREMENT_PRECONDITION_CHAIN.every((k) => PRECONDITION_MET[k] === true);
}

/** 是否**允许**任何 V1 面进入 RETAIN 之外的档（今天必须 false，mandate §十二 硬约束）。 */
export function mayAdvanceBeyondRetain(): boolean {
  return areAllPreconditionsMet();
}

/** 当前所有处于给定档的面（便于 UI / 报表读表）。 */
export function surfacesAt(status: RetirementStatus): V1Surface[] {
  return V1_SURFACES.filter((s) => s.status === status);
}

/** 有没有任何一面已进入 READY_TO_DELETE 或 DELETED（今天必须 false，测试钉死）。 */
export function anyDeletionAuthorized(): boolean {
  return V1_SURFACES.some(
    (s) => s.status === "READY_TO_DELETE" || s.status === "DELETED",
  );
}

/** 全表是否处于「一律 RETAIN」（当前状态，测试钉死）。 */
export function allSurfacesRetain(): boolean {
  return V1_SURFACES.every((s) => s.status === "RETAIN");
}
