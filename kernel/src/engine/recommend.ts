/**
 * 自动推荐（M5 · 配置寻优）—— 本产品的**灵魂层**。
 *
 * ## 为什么这一层决定了本产品是不是"又一个计算器"
 *
 * 一个计算器的用法是：用户自己猜一套配置（12 台 240 kW？还是 8 台 480 kW？要不要上 4 MWh 储能？），
 * 填进去，得到一个 NPV。然后用户**再猜一套**，再填一次，再比一次。
 * 于是现场真实发生的是：**用户在替软件做搜索**——而人肉搜索既不可靠（组合成千上万）
 * 也不可复现（三个月后没人记得当时比过哪几套）。
 *
 * 本层把"搜索"从用户手里拿回来。用户只需要回答**他真正知道的事**：
 * 车队多大、日跑多远、充电窗口几点到几点、服务费谈多少、站里现有容量多大。
 * 剩下的「桩数 × 功率档 × 储能规模 × 光伏规模 × 变压器档 × 要不要增容」这套组合，
 * 由本层枚举、评估、排序，最后给出**一套明确的推荐 + 为什么是它 + 为什么不是别的**。
 *
 * 这就是「项目决策平台」与「参数计算器」的分界线：前者给结论，后者给数字。
 *
 * ## 目标函数与硬门槛（先说清楚"最优"是什么意思）
 *
 * 「最优」不是一个自明的词。本层的定义是可审计的：
 *
 * 1. **先过门槛，再比大小**。不可行（装不下车 / 能量不守恒 / 并网受限）的方案无论 NPV 多高都不参与竞争——
 *    否则会出现"推荐一个交不了车的方案，只因为它账面最赚钱"这种荒唐结论。
 * 2. **在同一门槛下比主目标**。默认主目标是**全投资口径 NPV**；也支持资本金 NPV 与静态回收期。
 * 3. **同分时按更少的钱排前**。NPV 相同则净投资更低者优先（少占用资金本身就是价值）。
 * 4. **最后按候选标识做字典序**。这一条只为**确定性**存在：同一输入在任何机器上必须得到
 *    逐字节相同的推荐结果，不能因为浮点相等时排序不稳而"今天推 A、明天推 B"。
 *
 * ## 搜索方法（以及它做不到什么——必须写在明处）
 *
 * 全组合数 = 桩数档 × 功率档 × 储能档 × 光伏档 × 并网档 × 有序充电档。以默认空间算是 **1,440** 组；
 * 单次完整计算（35,040 步 × 9 个模型）实测约 27 ms，全枚举约 39 秒——在服务端可接受，
 * 但没必要，因为其中绝大多数是**解析上就不可能**的（桩太少，怎么排都装不下当天需求）。
 *
 * 因此分四阶段：
 *
 * | 阶段 | 做什么 | 成本 |
 * |---|---|---|
 * | S1 解析剪枝 | 用「补能能力下界」剔除**数学上不可能交付**的桩配置 | 零次引擎调用 |
 * | S2 帕累托精选 | 同一"总装机功率"下只留代表解（最省钱 / 桩数最少 / 功率最高） | 零次引擎调用 |
 * | S3a 角点粗扫 | 把每个维度的**两端**全交叉评估，钉住"光伏拉满+储能拉满"这类极端组合 | ≤ 32 次引擎调用 |
 * | S3b 坐标下降 | 从基准方案起步，依次优化 桩 → 光伏 → 储能 → 并网 → 有序充电，重复至无改进 | 每轮约 20 次引擎调用 |
 * | S4 邻域精修 | 在最优点周围做小规模全交叉，捕捉维度间的交互效应 | ≤ 数十次引擎调用 |
 *
 * S3a 存在的理由很具体：坐标下降从"最小可行起点"向上走，**永远不会**评估
 * "光伏拉满 + 储能拉满"这种极端组合；而"你到底有没有试过最大规模那套"是评审第一句会问的话。
 * 角点粗扫把这个问题变成"评估过、数字在这里"。
 *
 * **S1 的剪枝是"必要条件"而不是"启发式"**：站点在充电窗口内能交付的电池侧电量上限是
 * `有效功率 × 窗口小时数`，而单日峰值需求由车队与线路决定、与本层搜索的桩数/功率**无关**
 * （日需求只依赖充电效率，不依赖桩数与功率）。所以
 * `有效功率 × 窗口小时数 < 单日峰值需求` 的组合**必然**交付不足，直接剔除不会漏掉最优解。
 *
 * **S3/S4 不保证全局最优**，这一点必须诚实：坐标下降会停在"每个方向单独动都变不差"的点上。
 * 但它有一个全枚举没有的好处——**过程本身是结论**：从纯电网起步、每一步换来了多少 NPV，
 * 会逐条记录在 `improvementTrace` 里。用户看到的不是"某套配置得分最高"，
 * 而是"先加桩、再加光伏、最后加储能，每一步值多少钱"——这正是决策者要的增量账。
 * 搜索空间、剪枝规则、评估次数全部留档（`stats` / `space` / `dimensionTrace`），可复现、可复核、可推翻。
 *
 * ## 纯度约束（与引擎同等）
 *
 * 本模块**不读时钟、不读随机、不读环境变量、不访问网络、不碰数据库**。
 * 特别地：**结果里不含耗时**——耗时会让同一输入的两次调用输出不同，破坏"可复现"这条硬约束。
 * 需要观测耗时的调用方自己在外面掐表。
 *
 * ## 复用唯一计算入口
 *
 * 每个候选都用 `runCalculation()`（引擎的唯一生产入口）评估，本层**不复用任何公式**。
 * 理由：如果本层自己写一个"快速估算"来排序，那么"推荐依据"和"报告数字"就会来自两条路径，
 * 迟早不一致——到那时用户看到的推荐配置与点进去算出来的结果对不上，两边都有理，谁也说不清。
 */

import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import { ENGINE_VERSION, MODEL_VERSION, runCalculation } from "@app/kernel/engine/engine";
import { bessStrategyFor } from "@app/kernel/engine/scenario";
import { computeTruckDemand } from "@app/kernel/engine/truck-demand";
import { round } from "@app/kernel/server/finance";
import type {
  Diagnostic,
  ScenarioComponent,
  ScenarioDefinition,
  ScenarioInput,
} from "@app/kernel/engine/types";

/** 推荐模型版本（改搜索空间语义 / 排序规则 / 门槛 = 必须升版）。 */
export const RECOMMEND_MODEL_VERSION = "1.0.0";

export function recommendCalcRef(): string {
  return `recommend@${RECOMMEND_MODEL_VERSION}`;
}

/* ═══════════════════════════ 搜索空间 ═══════════════════════════ */

/**
 * 被搜索的维度与档位。
 *
 * 档位选择的依据（不是随手挑的）：
 *   - 桩数：覆盖"少桩大功率"到"多桩小功率"两条常见技术路线；
 *   - 单桩功率：主流重卡直流桩的常见分档（240 是当前主流，320/480 是新一代大功率）；
 *   - 储能：以 2 小时时长（功率 = 容量 ÷ 2）表达，0 表示不上储能——**必须保留 0 档**，
 *     否则"不要储能"这个结论永远出不来，而现实中它是相当常见的正确答案；
 *   - 光伏：0 档同上；其余按常见分布式规模给档；
 *   - 并网：变压器常见容量档；是否超过站点现有容量由 `existingGridCapacityKw` 判定。
 */
