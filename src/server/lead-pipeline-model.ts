/**
 * R7-D · 企业项目工作流「漏斗位置」纯函数模型（零依赖 · node 单测可跑）。
 *
 * ## 为什么放这里
 * 宪法取向：UI 可测逻辑须抽成零依赖纯函数走 node 单测，组件只当展示壳。本文件把
 * mandate §R7-D 的 7 段流水线（Lead→Project→Assessment/Decision→Solution→Review→
 * Published→Delivery）从**真实记录派生成一条可读的推进位置**，全用普通 JS，无 Prisma、无
 * 框架，输入是调用方（`lead-pipeline.ts` 服务端层）从库里聚合好的**最小事实**，输出是逐段
 * 「到没到 / 差什么」。刻意**不新增任何状态机、不写库**——它只是把既有一堆表（Lead/Project/
 * ProjectScenario/Solution/Order）里**已经存在**的记录，投影成运营一眼能看懂的推进视图。
 *
 * ## 诚实边界
 * 每段的 `reached` 只认**确证的记录**（例：ASSESSMENT 只认有 `calcStatus==="ok"` 且已存
 * `report` 的情景，不是"有项目就当作已评估"）；`nextActions` 是给人看的**下一步建议**，
 * 不代表系统会自动推进（真实报价 / 收款 / 交付仍是人工，属创始人域）。
 */

/** 流水线段键（有序，索引即深浅）。 */
export type PipelineStageKey =
  | "LEAD"
  | "PROJECT"
  | "ASSESSMENT"
  | "SOLUTION"
  | "REVIEW"
  | "PUBLISHED"
  | "DELIVERY";

/** Solution 状态字面（与 Prisma enum SolutionStatus 对齐；纯函数不 import Prisma，故本地声明）。 */
export type PipelineSolutionStatus = "DRAFT" | "UNDER_HUMAN_REVIEW" | "PUBLISHED";
/** Order 状态字面（与 Prisma enum OrderStatus 对齐）。 */
export type PipelineOrderStatus = "PENDING" | "PAID" | "REFUNDED" | "CANCELED";

/**
 * 由服务端层聚合出的**最小事实**——纯函数唯一输入。刻意只给"计数 + 状态多重集"，
 * 不塞原始行，保证纯函数无 DB/时间耦合、单测可用字面量精确复现判定。
 */
export interface PipelineEvidence {
  /** 该 Lead 记录本身存在（恒 true，除非调用方传脏数据）。 */
  hasLead: boolean;
  /** 与该客户关联的沙盘 / 决策项目数（Project.ownerId 命中）。 */
  projectCount: number;
  /** 上述项目下**已算通且存有决策报告**的情景数（calcStatus==="ok" && report!=null）。 */
  computedScenarioCount: number;
  /** 与该客户关联的方案数（Solution.creatorId 命中）。 */
  solutionCount: number;
  /** 关联方案的状态多重集（逐条，不折叠计数，便于如实展示"草稿 1 / 审核中 1 / 已发布 2"）。 */
  solutionStatuses: PipelineSolutionStatus[];
  /** 关联订单的状态多重集。 */
  orderStatuses: PipelineOrderStatus[];
}

/** 单段派生结果。 */
export interface PipelineStage {
  key: PipelineStageKey;
  /** 中文短标签（展示用）。 */
  label: string;
  /** 是否已确证到达。 */
  reached: boolean;
  /** 一句话如实描述当前依据（到达）或缺口（未到达）。 */
  detail: string;
}

/** 整体派生结果。 */
export interface LeadPipeline {
  /** 有序 7 段（浅→深）。 */
  stages: PipelineStage[];
  /** 最深到达段（无任何记录时回落到 LEAD）。 */
  furthest: PipelineStageKey;
  /** 下一步建议（对第一个未到达段给出人工动作提示；已到底则为空数组）。 */
  nextActions: string[];
}

/** 段序 + 中文标签（唯一真源，页面与派生共用）。 */
export const PIPELINE_STAGE_ORDER: ReadonlyArray<{ key: PipelineStageKey; label: string }> = [
  { key: "LEAD", label: "留资" },
  { key: "PROJECT", label: "立项" },
  { key: "ASSESSMENT", label: "评估 / 决策" },
  { key: "SOLUTION", label: "方案成卡" },
  { key: "REVIEW", label: "人工审核" },
  { key: "PUBLISHED", label: "上架可售" },
  { key: "DELIVERY", label: "成交交付" },
];

