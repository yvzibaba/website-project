/**
 * S1 · 逐时储能统一模型 —— 骨架与口径对照器（mandate §十四–§十五 · 纯派生 · 零重算）
 *
 * ## 今天已经存在什么
 * V2 决策引擎（`kernel/src/engine/`）自 R1–R6 起已经把 **Truck Load + PV + BESS + Grid + TOU +
 *   Demand Charge** 全部放到**同一条 15 分钟时间轴**上（`time.ts` STEPS_PER_DAY / TIME_STEP_MINUTES=15），
 *   并且 `bess.ts` 模块头**逐字承诺**："arbitrage / peak-shaving / pv-shift 三种策略都在同一天内做
 *   计划，SOC 跨日连续" —— 也就是 mandate §十五 目标"**用逐时物理模型把削峰和套利放进同一份 SOC /
 *   功率预算**"在 **V2 侧已经成立**。
 *
 * ## 但 R3.5 遗留问题在哪
 * V1 沙盘（`kernel/src/server/project-model.ts` 走 E3/E4 扁平年口径 + `storage-value.ts` 年度代理
 *   σ 套利 + `project.demandKc` 需用系数）用的是 **Path A：`chargerPower × Kc × φ` 解析口径**估需量电费；
 *   V2 逐时引擎用 **Path B：15 分钟净下网峰值 `monthlyPeakImportKw[]`**。二者**并存且不可比**——
 *   一份 V1 沙盘结论与一份 V2 决策结论若同时给客户，会在"削峰能省多少"上给两个数字。
 *
 * ## 本文件做什么（S1 批次内 code-able 部分）
 *   ① `buildUnifiedSummary(bess, grid)` —— **纯投影**（不重算）V2 已算好的 `BessResult` + `GridResult`
 *      到一份"同一 SOC 预算下的统一视图"（套利腿 + 削峰腿 + 12 月逐月净下网峰值 + SOC 越界哨兵），
 *      让 UI / 报告层能拿**一个**视图讲清"S1 统一模型已在你手上、数字来自同一份调度"，避免被再次拆成两半。
 *   ② `computePathAAnalyticalPeakKw(a)` —— 复算 Path A 解析口径的**计费需量**（`Σ chargerPower × Kc × φ`
 *      与站点负荷峰的合成），供**对照**用；
   ③ `comparePathA_vs_PathB(a, b)` —— 把两条口径的"年需量电费"与"计费需量 kW"逐项对齐、给出**差值
 *      + 相对差 + 一句人话解释**，为将来的**统一口径迁移决策**（属 §23 创始人域）留一份可审计的
 *      事实表。**不是让 Path A 变 Path B、也不是让 Path B 变 Path A**——那属冻结口径变更。
 *
 * ## 本文件刻意不做什么（§23 STOP / 冻结件）
 *   - 不改 `MODEL_VERSION 1.5.0` / `PARAMS_VERSION 1.6.0` / `BESS_MODEL_VERSION 1.0.0` /
 *     `BALANCE_MODEL_VERSION 1.0.0` / `STORAGE_MODEL_VERSION 1.0.0` / `ENGINE_VERSION 2.0.0`；
 *   - 不删 `project.demandKc` / `φ` / Kc / 任何 Path A 输入参数或公式；
 *   - 不重录黄金基线（golden baseline）；
 *   - 不改 V1 沙盘 `project-model.ts` 一行；不改 V2 引擎 `bess.ts / grid.ts` 一行；
 *   - **不 import 任何计算函数**——只 `import type` 三个类型（`BessResult / GridResult / TimeSeries`），
 *     编译期擦除、运行时零依赖，结构上保证本文件**不可能**"顺手把引擎调一遍"，
 *     与 R7-B `decision-report-docx.ts` 的"不重算守卫"同一模式（本文件顶格 `import type` 是唯一允许的
 *     kernel 侧 import）。
 *
 * ## 与 mandate §十五 的关系
 *   §十五 目标是**把 Path A 收进 Path B 的同一份 SOC / 功率预算**——这在 V2 引擎已经实现（见"已存在什么"）。
 *   真正的收口动作 = **把 V1 沙盘默认口径切到 V2 物理模型** = 冻结口径变更 = **§23 创始人域**，
 *   须重录黄金基线 + 升 `MODEL_VERSION` + 客户既有情景回算影响面评估。**本批次只交付对照器 + 统一视图**，
 *   把"要不要收口 / 怎么收口 / 何时收口"三问的**证据基础**先落到代码里，让创始人在真实数字面前裁决。
 *   mandate §二十六："CODE COMPLETE / REAL-WORLD INPUT PENDING" —— 迁移决策即此 REAL-WORLD 阻塞项。
 */