export interface RecommendationSpace {
  /** 充电桩数量候选（台）。 */
  chargerCounts: readonly number[];
  /** 单桩额定功率候选（kW）。 */
  chargerPowersKw: readonly number[];
  /** 储能容量候选（kWh）；0 = 不上储能（功率取容量 ÷ 2）。 */
  bessEnergiesKwh: readonly number[];
  /** 光伏装机候选（kWp）；0 = 不上光伏。 */
  pvCapacitiesKwp: readonly number[];
  /** 并网 / 变压器容量候选（kW）。 */
  gridCapacitiesKw: readonly number[];
  /** 是否启用有序充电（把充电需求向光伏与谷段倾斜）。 */
  managedChargingOptions: readonly boolean[];
}

export const DEFAULT_RECOMMENDATION_SPACE: RecommendationSpace = {
  chargerCounts: [6, 8, 10, 12, 16],
  chargerPowersKw: [240, 320, 480],
  bessEnergiesKwh: [0, 1000, 2000, 4000],
  pvCapacitiesKwp: [0, 2000, 4000],
  gridCapacitiesKw: [2000, 2500, 3150, 4000],
  managedChargingOptions: [false, true],
};

/** 储能按 2 小时时长配置（功率 = 容量 ÷ 2）。 */
export const BESS_DURATION_HOURS = 2;

/** 默认评估预算（次引擎调用）。实测单次约 27 ms → 默认上限约 8 秒。 */
export const DEFAULT_MAX_EVALUATIONS = 300;

/* ═══════════════════════════ 目标与门槛 ═══════════════════════════ */

/** 主目标：在什么意义上"最优"。 */
export const RECOMMEND_OBJECTIVES = ["npv", "equityNpv", "payback"] as const;
export type RecommendationObjective = (typeof RECOMMEND_OBJECTIVES)[number];

export const OBJECTIVE_LABELS: Record<RecommendationObjective, string> = {
  npv: "全投资净现值（NPV）最大",
  equityNpv: "资本金净现值（自有资金口径）最大",
  payback: "静态回收期最短",
};

/**
 * 入围门槛。**先过门槛、再比大小**——门槛的意义是防止"技术上不可行但账面最赚钱"的方案胜出。
 */
export interface RecommendationConstraints {
  /** 必须通过决策层的可行性判定（含能量守恒、需求被满足、并网不越限、NPV>0、回收期不超运营期）。默认 true。 */
  requireFeasible: boolean;
  /** 必须无未满足需求。默认 true。 */
  requireNoUnserved: boolean;
  /** 主目标为 NPV 口径时，NPV 至少达到此值（元）。默认 0。 */
  minNpvYuan: number;
  /** 静态回收期上限（年）；null = 不额外设限（沿用决策层门槛）。默认 null。 */
  maxPaybackYears: number | null;
}

export const DEFAULT_CONSTRAINTS: RecommendationConstraints = {
  requireFeasible: true,
  requireNoUnserved: true,
  minNpvYuan: 0,
  maxPaybackYears: null,
};

/* ═══════════════════════════ 请求 ═══════════════════════════ */

/** 情景底座：除被搜索维度之外的一切（车队、站点、电价、经济假设、服务费…）。 */
export type RecommendationBase = ScenarioInput;

export interface RecommendationRequest {
  /**
   * 情景底座（唯一权威输入形状）。**除下列"被搜索的规模维度"外，一切字段原样保留**：
   * 充电桩数量/功率、光伏容量与开关、储能容量/功率与开关、并网容量、
   * 有序充电开关，以及并网投资的折算单价。
   *
   * 为什么底座是 `ScenarioInput` 而不是"种子"：如果让推荐器从种子**重建**输入，
   * 那些没被搜索的字段（分时时段表、SOC 上下限、效率、转供电价…）会在重建中
   * 经历一次"缺省值回填"，于是"推荐时评估的那套输入"与"用户实际保存的那套输入"
   * 可能不是同一个东西——而这种差异不会报错，只表现为数字对不上。直接以情景输入为底座，
   * 从结构上排除了重建损耗。
   */
  base: RecommendationBase;
  /**
   * 站点**现有**并网容量（kW）。超过它的候选才算「增容」，
   * 并网投资只按**增量部分**计（不增容 = 不花钱）。默认取 `base.grid.capacityKw`。
   */
  existingGridCapacityKw?: number;
  /** 搜索空间；未给的维度用默认空间。 */
  space?: Partial<RecommendationSpace>;
  objective?: RecommendationObjective;
  constraints?: Partial<RecommendationConstraints>;
  /** 评估预算（次引擎调用）。默认 300。触顶会在 `stats.truncated` 标记。 */
  maxEvaluations?: number;
  /** 是否做邻域精修（S4）。默认 true；关掉可换速度。 */
  refine?: boolean;
  /** 坐标下降最大轮数。默认 4。 */
  maxPasses?: number;
}

/* ═══════════════════════════ 候选 ═══════════════════════════ */

export interface RecommendationCandidate {
  /** 稳定标识（含全部维度取值，便于复现与引用）。 */
  key: string;
  chargerCount: number;
  chargerPowerKw: number;
  /** 有效并发功率（kW = 桩数 × 单桩功率 × 同时率）。 */
  effectivePowerKw: number;
  pvCapacityKwp: number;
  bessEnergyKwh: number;
  bessPowerKw: number;
  gridCapacityKw: number;
  /** 是否超过站点现有并网容量（= 需要增容）。 */
  needsGridUpgrade: boolean;
  managedCharging: boolean;
  /** 人类可读的配置描述（报告直接引用）。 */
  label: string;
}

export interface CandidateEvaluation {
  candidate: RecommendationCandidate;
  /** 是否真的跑了引擎（false = 被解析剪枝，此时无指标）。 */
  evaluated: boolean;
  ok: boolean;
  /** 未评估时的剪枝理由 / 评估失败时的失败原因。 */
  failureReason?: string;
  /* ── 引擎产出（ok = true 时存在） ── */
  npvYuan?: number;
  equityNpvYuan?: number;
  simplePaybackYears?: number | null;
  netCapexYuan?: number;
  feasible?: boolean;
  unservedEnergyKwh?: number;
  capacityConstrained?: boolean;
  maxImportKw?: number;
  chargerUtilizationPct?: number;
  pvSelfConsumptionPct?: number;
  decisionRecommended?: boolean;
  /** 是否满足全部门槛（先过门槛再比大小）。 */
  meetsObjective: boolean;
  /** 未达标的逐条原因。 */
  unmetReasons: string[];
  /** 排序分数（主目标值；越大越好；不可评估 = -Infinity）。 */
  score: number;
  /** 稳定排序用的 `inputHash`（便于与落库结果对账）。 */
  inputHash?: string;
}

export interface RecommendationTableRow {
  rank: number;
  key: string;
  config: string;
  npvWanYuan: number | null;
  paybackYears: number | null;
  netCapexWanYuan: number | null;
  feasible: boolean | null;
  meetsObjective: boolean | null;
  note: string;
}

/** 坐标下降过程中"这一步换来了什么"——比"最终得分最高"更有决策价值的那张表。 */
export interface ImprovementStep {
  order: number;
  dimension: string;
  dimensionLabel: string;
  from: string;
  to: string;
  /** 主目标在改动前后的取值（元，或"回收期"口径下为负的年数）。 */
  scoreBefore: number;
  scoreAfter: number;
  /** 主目标增量（元；正值 = 变好）。回收期口径下单位为"年（取负）"，见 `objective`。 */
  deltaScore: number;
  /** 该步的配置标识（改动后）。 */
  candidateKey: string;
}

/* ═══════════════════════════ 结果 ═══════════════════════════ */