/** 计数安全阀：任何非有限 / 负数一律当 0（防脏数据把派生带偏）。 */
function safeCount(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function countStatus<T extends string>(list: T[], want: T): number {
  return list.reduce((acc, s) => (s === want ? acc + 1 : acc), 0);
}

/**
 * 纯派生：把 `PipelineEvidence` 折成逐段 reached + 最深段 + 下一步建议。
 * 不读外部世界、不抛错（脏输入靠 safeCount 兜底），便于穷举式单测。
 */
export function deriveLeadPipeline(ev: PipelineEvidence): LeadPipeline {
  const projects = safeCount(ev?.projectCount);
  const computed = safeCount(ev?.computedScenarioCount);
  const solutions = safeCount(ev?.solutionCount);
  const solStatuses = Array.isArray(ev?.solutionStatuses) ? ev.solutionStatuses : [];
  const ordStatuses = Array.isArray(ev?.orderStatuses) ? ev.orderStatuses : [];

  const inReview = countStatus(solStatuses, "UNDER_HUMAN_REVIEW");
  const published = countStatus(solStatuses, "PUBLISHED");
  const draft = countStatus(solStatuses, "DRAFT");
  const paid = countStatus(ordStatuses, "PAID");
  const pending = countStatus(ordStatuses, "PENDING");

  const reached: Record<PipelineStageKey, boolean> = {
    LEAD: Boolean(ev?.hasLead),
    PROJECT: projects > 0,
    ASSESSMENT: computed > 0,
    SOLUTION: solutions > 0,
    // REVIEW：只要有方案进入审核中或已发布，即确证「过（或在）人工审核这道门」
    REVIEW: inReview > 0 || published > 0,
    PUBLISHED: published > 0,
    DELIVERY: paid > 0,
  };

  const detail: Record<PipelineStageKey, string> = {
    LEAD: reached.LEAD ? "已收到企业留资" : "无留资记录",
    PROJECT: projects > 0 ? `关联项目 ${projects} 个` : "尚未为该客户立项",
    ASSESSMENT:
      computed > 0
        ? `已算通并存报告的情景 ${computed} 个`
        : projects > 0
          ? "有项目但尚无算通出报告的情景"
          : "无评估 / 决策记录",
    SOLUTION:
      solutions > 0
        ? `关联方案 ${solutions} 个（草稿 ${draft} / 审核中 ${inReview} / 已发布 ${published}）`
        : "尚无方案卡片",
    REVIEW:
      inReview > 0
        ? `审核中方案 ${inReview} 个，待持证 staff 复核`
        : published > 0
          ? `已过审并发布 ${published} 个`
          : "无待审 / 已过审方案",
    PUBLISHED: published > 0 ? `已上架可售方案 ${published} 个` : "尚无已发布方案",
    DELIVERY:
      paid > 0
        ? `已支付订单 ${paid} 单${pending > 0 ? `（另有待支付 ${pending} 单）` : ""}`
        : pending > 0
          ? `有待支付订单 ${pending} 单，尚未成交`
          : "无成交订单",
  };

  const stages: PipelineStage[] = PIPELINE_STAGE_ORDER.map((s) => ({
    key: s.key,
    label: s.label,
    reached: reached[s.key],
    detail: detail[s.key],
  }));

  let furthest: PipelineStageKey = "LEAD";
  for (const s of stages) if (s.reached) furthest = s.key;

  const nextActions = nextActionsFor(reached, { pending, draft, inReview, projects, computed });

  return { stages, furthest, nextActions };
}

/** 对**第一个未到达**的段给人工下一步建议；已到底 → 空数组。建议只描述"人该做什么"，绝不承诺系统自动推进。 */
function nextActionsFor(
  reached: Record<PipelineStageKey, boolean>,
  ctx: { pending: number; draft: number; inReview: number; projects: number; computed: number },
): string[] {
  if (!reached.PROJECT) return ["与该留资建立关联项目（或引导客户在工作台立项）"];
  if (!reached.ASSESSMENT) return ["在项目里配好情景并算通、生成决策报告"];
  if (!reached.SOLUTION) return ["把算通的决策报告导出为方案卡片（导出即落 DRAFT）"];
  if (!reached.REVIEW) return ["把方案提交人工审核（DRAFT → 审核中）"];
  if (!reached.PUBLISHED) {
    return ctx.inReview > 0
      ? ["复核通过后发布方案（审核中 → 已发布，须有定价）"]
      : ["完善方案并进入审核 / 发布"];
  }
  if (!reached.DELIVERY) {
    return ctx.pending > 0
      ? ["确认收款（后台标 PAID）即完成交付闭环"]
      : ["引导客户下单已发布方案"];
  }
  // 到底：已成交交付。
  return [];
}