import type { BessResult, GridResult, TimeSeries } from "@app/kernel/engine/types";

/** 本骨架模块自身版本（**独立于所有冻结口径**，只描述"这份对照器/投影的形状"，规则 13）。 */
export const HOURLY_BESS_UNIFIED_MODEL_VERSION = "1.0.0"; // 1.0.0（S1 骨架首版）：统一视图 + Path A vs B 对照器。零对计算真源的写入。

/* ───────────────────────────── 小工具（无副作用） ───────────────────────────── */

function finiteOr(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}
function round2(x: number): number {
  return Math.round(finiteOr(x) * 100) / 100;
}
/** 序列峰值（非有限项跳过；空序列 → 0）。 */
function peakOf(xs: TimeSeries | number[] | null | undefined): number {
  if (!Array.isArray(xs) || xs.length === 0) return 0;
  let m = 0;
  for (const v of xs) {
    if (typeof v === "number" && Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

/* ───────────────────────────── ① 统一视图（纯投影） ───────────────────────────── */

/**
 * 统一视图（S1 目标的一句话表达）：**同一份 15 分钟调度**产出的**套利腿 + 削峰腿 + SOC 演化 + 逐月净下网峰值**
 * 全部并列呈现，让消费方（UI / 报告 / 对照器）**没有余地**把二者拆回两条独立故事。
 */
export interface UnifiedHourlySummary {
  /** 来自 `BessResult.socProfilePct`（同一份调度）的 SOC 曲线引用。 */
  socProfilePct: TimeSeries;
  /** 来自 `BessResult.chargeProfileKw` / `dischargeProfileKw` 的功率曲线（同一份调度）。 */
  chargeProfileKw: TimeSeries;
  dischargeProfileKw: TimeSeries;
  /** 来自 `GridResult.importProfileKwh` 的逐时下网电量（同一份调度）。 */
  importProfileKwh: TimeSeries;
  /** 来自 `GridResult.monthlyPeakImportKw`（Path B 物理口径 · 12 元素长度）。 */
  monthlyPeakImportKw: number[];

  /** 套利腿年收益（元）——来自 `BessResult.arbitrageBenefitYuan`。 */
  arbitrageBenefitYuan: number;
  /** 削峰腿年收益（元）——来自 `BessResult.demandChargeSavingYuan`。 */
  demandChargeSavingYuan: number;
  /** 两条腿合计（**同一份 SOC 预算下**的年总收益，元）。 */
  totalBessBenefitYuan: number;

  /** 年放电 / 充电量、等效循环（透传自 `BessResult`，用于报告"这份预算下循环了多少次"）。 */
  annualDischargeKwh: number;
  annualChargeKwh: number;
  equivalentCycles: number;

  /** 不变量哨兵：`BessResult.socViolations`（必须为 0；>0 → `socBudgetIntegrity.ok=false`）。 */
  socViolations: number;
  /** 全年最高净下网功率（Path B 物理口径）：`max(monthlyPeakImportKw)`。 */
  annualNetPeakKw: number;
  /** 与削峰腿**同源**的 12 月峰值数组长度（应为 12；否则数据被截或畸形）。 */
  months: number;

  /** 统一预算完整性判定（防"把套利与削峰拆成两份预算"这一类回归）。 */
  socBudgetIntegrity: {
    ok: boolean;
    /** 明确声明：套利与削峰**来自同一份 SOC 演化**（本视图结构性保证；若上游破坏，`socViolations>0` 即报警）。 */
    sameSocBudget: true;
    note: string;
  };
}

/**
 * 纯投影 V2 已算好的 `BessResult` + `GridResult` → `UnifiedHourlySummary`。
 * **不重算、不调引擎、不读参数**——只是把两条已存在的结果束到同一个消费视图下，让"同一 SOC 预算"
 *   这件事在**类型层**就被强制。脏字段（NaN / 非数组）一律吃成保守零值，但**不改动输入**。
 */
export function buildUnifiedSummary(bess: BessResult, grid: GridResult): UnifiedHourlySummary {
  const monthly = Array.isArray(grid.monthlyPeakImportKw) ? grid.monthlyPeakImportKw : [];
  const socViolations = Math.max(0, Math.trunc(finiteOr(bess.socViolations, 0)));
  const annualNetPeakKw = peakOf(monthly);
  const arbitrage = finiteOr(bess.arbitrageBenefitYuan);
  const demandSaving = finiteOr(bess.demandChargeSavingYuan);
  const ok = socViolations === 0;
  return {
    socProfilePct: bess.socProfilePct ?? [],
    chargeProfileKw: bess.chargeProfileKw ?? [],
    dischargeProfileKw: bess.dischargeProfileKw ?? [],
    importProfileKwh: grid.importProfileKwh ?? [],
    monthlyPeakImportKw: monthly.map((v) => finiteOr(v)),
    arbitrageBenefitYuan: round2(arbitrage),
    demandChargeSavingYuan: round2(demandSaving),
    totalBessBenefitYuan: round2(arbitrage + demandSaving),
    annualDischargeKwh: round2(finiteOr(bess.annualDischargeKwh)),
    annualChargeKwh: round2(finiteOr(bess.annualChargeKwh)),
    equivalentCycles: round2(finiteOr(bess.equivalentCycles)),
    socViolations,
    annualNetPeakKw: round2(annualNetPeakKw),
    months: monthly.length,
    socBudgetIntegrity: {
      ok,
      sameSocBudget: true,
      note: ok
        ? "套利腿与削峰腿同源一份 15 分钟 SOC 演化，无越界、可作统一叙事。"
        : `SOC 越界 ${socViolations} 次 · 上游不变量已报警；本视图拒绝把二者合并讲为"同一份预算已闭合"。`,
    },
  };
}

/* ───────────────────────────── ② Path A 解析口径复算（仅供对照，不改 V1） ───────────────────────────── */

/**
 * Path A（V1 沙盘口径）解析估**计费需量 kW** 的输入（严格照 V1 项目模型 E4 的三项：
 *   充电桩总装机 × 需用系数 Kc ×  coincidence factor φ + 站点非充电负荷峰）。
 *   这里**不 import** V1 任何常量，只是把公式独立复述一遍以支持对照（复算 = 用同一公式再算一次、非"改口径"）。
 */
export interface PathADemandInput {
  /** 充电桩总装机功率 kW（= chargerCount × chargerPowerKw）。 */
  chargerInstalledKw: number;
  /** 需用系数 Kc（0–1，充电桩利用/降额系数）。 */
  kc: number;
  /** Coincidence factor φ（0–1，充电桩与站点负荷的**同时性系数**，V1 常显假设）。 */
  phi: number;
  /** 站点非充电负荷的最大值 kW（V1 里常取日均或年峰值 flat）。 */
  stationNonChargePeakKw: number;
  /** 需量电价 元/kW·月（V1 侧口径；Path A 与 Path B 都用同一个价才对"钱"可比）。 */
  demandChargeYuanPerKwMonth: number;
}

/** Path A 解析估算的中间量与最终量。 */
export interface PathADemandOutput {
  /** 充电桩侧对计费需量的贡献：`chargerInstalledKw × kc × phi`。 */
  chargingContributionKw: number;
  /** Path A 计费需量：`chargingContributionKw + stationNonChargePeakKw`。 */
  billedDemandKw: number;
  /** Path A 年需量电费：`billedDemandKw × demandChargeYuanPerKwMonth × 12`。 */
  annualDemandChargeYuan: number;
  /** 输入是否被规范化过（脏输入 → 保守零 + `inputSanitized=true`，不假装成功）。 */
  inputSanitized: boolean;
}

/**
 * Path A 口径的**纯数学复算**（**不**触碰 V1 store / model / params 任何东西，只在对照器里独立写一遍公式）。
 *   脏输入（非有限 / 负 / kc·phi 出 [0,1]）→ 相应项归零 + `inputSanitized=true` 明确标记。
 */
export function computePathAAnalyticalPeakKw(a: PathADemandInput): PathADemandOutput {
  let sanitized = false;
  const installed = finiteOr(a.chargerInstalledKw);
  if (a.chargerInstalledKw < 0 || !Number.isFinite(a.chargerInstalledKw)) sanitized = true;
  const kcRaw = finiteOr(a.kc);
  const kc = kcRaw < 0 || kcRaw > 1 ? (sanitized = true, 0) : kcRaw;
  const phiRaw = finiteOr(a.phi);
  const phi = phiRaw < 0 || phiRaw > 1 ? (sanitized = true, 0) : phiRaw;
  const nonCharge = Math.max(0, finiteOr(a.stationNonChargePeakKw));
  if (a.stationNonChargePeakKw < 0 || !Number.isFinite(a.stationNonChargePeakKw)) sanitized = true;
  const price = Math.max(0, finiteOr(a.demandChargeYuanPerKwMonth));
  if (a.demandChargeYuanPerKwMonth < 0 || !Number.isFinite(a.demandChargeYuanPerKwMonth)) sanitized = true;

  const chargingContributionKw = Math.max(0, installed) * kc * phi;
  const billedDemandKw = chargingContributionKw + nonCharge;
  const annualDemandChargeYuan = billedDemandKw * price * 12;
  return {
    chargingContributionKw: round2(chargingContributionKw),
    billedDemandKw: round2(billedDemandKw),
    annualDemandChargeYuan: round2(annualDemandChargeYuan),
    inputSanitized: sanitized,
  };
}

/* ───────────────────────────── ③ Path A vs Path B 对照器 ───────────────────────────── */

/** Path B 侧输入（从 V2 引擎结果里直接取，不重算）。 */
export interface PathBPhysicalInput {
  /** 逐月净下网峰值（Path B 物理口径）——`GridResult.monthlyPeakImportKw`。 */
  monthlyPeakImportKw: number[];
  /** 需量电价 元/kW·月（与 Path A 同价才可比）。 */
  demandChargeYuanPerKwMonth: number;
  /** V2 引擎已算好的年需量电费（可选 · 若给则优先用它，作为 Path B 年费口径来源）。 */
  annualDemandChargeYuanFromEngine?: number | null;
}

export interface PathDiscrepancy {
  pathA: PathADemandOutput;
  pathB: {
    /** 全年最高月净下网峰值 = max(monthlyPeakImportKw)。 */
    annualBilledDemandKw: number;
    /** Path B 年需量电费：优先用引擎给的，否则 `annualBilledDemandKw × price × 12`。 */
    annualDemandChargeYuan: number;
    inputSanitized: boolean;
  };
  /** `pathB.annualBilledDemandKw − pathA.billedDemandKw`（正 = 物理模型给出的计费需量更高）。 */
  diffKw: number;
  /** 相对 Path A 的百分比差（Path A=0 → null 而非 Infinity）。 */
  diffPctVsPathA: number | null;
  /** `pathB.annualDemandChargeYuan − pathA.annualDemandChargeYuan`（正 = Path B 更贵）。 */
  diffYuan: number;
  /** 一句话解读（**不裁决谁对谁错**，只把差值用人话讲清；决策留给创始人）。 */
  interpretation: string;
}

/**
 * 把两条口径**逐项并列**给出差值，供 §23 收口决策的证据基础；**不改任一侧、不做仲裁**。
 *   - diff > 0：Path B（物理）比 Path A（解析）估得**更贵**——常出现在充电集中且时段峰值显著的时刻；
 *   - diff < 0：Path A 偏保守估得更高——常出现在 φ 设得很小、但 V2 侧负荷其实相对平坦；
 *   - |diff| < ε：两口径基本一致，收口的边际影响小。
 */
export function comparePathA_vs_PathB(a: PathADemandInput, b: PathBPhysicalInput): PathDiscrepancy {
  const pathA = computePathAAnalyticalPeakKw(a);
  let bSanitized = false;
  const monthly = Array.isArray(b.monthlyPeakImportKw) ? b.monthlyPeakImportKw : [];
  if (!Array.isArray(b.monthlyPeakImportKw)) bSanitized = true;
  const annualBilled = peakOf(monthly);
  const price = Math.max(0, finiteOr(b.demandChargeYuanPerKwMonth));
  if (b.demandChargeYuanPerKwMonth < 0 || !Number.isFinite(b.demandChargeYuanPerKwMonth)) bSanitized = true;
  const fromEngine = b.annualDemandChargeYuanFromEngine;
  const pathBAnnualYuan =
    typeof fromEngine === "number" && Number.isFinite(fromEngine) && fromEngine >= 0
      ? fromEngine
      : annualBilled * price * 12;

  const diffKw = annualBilled - pathA.billedDemandKw;
  const diffPct =
    pathA.billedDemandKw > 0 ? diffKw / pathA.billedDemandKw : null;
  const diffYuan = pathBAnnualYuan - pathA.annualDemandChargeYuan;

  const interpret = () => {
    if (Math.abs(diffKw) < 1) {
      return "两条口径给出的计费需量差 < 1 kW，收口对数字几无影响；迁移成本低。";
    }
    if (diffKw > 0) {
      return `Path B 物理模型给出的计费需量比 Path A 解析口径高 ${round2(diffKw)} kW（${diffPct !== null ? round2(diffPct * 100) : "—"}%）——收口后需量电费会**变贵**，须先与客户对齐。`;
    }
    return `Path A 解析口径比 Path B 物理模型高 ${round2(-diffKw)} kW（${diffPct !== null ? round2(diffPct * 100) : "—"}%）——Path A 偏保守；收口对电费影响 = 让客户少花。`;
  };

  return {
    pathA,
    pathB: {
      annualBilledDemandKw: round2(annualBilled),
      annualDemandChargeYuan: round2(pathBAnnualYuan),
      inputSanitized: bSanitized,
    },
    diffKw: round2(diffKw),
    diffPctVsPathA: diffPct === null ? null : round2(diffPct * 10000) / 10000,
    diffYuan: round2(diffYuan),
    interpretation: interpret(),
  };
}

/* ───────────────────── 结构守卫：本文件不得调用任何计算函数（与 R7-B 反算依赖守卫同法） ───────────────────── */

/**
 * 备注（**守卫本体在** `tests/unit/hourly-bess-unified-model.test.ts`）：
 *   该测试直接读源文件，断言 ① 除 `import type` 外不得有任何指向 `@app/kernel/engine/`（types 除外）
 *   的运行时 import；② 不得出现 `runBess` / `runGrid` / `runCalculation` / `runProjectModel` /
 *   `storageValueDelta` / `computeDecisionSnapshot` 任一调用点。这些 token 的字面量**故意不在本文件里出现**——
 *   一次性把清单也留在测试文件，避免"自己写禁令、自己撞禁令"的滑稽；也保证源码本身除 `import type`
 *   外**没有任何指向 engine 运行时的字符串**。这是 S1 骨架"不越界改口径"的唯一硬约束。
 */