export interface RecommendationStats {
  /** 全组合数（未剪枝）。 */
  spaceSize: number;
  /** 被"补能能力下界"解析判死、零成本剔除的桩配置数。 */
  prunedByAnalytic: number;
  /** 通过解析判死、但被帕累托去重合并掉的桩配置数。 */
  collapsedByPareto: number;
  /** 解析后的桩配置代表数（进入搜索的批次数）。 */
  chargerRepresentatives: number;
  /** 角点粗扫的评估次数（把每个维度的两端全交叉钉住）。 */
  anchorEvaluations: number;
  /** 实际引擎评估次数（含角点粗扫、坐标下降与邻域精修，按候选去重后）。 */
  evaluated: number;
  /** 评估预算。 */
  maxEvaluations: number;
  /** 是否因触顶而提前终止。 */
  truncated: boolean;
  /** 坐标下降轮数。 */
  passes: number;
  /** 是否在坐标下降中收敛（某轮无任何改进）。 */
  converged: boolean;
  /** 是否做了邻域精修。 */
  refined: boolean;
  /** 实际评估覆盖了全空间的百分比（0..100，仅供参考）。 */
  coveragePct: number;
}

export interface RecommendationResult {
  ok: true;
  recommendRef: string;
  engineVersion: string;
  modelVersion: string;
  recommendModelVersion: string;
  benchmarkVersion: string;
  objective: RecommendationObjective;
  objectiveLabel: string;
  constraints: RecommendationConstraints;
  space: RecommendationSpace;
  existingGridCapacityKw: number;
  /** 基准方案：最小可行桩 + 不上光伏 + 不上储能 + 沿用现有并网 + 无序充电（一切增值措施都与它比）。 */
  baseline: CandidateEvaluation;
  /** 唯一推荐。若全部候选未达门槛，这里给出的是"最优但未达标"的那一套，`best.meetsObjective = false`。 */
  best: CandidateEvaluation;
  /**
   * 推荐配置对应的**完整情景输入**，可直接提交保存为新情景。
   *
   * 由 `buildCandidateInput()`（= 评估时用的同一个函数）产出，因此
   * `runCalculation(recommendedInput).inputHash === best.inputHash` 恒成立——
   * 「推荐的数」与「保存后再算出来的数」不可能不一致。
   */
  recommendedInput: ScenarioInput;
  /** 次优（用于"为什么不是它"的对比）。 */
  runnerUp: CandidateEvaluation | null;
  /** 前若干名（含 best），按序排列。 */
  ranked: CandidateEvaluation[];
  /** 被剔除的代表性候选及原因（回答"为什么不推荐别的"）。 */
  rejected: Array<{ key: string; config: string; reason: string; npvWanYuan: number | null }>;
  /** 增量账：坐标下降每一步换来了多少主目标值。 */
  improvementTrace: ImprovementStep[];
  /** 搜索统计（可解释性：剪枝了多少、跑了多少次）。 */
  stats: RecommendationStats;
  /** 每个维度探索过的档位与最终取值（可审计）。 */
  dimensionTrace: Array<{ dimension: string; label: string; explored: string[]; chosen: string }>;
  /** 完整候选表（报告附录）。 */
  table: RecommendationTableRow[];
  /** 推荐理由（每条带数值）。 */
  reasons: string[];
  /** 注意事项（每条带数值）。 */
  concerns: string[];
  /** 一句话结论（报告头直接引用）。 */
  headline: string;
  /** 诚实边界（不得省略）。 */
  disclaimer: string;
  needsProfessionalReview: true;
}

export interface RecommendationFailure {
  ok: false;
  recommendRef: string;
  reason: "invalid_input" | "no_candidate_evaluated" | "calculation_error";
  detail: string;
  diagnostics: Diagnostic[];
}

export type RecommendationOutcome = RecommendationResult | RecommendationFailure;

/* ═══════════════════════════ 工具 ═══════════════════════════ */

function fmtNum(v: number, dp = 0): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtWan(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const wan = v / 10_000;
  return `${wan >= 0 ? "" : "-"}${fmtNum(Math.abs(wan), 1)} 万元`;
}

function fmtKwh(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 10_000) return `${fmtNum(v / 10_000, 1)} 万 kWh`;
  return `${fmtNum(v, 0)} kWh`;
}

/** 归一化搜索空间：去非法、去重、升序（保证组合枚举顺序确定）。 */
function normalizeSpace(space?: Partial<RecommendationSpace>): RecommendationSpace {
  const clean = (v: readonly number[] | undefined, fallback: readonly number[]): number[] => {
    const src = v && v.length ? v : fallback;
    const out = [...new Set(src.filter((x) => Number.isFinite(x) && x >= 0))].sort((a, b) => a - b);
    return out.length ? out : [...fallback];
  };
  const managed = space?.managedChargingOptions?.length
    ? [...new Set(space.managedChargingOptions)].sort((a, b) => (a === b ? 0 : a ? 1 : -1))
    : [...DEFAULT_RECOMMENDATION_SPACE.managedChargingOptions];
  return {
    chargerCounts: clean(space?.chargerCounts, DEFAULT_RECOMMENDATION_SPACE.chargerCounts),
    chargerPowersKw: clean(space?.chargerPowersKw, DEFAULT_RECOMMENDATION_SPACE.chargerPowersKw),
    bessEnergiesKwh: clean(space?.bessEnergiesKwh, DEFAULT_RECOMMENDATION_SPACE.bessEnergiesKwh),
    pvCapacitiesKwp: clean(space?.pvCapacitiesKwp, DEFAULT_RECOMMENDATION_SPACE.pvCapacitiesKwp),
    gridCapacitiesKw: clean(space?.gridCapacitiesKw, DEFAULT_RECOMMENDATION_SPACE.gridCapacitiesKw),
    managedChargingOptions: managed,
  };
}

function candidateLabel(c: Omit<RecommendationCandidate, "key" | "label">): string {
  const parts = [
    `${fmtNum(c.chargerCount)} 台 × ${fmtNum(c.chargerPowerKw)} kW 充电桩`,
    c.pvCapacityKwp > 0 ? `光伏 ${fmtNum(c.pvCapacityKwp)} kWp` : "不上光伏",
    c.bessEnergyKwh > 0 ? `储能 ${fmtNum(c.bessEnergyKwh)} kWh / ${fmtNum(c.bessPowerKw)} kW` : "不上储能",
    `并网 ${fmtNum(c.gridCapacityKw)} kW${c.needsGridUpgrade ? "（需增容）" : "（沿用现有容量）"}`,
  ];
  if (c.managedCharging) parts.push("有序充电");
  return parts.join(" + ");
}

function candidateKey(c: Omit<RecommendationCandidate, "key" | "label">): string {
  return [
    `c${c.chargerCount}x${c.chargerPowerKw}`,
    `pv${c.pvCapacityKwp}`,
    `bess${c.bessEnergyKwh}`,
    `g${c.gridCapacityKw}`,
    c.managedCharging ? "mg" : "raw",
  ].join("|");
}

/** 由候选推导场景定义（组件开关由规模档推导，不是按 id 分支）。 */
function definitionOf(c: RecommendationCandidate): ScenarioDefinition {
  const components: ScenarioComponent[] = ["GRID", "CHARGING", "TOU"];
  if (c.pvCapacityKwp > 0) components.push("PV");
  if (c.bessEnergyKwh > 0) components.push("BESS");
  const labelBits: string[] = [];
  if (c.pvCapacityKwp > 0) labelBits.push("光伏");
  if (c.bessEnergyKwh > 0) labelBits.push("储能");
  labelBits.push("充电");
  const label = `${labelBits.join("+")}${c.managedCharging ? "（有序）" : ""}`;
  return {
    id: `rec-${c.key.replace(/\|/g, "_")}`,
    label,
    components,
    managedCharging: c.managedCharging,
    intent: "由自动推荐在配置空间中搜索得到的候选方案。",
  };
}

/**
 * 由「底座 + 候选规模档」构造**完整情景输入**。
 *
 * 为什么必须是导出的、模块级的纯函数（而不是搜索内部的一段闭包）：
 *   推荐结果要能直接拿去保存成新情景。如果"保存时拼输入"的逻辑与"评估时拼输入"的逻辑
 *   是两份，它们迟早会分叉——而分叉的表现是"推荐时说 NPV 是 570 万，保存后算出来是 480 万"，
 *   两边都觉得自己对。把构造收成**唯一一个函数**、并让搜索结果带上它产出的
 *   `recommendedInput`，从结构上消灭了这种分叉。
 *
 * 覆写范围**仅限被搜索的规模维度**；其余一切字段（分时时段、效率、SOC 边界、转供电价、
 * 未知项清单…）原样保留，因此"评估的那套输入"就是"将来保存的那套输入"。
 *
 * 并网投资的**增量口径**：引擎按「总容量 × 单价」计并网投资，而现实中扩容只付**增量**的钱。
 * 这里通过折算单价表达增量口径（引擎保持不动）：
 *   gridYuan = 总容量 × (单价 × 增量 ÷ 总容量) = 单价 × 增量
 * 不增容（候选容量 ≤ 现有容量）→ 折算单价为 0 → 并网投资为 0。
 */
export function buildCandidateInput(
  base: ScenarioInput,
  candidate: RecommendationCandidate,
  opts: { existingGridCapacityKw: number },
): ScenarioInput {
  const existing = opts.existingGridCapacityKw;
  const delta = Math.max(0, candidate.gridCapacityKw - existing);
  const grossUnit = base.economics.gridCapexYuanPerKw;
  const effectiveUnit = candidate.gridCapacityKw > 0 ? (grossUnit * delta) / candidate.gridCapacityKw : 0;
  const pvOn = candidate.pvCapacityKwp > 0;
  const bessOn = candidate.bessEnergyKwh > 0;
  return {
    ...base,
    definition: definitionOf(candidate),
    site: { ...base.site },
    truck: { ...base.truck },
    charging: {
      ...base.charging,
      mode: "charging",
      swapSharePct: 0,
      swap: { ...base.charging.swap, enabled: false },
      charger: {
        ...base.charging.charger,
        chargerCount: candidate.chargerCount,
        chargerPowerKw: candidate.chargerPowerKw,
      },
    },
    pv: { ...base.pv, enabled: pvOn, capacityKwp: candidate.pvCapacityKwp },
    bess: {
      ...base.bess,
      enabled: bessOn,
      powerKw: candidate.bessPowerKw,
      energyKwh: candidate.bessEnergyKwh,
      // 与 `scenario.ts` 的组件映射共用同一条规则，避免两处各写一份而分裂
      strategy: bessStrategyFor(pvOn),
    },
    grid: {
      ...base.grid,
      capacityKw: candidate.gridCapacityKw,
      importLimitKw: candidate.gridCapacityKw,
      exportLimitKw: candidate.gridCapacityKw,
    },
    economics: { ...base.economics, gridCapexYuanPerKw: effectiveUnit },
    ...(base.unknowns ? { unknowns: { ...base.unknowns } } : {}),
  };
}

/* ═══════════════════════════ 主入口 ═══════════════════════════ */

export function recommendConfiguration(request: RecommendationRequest): RecommendationOutcome {
  const recommendRef = recommendCalcRef();
  const diagnostics: Diagnostic[] = [];
  const objective: RecommendationObjective = request.objective ?? "npv";
  const constraints: RecommendationConstraints = { ...DEFAULT_CONSTRAINTS, ...request.constraints };
  const space = normalizeSpace(request.space);
  const maxEvaluations = Math.max(1, Math.floor(request.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS));
  const maxPasses = Math.max(1, Math.floor(request.maxPasses ?? 4));
  const refine = request.refine ?? true;
  const base = request.base;

  /* ── 0. 底座校验：没有服务费就没有收入侧，推荐毫无意义（与引擎的诚实口径一致） ── */
  const baseFee = base.economics.chargingServiceFeeYuanPerKwh;
  if (!Number.isFinite(baseFee)) {
    return {
      ok: false,
      recommendRef,
      reason: "invalid_input",
      detail: "缺少充电服务费单价：山西服务费实行市场调节价，无官方水平值，必须由调用方显式提供。",
      diagnostics: [
        {
          kind: "SCENARIO_INPUT_MISSING",
          code: "missing_service_fee",
          message: "未提供充电服务费单价，无法评估任何候选方案的收入侧。",
          field: "economics.chargingServiceFeeYuanPerKwh",
          suggestion: "先与车队就服务费单价达成书面意向，再代入搜索。",
        },
      ],
    };
  }

  const spaceSize =
    space.chargerCounts.length *
    space.chargerPowersKw.length *
    space.bessEnergiesKwh.length *
    space.pvCapacitiesKwp.length *
    space.gridCapacitiesKw.length *
    space.managedChargingOptions.length;

  try {
    /* ── 1. 车队需求只算一次 ──
     * 日能量需求只依赖充电效率（不依赖桩数与单桩功率），因此单日峰值需求是
     * **所有桩配置共同的**能力下界。用引擎自己的函数算，不在这里复制公式。 */
    const demand = computeTruckDemand(base.truck, {
      mode: "charging",
      swap: base.charging.swap,
      swapSharePct: 0,
      charger: base.charging.charger,
    }).result;

    /** 单日峰值需求（电池侧，kWh）= 峰值充电负荷 × 窗口小时数。 */
    const peakDailyAtBatteryKwh = demand.peakChargingLoadKw * demand.chargingWindowHours;
    const windowHours = demand.chargingWindowHours;
    const simultaneity = base.charging.charger.simultaneousRatePct / 100;

    if (!(windowHours > 0)) {
      return {
        ok: false,
        recommendRef,
        reason: "invalid_input",
        detail: "充电窗口无效（终点必须晚于起点；跨零点请把终点写成大于 24 的小时数），无法评估任何桩配置的能力。",
        diagnostics: [
          {
            kind: "SCENARIO_INPUT_MISSING",
            code: "charging_window_invalid",
            message: "充电窗口无效，无法计算单日峰值需求。",
            field: "truck.chargingWindowEndHour",
            suggestion: "例如 21 → 30 表示 21:00 至次日 06:00。",
          },
        ],
      };
    }

    /* ── 2. S1 解析剪枝 + S2 帕累托精选 ── */

    const chargerPairs: Array<{ count: number; power: number; effectivePowerKw: number; capexProxy: number }> = [];
    for (const count of space.chargerCounts) {
      for (const power of space.chargerPowersKw) {
        const effectivePowerKw = count * power * simultaneity;
        chargerPairs.push({ count, power, effectivePowerKw, capexProxy: count * power });
      }
    }
    const chargerFeasible = chargerPairs.filter((p) => p.effectivePowerKw * windowHours >= peakDailyAtBatteryKwh);
    const prunedByAnalytic = chargerPairs.length - chargerFeasible.length;

    // 帕累托代表：按"总装机功率"分桶（桶宽 = 最小档装机功率），每桶保留
    // ① 最省钱（装机最小，等同性价比最高）② 桩数最少 ③ 单桩功率最高 —— 三种取向各一。
    const picks = new Map<string, { count: number; power: number; effectivePowerKw: number; capexProxy: number }>();
    const bucketWidth = Math.max(1, Math.min(...space.chargerCounts) * Math.min(...space.chargerPowersKw));
    const buckets = new Map<number, typeof chargerFeasible>();
    for (const p of chargerFeasible) {
      const b = Math.floor(p.capexProxy / bucketWidth);
      const arr = buckets.get(b) ?? [];
      arr.push(p);
      buckets.set(b, arr);
    }
    for (const arr of buckets.values()) {
      const byCapex = [...arr].sort((a, b) => a.capexProxy - b.capexProxy || b.count - a.count || b.power - a.power)[0];
      const byFewest = [...arr].sort((a, b) => a.count - b.count || b.power - a.power || a.capexProxy - b.capexProxy)[0];
      const byPower = [...arr].sort((a, b) => b.power - a.power || a.count - b.count || a.capexProxy - b.capexProxy)[0];
      for (const p of [byCapex, byFewest, byPower]) {
        picks.set(`${p.count}x${p.power}`, p);
      }
    }
    // 若解析剪枝把所有组合都判死（桩档整体偏小），降级为"最接近需求的那一个"，
    // 让引擎自己给出"交付不足"的数字，而不是让搜索空手而归。
    let chargerReps = [...picks.values()].sort(
      (a, b) => a.effectivePowerKw - b.effectivePowerKw || a.capexProxy - b.capexProxy || a.count - b.count,
    );
    let collapsedByPareto = chargerFeasible.length - picks.size;
    if (!chargerReps.length) {
      const fallback = [...chargerPairs].sort((a, b) => b.effectivePowerKw - a.effectivePowerKw)[0];
      chargerReps = [fallback];
      collapsedByPareto = Math.max(0, chargerFeasible.length - 1);
    }

    /* ── 3. 候选构造 ── */

    // 现有容量默认 = 底座当前的并网容量（即"不增容"的基准线）
    const existingGridCapacityKw = Math.max(0, request.existingGridCapacityKw ?? base.grid.capacityKw);

    const makeCandidate = (spec: {
      charger: { count: number; power: number };
      pvCapacityKwp: number;
      bessEnergyKwh: number;
      gridCapacityKw: number;
      managedCharging: boolean;
    }): RecommendationCandidate => {
      const effectivePowerKw = spec.charger.count * spec.charger.power * simultaneity;
      const bessPowerKw = spec.bessEnergyKwh > 0 ? spec.bessEnergyKwh / BESS_DURATION_HOURS : 0;
      const core = {
        chargerCount: spec.charger.count,
        chargerPowerKw: spec.charger.power,
        effectivePowerKw,
        pvCapacityKwp: spec.pvCapacityKwp,
        bessEnergyKwh: spec.bessEnergyKwh,
        bessPowerKw,
        gridCapacityKw: spec.gridCapacityKw,
        needsGridUpgrade: spec.gridCapacityKw > existingGridCapacityKw,
        managedCharging: spec.managedCharging,
      };
      return { ...core, key: candidateKey(core), label: candidateLabel(core) };
    };

    /**
     * 候选 → 完整情景输入：调用模块级唯一构造函数（见 `buildCandidateInput` 的说明）。
     */
    const buildInputFor = (c: RecommendationCandidate): ScenarioInput =>
      buildCandidateInput(base, c, { existingGridCapacityKw });

    /* ── 4. 评估（带记忆化与预算控制） ── */

    const cache = new Map<string, CandidateEvaluation>();
    let evaluatedCount = 0;
    let truncated = false;

    const evaluate = (c: RecommendationCandidate): CandidateEvaluation => {
      const hit = cache.get(c.key);
      if (hit) return hit;
      if (evaluatedCount >= maxEvaluations) {
        truncated = true;
        const skipped: CandidateEvaluation = {
          candidate: c,
          evaluated: false,
          ok: false,
          failureReason: "评估预算已用尽，未评估。",
          meetsObjective: false,
          unmetReasons: ["未评估（预算触顶）"],
          score: Number.NEGATIVE_INFINITY,
        };
        return skipped;
      }
      evaluatedCount++;
      const out = runCalculation(buildInputFor(c));
      if (!out.ok) {
        const failed: CandidateEvaluation = {
          candidate: c,
          evaluated: true,
          ok: false,
          failureReason: `${out.reason}：${out.detail}`,
          meetsObjective: false,
          unmetReasons: [`计算失败（${out.reason}）`],
          score: Number.NEGATIVE_INFINITY,
        };
        cache.set(c.key, failed);
        return failed;
      }

      const npv = out.economics.metrics.npvYuan;
      const equityNpv = out.economics.metrics.equity.npvYuan;
      const payback = out.economics.metrics.simplePaybackYears;
      const unserved = out.charging.unservedEnergyKwh;
      const feasible = out.decision.feasibility.feasible;

      const unmet: string[] = [];
      if (constraints.requireFeasible && !feasible) {
        unmet.push(`未通过可行性判定（${out.decision.feasibility.blockers[0] ?? "存在阻塞项"}）`);
      }
      if (constraints.requireNoUnserved && unserved > 0) {
        unmet.push(`未满足需求 ${fmtKwh(unserved)}`);
      }
      if ((objective === "npv" || objective === "equityNpv") && !(rawScoreFor(objective, npv, equityNpv, payback) >= constraints.minNpvYuan)) {
        unmet.push(`主目标 ${fmtWan(rawScoreFor(objective, npv, equityNpv, payback))} 低于门槛 ${fmtWan(constraints.minNpvYuan)}`);
      }
      if (constraints.maxPaybackYears !== null) {
        if (payback === null || payback === undefined || payback > constraints.maxPaybackYears) {
          unmet.push(`静态回收期 ${payback === null || payback === undefined ? "超出运营期" : `${fmtNum(payback, 1)} 年`} 超过上限 ${fmtNum(constraints.maxPaybackYears, 1)} 年`);
        }
      }

      const ev: CandidateEvaluation = {
        candidate: c,
        evaluated: true,
        ok: true,
        npvYuan: round(npv),
        equityNpvYuan: round(equityNpv),
        simplePaybackYears: payback,
        netCapexYuan: round(out.economics.capex.netYuan),
        feasible,
        unservedEnergyKwh: round(unserved),
        capacityConstrained: out.grid.capacityConstrained,
        maxImportKw: round(Math.max(0, ...out.grid.monthlyPeakImportKw)),
        chargerUtilizationPct: round(out.charging.utilizationPct),
        pvSelfConsumptionPct: round(out.pv.selfConsumptionPct),
        decisionRecommended: out.decision.recommendation.recommended,
        meetsObjective: unmet.length === 0,
        unmetReasons: unmet,
        score: rawScoreFor(objective, npv, equityNpv, payback),
        inputHash: out.inputHash,
      };
      cache.set(c.key, ev);
      return ev;
    };

    /* ── 5. 坐标下降（S3） ── */

    const chargerIdx0 = 0; // 最省的可行桩配置作为起点（从"纯电网 + 最小可行桩"出发一路增值）
    const state = {
      chargerIdx: chargerIdx0,
      pvIdx: 0,
      bessIdx: 0,
      gridIdx: 0,
      managedIdx: 0,
    };
    const candidateOf = (s: typeof state): RecommendationCandidate =>
      makeCandidate({
        charger: chargerReps[s.chargerIdx],
        pvCapacityKwp: space.pvCapacitiesKwp[s.pvIdx],
        bessEnergyKwh: space.bessEnergiesKwh[s.bessIdx],
        gridCapacityKw: space.gridCapacitiesKw[s.gridIdx],
        managedCharging: space.managedChargingOptions[s.managedIdx],
      });

    const improvementTrace: ImprovementStep[] = [];
    const dimOrder: Array<{
      field: keyof typeof state;
      dimension: string;
      label: string;
      size: number;
      describe: (idx: number) => string;
    }> = [
      {
        field: "chargerIdx",
        dimension: "charger",
        label: "充电桩配置",
        size: chargerReps.length,
        describe: (i) => `${chargerReps[i].count} 台 × ${chargerReps[i].power} kW`,
      },
      {
        field: "pvIdx",
        dimension: "pv",
        label: "光伏装机",
        size: space.pvCapacitiesKwp.length,
        describe: (i) => (space.pvCapacitiesKwp[i] > 0 ? `${space.pvCapacitiesKwp[i]} kWp` : "不上光伏"),
      },
      {
        field: "bessIdx",
        dimension: "bess",
        label: "储能规模",
        size: space.bessEnergiesKwh.length,
        describe: (i) => (space.bessEnergiesKwh[i] > 0 ? `${space.bessEnergiesKwh[i]} kWh` : "不上储能"),
      },
      {
        field: "gridIdx",
        dimension: "grid",
        label: "并网容量",
        size: space.gridCapacitiesKw.length,
        describe: (i) => `${space.gridCapacitiesKw[i]} kW${space.gridCapacitiesKw[i] > existingGridCapacityKw ? "（增容）" : ""}`,
      },
      {
        field: "managedIdx",
        dimension: "managedCharging",
        label: "有序充电",
        size: space.managedChargingOptions.length,
        describe: (i) => (space.managedChargingOptions[i] ? "启用" : "不启用"),
      },
    ];

    let current = evaluate(candidateOf(state));
    let best = current;
    let bestState = { ...state };
    let passes = 0;
    let converged = false;
    let anchorEvaluations = 0;

    /* ── 5a. 角点粗扫（S3a） ──
     * 坐标下降只从"最小可行起点"向上走，因此**永远不会**评估"光伏拉满 + 储能拉满"这类极端组合——
     * 而"你验证过最大规模那套吗"恰恰是最该被回答的质疑。这里先对每个维度的**两端**（最小/最大档）
     * 做一次全交叉粗扫，既补上极端组合，又给坐标下降一个更好的起点。
     * 不取中间档：中间档在坐标下降与邻域精修里都会被覆盖，粗扫的职责只是"把空间的角点钉住"。 */
    const cornerIndices = (size: number): number[] => (size <= 2 ? Array.from({ length: size }, (_, i) => i) : [0, size - 1]);
    const cCorners = cornerIndices(chargerReps.length);
    const pCorners = cornerIndices(space.pvCapacitiesKwp.length);
    const bCorners = cornerIndices(space.bessEnergiesKwh.length);
    const gCorners = cornerIndices(space.gridCapacitiesKw.length);
    const mCorners = cornerIndices(space.managedChargingOptions.length);
    corners: for (const ci of cCorners) {
      for (const pi of pCorners) {
        for (const bi of bCorners) {
          for (const gi of gCorners) {
            for (const mi of mCorners) {
              if (truncated) break corners;
              const st = { chargerIdx: ci, pvIdx: pi, bessIdx: bi, gridIdx: gi, managedIdx: mi };
              const ev = evaluate(candidateOf(st));
              anchorEvaluations++;
              if (betterThan(ev, best)) {
                best = ev;
                bestState = { ...st };
              }
            }
          }
        }
      }
    }
    // 坐标下降**从基准方案起步**（而不是从角点最优起步）：这样 `improvementTrace`
    // 记录的才是"从纯电网一路加上增值措施，每一步值多少钱"的增量账——
    // 这是决策者真正要看的东西，比"起点在哪儿"重要得多。
    const baselineGridIdx = (() => {
      let idx = 0;
      for (let i = 0; i < space.gridCapacitiesKw.length; i++) {
        if (space.gridCapacitiesKw[i] <= existingGridCapacityKw) idx = i;
      }
      return idx;
    })();
    state.chargerIdx = 0;
    state.pvIdx = 0;
    state.bessIdx = 0;
    state.gridIdx = baselineGridIdx;
    state.managedIdx = 0;
    current = evaluate(candidateOf(state));
    const baseline = current;
    if (betterThan(baseline, best)) {
      best = baseline;
      bestState = { ...state };
    }

    for (let pass = 1; pass <= maxPasses; pass++) {
      passes = pass;
      let improvedThisPass = false;
      for (const dim of dimOrder) {
        const before = current;
        const beforeIdx = state[dim.field];
        let bestIdx = beforeIdx;
        let bestLocal = current;
        for (let i = 0; i < dim.size; i++) {
          if (i === beforeIdx) continue;
          state[dim.field] = i;
          const ev = evaluate(candidateOf(state));
          if (betterThan(ev, bestLocal)) {
            bestLocal = ev;
            bestIdx = i;
          }
        }
        state[dim.field] = bestIdx;
        if (bestIdx !== beforeIdx && betterThan(bestLocal, before)) {
          current = bestLocal;
          improvedThisPass = true;
          if (betterThan(current, best)) {
            best = current;
            bestState = { ...state };
          }
          improvementTrace.push({
            order: improvementTrace.length + 1,
            dimension: dim.dimension,
            dimensionLabel: dim.label,
            from: dim.describe(beforeIdx),
            to: dim.describe(bestIdx),
            scoreBefore: before.score,
            scoreAfter: current.score,
            deltaScore: current.score - before.score,
            candidateKey: current.candidate.key,
          });
        }
      }
      if (!improvedThisPass) {
        converged = true;
        break;
      }
      if (truncated) break;
    }

    /* ── 6. 邻域精修（S4） ──
     * 坐标下降只沿坐标轴走，抓不到"两个维度同时动才划算"的交互（例如
     * 储能加一档 + 并网降一档同时换）。精修在最优点周围做两轮受控枚举：
     *   A. 只动桩配置（其余固定）——捕捉"补能能力"与"装机过剩"的权衡；
     *   B. 把桩固定在最优、对 光伏 × 储能 × 并网 × 有序充电 做小全交叉——捕捉增值组合的交互。
     * 只取"相邻档"而不是全部档，是为了把精修固定在几十次评估以内、不吞掉预算。 */
    let refined = false;
    if (refine && !truncated) {
      const around = (size: number, idx: number): number[] => {
        const set = new Set<number>([idx]);
        if (idx - 1 >= 0) set.add(idx - 1);
        if (idx + 1 < size) set.add(idx + 1);
        return [...set].sort((a, b) => a - b);
      };
      const pIdx = around(space.pvCapacitiesKwp.length, bestState.pvIdx);
      const bIdx = around(space.bessEnergiesKwh.length, bestState.bessIdx);
      const gIdx = around(space.gridCapacitiesKw.length, bestState.gridIdx);
      const mIdx = around(space.managedChargingOptions.length, bestState.managedIdx);

      const consider = (nextState: typeof state, tag: string, tagLabel: string) => {
        const ev = evaluate(candidateOf(nextState));
        if (!betterThan(ev, best)) return;
        const prev = best;
        best = ev;
        bestState = { ...nextState };
        refined = true;
        improvementTrace.push({
          order: improvementTrace.length + 1,
          dimension: tag,
          dimensionLabel: tagLabel,
          from: prev.candidate.label,
          to: ev.candidate.label,
          scoreBefore: prev.score,
          scoreAfter: ev.score,
          deltaScore: ev.score - prev.score,
          candidateKey: ev.candidate.key,
        });
      };

      // A. 桩配置邻域
      for (const ci of around(chargerReps.length, bestState.chargerIdx)) {
        if (truncated) break;
        consider({ ...bestState, chargerIdx: ci }, "refine-charger", "邻域精修（充电桩配置）");
      }
      // B. 增值组合的交互
      outer: for (const pi of pIdx) {
        for (const bi of bIdx) {
          for (const gi of gIdx) {
            for (const mi of mIdx) {
              if (truncated) break outer;
              consider({ ...bestState, pvIdx: pi, bessIdx: bi, gridIdx: gi, managedIdx: mi }, "refine-mix", "邻域精修（光伏/储能/并网/有序充电的交互）");
            }
          }
        }
      }
    }

    /* ── 7. 排序与结果组装 ── */

    const all = [...cache.values()].filter((e) => e.evaluated);
    if (!all.length) {
      return {
        ok: false,
        recommendRef,
        reason: "no_candidate_evaluated",
        detail: "没有任何候选方案被成功评估（可能搜索空间为空或全部计算失败）。",
        diagnostics,
      };
    }
    const ranked = [...all].sort((a, b) => {
      // 达标优先 → 可行优先 → 主目标降序 → 净投资升序 → 标识字典序（确定性）
      if (a.meetsObjective !== b.meetsObjective) return a.meetsObjective ? -1 : 1;
      const af = a.ok && a.feasible ? 1 : 0;
      const bf = b.ok && b.feasible ? 1 : 0;
      if (af !== bf) return bf - af;
      if (a.score !== b.score) return a.score > b.score ? -1 : 1;
      const ac = a.netCapexYuan ?? Number.POSITIVE_INFINITY;
      const bc = b.netCapexYuan ?? Number.POSITIVE_INFINITY;
      if (ac !== bc) return ac - bc;
      return a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0;
    });

    const bestEv = ranked[0];
    const runnerUp = ranked.find((e) => e.candidate.key !== bestEv.candidate.key) ?? null;

    /* 被剔除的代表性候选：按"与最优同族但不达标"优先，其次按分数高低取若干条 */
    const rejected = all
      .filter((e) => e.candidate.key !== bestEv.candidate.key)
      .sort((a, b) => {
        // 先列"看起来很强但不达标"的：分数高的排前
        if (a.score !== b.score) return a.score > b.score ? -1 : 1;
        return a.candidate.key < b.candidate.key ? -1 : 1;
      })
      .slice(0, 12)
      .map((e) => ({
        key: e.candidate.key,
        config: e.candidate.label,
        reason: e.meetsObjective
          ? `达标但主目标低于最优（${objective === "payback" ? `${fmtNum(-e.score, 1)} 年` : fmtWan(e.score)}）`
          : e.unmetReasons.join("；"),
        npvWanYuan: e.npvYuan === undefined ? null : round(e.npvYuan / 10_000, 1),
      }));

    const dimensionTrace = dimOrder.map((d) => ({
      dimension: d.dimension,
      label: d.label,
      explored: Array.from({ length: d.size }, (_, i) => d.describe(i)),
      chosen: d.describe(bestState[d.field]),
    }));

    const table: RecommendationTableRow[] = ranked.slice(0, 40).map((e, i) => ({
      rank: i + 1,
      key: e.candidate.key,
      config: e.candidate.label,
      npvWanYuan: e.npvYuan === undefined ? null : round(e.npvYuan / 10_000, 1),
      paybackYears: e.simplePaybackYears ?? null,
      netCapexWanYuan: e.netCapexYuan === undefined ? null : round(e.netCapexYuan / 10_000, 1),
      feasible: e.ok ? (e.feasible ?? null) : null,
      meetsObjective: e.ok ? e.meetsObjective : null,
      note: e.ok ? (e.meetsObjective ? "达标" : e.unmetReasons.join("；")) : (e.failureReason ?? ""),
    }));

    /* ── 8. 人话：推荐理由与注意事项（每条都带数值） ── */

    const reasons: string[] = [];
    const concerns: string[] = [];

    reasons.push(
      `在 ${fmtNum(spaceSize)} 组可能配置中，按「${OBJECTIVE_LABELS[objective]}」选出：${bestEv.candidate.label}。`,
    );
    if (bestEv.npvYuan !== undefined) {
      reasons.push(
        `该配置全投资净现值 ${fmtWan(bestEv.npvYuan)}，静态回收期 ${bestEv.simplePaybackYears === null || bestEv.simplePaybackYears === undefined ? "超出运营期" : `${fmtNum(bestEv.simplePaybackYears, 1)} 年`}，净投资 ${fmtWan(bestEv.netCapexYuan ?? NaN)}。`,
      );
      reasons.push(
        `补能能力：有效并发功率 ${fmtNum(bestEv.candidate.effectivePowerKw)} kW，在 ${fmtNum(windowHours, 1)} 小时窗口内可交付单日峰值需求 ${fmtKwh(peakDailyAtBatteryKwh)}${bestEv.unservedEnergyKwh && bestEv.unservedEnergyKwh > 0 ? `（仍有 ${fmtKwh(bestEv.unservedEnergyKwh)} 未交付）` : "，全年无未满足需求"}。`,
      );
      if (bestEv.candidate.pvCapacityKwp > 0) {
        reasons.push(
          `光伏 ${fmtNum(bestEv.candidate.pvCapacityKwp)} kWp 的自用率为 ${fmtNum(bestEv.pvSelfConsumptionPct ?? 0, 1)}%。`,
        );
      }
      reasons.push(
        `站级充电设施年利用率 ${fmtNum(bestEv.chargerUtilizationPct ?? 0, 1)}%${(bestEv.chargerUtilizationPct ?? 0) < 10 ? "（低于 10%，提示装机可能偏大）" : ""}；全年最大下网需量 ${fmtNum(bestEv.maxImportKw ?? 0)} kW，并网容量 ${fmtNum(bestEv.candidate.gridCapacityKw)} kW。`,
      );
      if (bestEv.candidate.needsGridUpgrade) {
        reasons.push(
          `该配置需要把并网容量从现有 ${fmtNum(existingGridCapacityKw)} kW 增容到 ${fmtNum(bestEv.candidate.gridCapacityKw)} kW（增量 ${fmtNum(bestEv.candidate.gridCapacityKw - existingGridCapacityKw)} kW），并网投资已按**增量**口径计入。`,
        );
      } else {
        reasons.push(`该配置沿用站点现有 ${fmtNum(existingGridCapacityKw)} kW 并网容量，不产生增容投资。`);
      }
    }

    if (runnerUp && runnerUp.npvYuan !== undefined && bestEv.npvYuan !== undefined) {
      const dNpv = bestEv.npvYuan - (runnerUp.npvYuan ?? 0);
      const dCapex = (runnerUp.netCapexYuan ?? 0) - (bestEv.netCapexYuan ?? 0);
      reasons.push(
        `与次优方案「${runnerUp.candidate.label}」相比，本方案主目标领先 ${objective === "payback" ? `${fmtNum((runnerUp.score - bestEv.score), 1)} 年` : fmtWan(dNpv)}，净投资${dCapex >= 0 ? `少 ${fmtWan(dCapex)}` : `多 ${fmtWan(-dCapex)}`}。`,
      );
    }
    if (baseline.npvYuan !== undefined && bestEv.npvYuan !== undefined && baseline.candidate.key !== bestEv.candidate.key) {
      const dScore = bestEv.score - baseline.score;
      reasons.push(
        dScore > 0
          ? `相对基准方案「${baseline.candidate.label}」，本方案在主目标上提升 ${objective === "payback" ? `${fmtNum(dScore, 1)} 年回收期` : fmtWan(dScore)}（基准为 ${objective === "payback" ? `${fmtNum(-baseline.score, 1)} 年` : fmtWan(baseline.score)}）。`
          : `基准方案「${baseline.candidate.label}」（${objective === "payback" ? `${fmtNum(-baseline.score, 1)} 年` : fmtWan(baseline.score)}）在主目标上反而优于全部含增值设备的候选。`,
      );
    }

    if (!bestEv.meetsObjective) {
      concerns.push(
        `**没有任何候选配置通过全部门槛**。当前最优候选仍未达标，原因：${bestEv.unmetReasons.join("；")}。此时不应据此推进投资决策，应优先核实服务费定价与需求侧假设。`,
      );
    }

    const rejectedUnserved = all.filter((e) => e.ok && (e.unservedEnergyKwh ?? 0) > 0).length;
    if (rejectedUnserved > 0) {
      concerns.push(
        `有 ${fmtNum(rejectedUnserved)} 个候选因补能能力不足而被排除（单日峰值需求 ${fmtKwh(peakDailyAtBatteryKwh)} 对应有效功率下界 ${fmtNum(peakDailyAtBatteryKwh / Math.max(1, windowHours))} kW；低于此下界的桩配置在数学上不可能交付满需求）。`,
      );
    }
    const constrained = all.filter((e) => e.ok && e.capacityConstrained).length;
    if (constrained > 0) {
      concerns.push(`有 ${fmtNum(constrained)} 个候选受并网容量限制（最大下网需量触顶），其年下网电量被削，结论偏保守。`);
    }
    if (truncated) {
      concerns.push(
        `评估在预算 ${fmtNum(maxEvaluations)} 次处触顶，搜索提前终止（实际评估 ${fmtNum(evaluatedCount)} 次，覆盖全空间约 ${fmtNum((evaluatedCount / Math.max(1, spaceSize)) * 100, 1)}%）。提高 maxEvaluations 可扩大搜索。`,
      );
    }
    concerns.push(
      `搜索方法为「解析剪枝 → 角点粗扫 → 坐标下降 → 邻域精修」，**不保证全局最优**。本次共评估 ${fmtNum(evaluatedCount)} 个候选（另有 ${fmtNum(prunedByAnalytic)} 个桩配置被解析判死、${fmtNum(collapsedByPareto)} 个被帕累托合并），全空间 ${fmtNum(spaceSize)} 组；搜索空间、剪枝规则、增量账与候选表均已留档，可复现、可推翻。`,
    );

    const improvementLead = improvementTrace
      .filter((s) => s.deltaScore > 0)
      .sort((a, b) => b.deltaScore - a.deltaScore)[0];
    if (improvementLead) {
      concerns.push(
        `增量账里贡献最大的一步是「${improvementLead.dimensionLabel}：${improvementLead.from} → ${improvementLead.to}」，换来 ${objective === "payback" ? `${fmtNum(improvementLead.deltaScore, 1)} 年回收期缩短` : fmtWan(improvementLead.deltaScore)}。`,
      );
    } else if (baseline.meetsObjective && bestEv.candidate.key === baseline.candidate.key) {
      concerns.push(
        `从基准方案（${baseline.candidate.label}）出发，逐维度单独调整**均无改进**——即在本情景假设下，"不上光伏、不上储能、不增容"本身就是最优解；各项增值措施的价值均为负（见候选表的次优方案）。`,
      );
    }

    const stats: RecommendationStats = {
      spaceSize,
      prunedByAnalytic,
      collapsedByPareto,
      chargerRepresentatives: chargerReps.length,
      anchorEvaluations,
      evaluated: evaluatedCount,
      maxEvaluations,
      truncated,
      passes,
      converged,
      refined,
      coveragePct: round((evaluatedCount / Math.max(1, spaceSize)) * 100, 2),
    };

    const headline = bestEv.meetsObjective
      ? `推荐：${bestEv.candidate.label}——全投资 NPV ${fmtWan(bestEv.npvYuan ?? NaN)}、静态回收期 ${bestEv.simplePaybackYears === null || bestEv.simplePaybackYears === undefined ? "超出运营期" : `${fmtNum(bestEv.simplePaybackYears, 1)} 年`}，为 ${fmtNum(all.length)} 个已评估候选中的最优。`
      : `未找到达标配置：当前最优为 ${bestEv.candidate.label}（NPV ${fmtWan(bestEv.npvYuan ?? NaN)}），但仍未通过门槛（${bestEv.unmetReasons[0] ?? "存在阻塞项"}）。`;

    const disclaimer =
      "本推荐由程序在给定搜索空间内按声明的主目标与门槛自动选出，采用「解析剪枝 → 角点粗扫 → 坐标下降 → 邻域精修」，不保证全局最优。" +
      "每个候选均由同一生产计算引擎（唯一入口）评估，未使用任何近似公式。" +
      "结论属模型估算，全部输入与搜索过程已留档、可复算；须经专业机构复核后方可用于投资决策。";

    return {
      ok: true,
      recommendRef,
      engineVersion: ENGINE_VERSION,
      modelVersion: MODEL_VERSION,
      recommendModelVersion: RECOMMEND_MODEL_VERSION,
      benchmarkVersion: BENCHMARK_VERSION,
      objective,
      objectiveLabel: OBJECTIVE_LABELS[objective],
      constraints,
      space,
      existingGridCapacityKw,
      baseline,
      best: bestEv,
      recommendedInput: buildInputFor(bestEv.candidate),
      runnerUp,
      ranked,
      rejected,
      improvementTrace,
      stats,
      dimensionTrace,
      table,
      reasons,
      concerns,
      headline,
      disclaimer,
      needsProfessionalReview: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      recommendRef,
      reason: "calculation_error",
      detail: `推荐过程中出现未预期错误：${message}`,
      diagnostics: [
        ...diagnostics,
        {
          kind: "CALCULATION_ERROR",
          code: "recommend_exception",
          message: `推荐搜索中断：${message}`,
          impact: "本次推荐结果不可用。",
          suggestion: "这是搜索层缺陷，请连同入参快照一起反馈。",
        },
      ],
    };
  }
}

/* ═══════════════════════════ 比较与打分 ═══════════════════════════ */

/** 主目标原始值（越大越好）。回收期口径取负号，使"越大越好"这条不变式统一成立。 */
function rawScoreFor(
  objective: RecommendationObjective,
  npvYuan: number,
  equityNpvYuan: number,
  payback: number | null | undefined,
): number {
  if (objective === "npv") return Number.isFinite(npvYuan) ? npvYuan : Number.NEGATIVE_INFINITY;
  if (objective === "equityNpv") return Number.isFinite(equityNpvYuan) ? equityNpvYuan : Number.NEGATIVE_INFINITY;
  if (payback === null || payback === undefined || !Number.isFinite(payback)) return Number.NEGATIVE_INFINITY;
  return -payback;
}

/** 严格优于：达标 → 可行 → 主目标值 → 净投资更低。语义与 `ranked` 的排序一致。 */
function betterThan(a: CandidateEvaluation, b: CandidateEvaluation): boolean {
  if (a.meetsObjective !== b.meetsObjective) return a.meetsObjective;
  const af = a.ok && a.feasible ? 1 : 0;
  const bf = b.ok && b.feasible ? 1 : 0;
  if (af !== bf) return af > bf;
  if (a.score !== b.score) return a.score > b.score;
  const ac = a.netCapexYuan ?? Number.POSITIVE_INFINITY;
  const bc = b.netCapexYuan ?? Number.POSITIVE_INFINITY;
  if (ac !== bc) return ac < bc;
  return a.candidate.key < b.candidate.key;
}
