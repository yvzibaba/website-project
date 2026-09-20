/**
 * V2 决策项目的**持久化层**（纯数据库访问：不含鉴权、不读会话、不做 HTTP 翻译）。
 *
 * 分层理由（与 V1 的 `project-store` 同一套约定，便于审阅者一次性理解）：
 *   - 本层只回答「怎么存、怎么读」，把「谁能建/改哪个项目」交给 `decision-service`，
 *     把「怎么算」交给内核引擎。三层各守一件事，任何一处都不会悄悄长出第二套规则。
 *   - 本层 server-only：直接 import prisma，绝不进任何 client bundle。
 *
 * 与 V1 的关系（**不冲突、不共享写入路径**）：
 *   V1 场景把参数分层（`paramLayers/paramSnapshot/calcResult`）存进 `ProjectScenario`；
 *   V2 情景把**一份自包含的 `ScenarioInput`** 存进同表的 `scenarioInput` 列，并用
 *   `engineVersion/benchmarkVersion/inputHash` 标定「这份结果是怎么算出来的」。
 *   两类项目共存于 `Project` 表，靠 `engineVersion` 是否为空区分。
 *   V2 的读写**一律不碰 V1 的列**，因此不会静默改写任何既有项目的历史结果。
 *
 * 复算真相：V2 落库的 `scenarioInput` 就是唯一真源——把它喂回 `runCalculation()`
 * 必然得到逐字节相同的 `decision/report`（后者仅因报告头的生成时刻不同而不同）。
 */
import { prisma } from "@app/kernel/lib/prisma";
import { Prisma } from "@prisma/client";
import { ENGINE_VERSION, MODEL_VERSION, runCalculation } from "@app/kernel/engine/engine";
import { buildDecisionReport, REPORT_BUILDER_VERSION } from "@app/kernel/engine/report";
import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import type { CalculationResult, ScenarioInput } from "@app/kernel/engine/types";
import type { Diagnostic } from "@app/kernel/engine/types";

/** 存储层版本（改写入口径 / 派生列含义须升版并记原因）。 */
export const DECISION_STORE_VERSION = "1.0.0";

/* ────────────────────────── 数值与 JSON 归一 ────────────────────────── */

/** 数值 → 定点小数字符串喂 Decimal 列；非有限（含 NaN）→ null，绝不写 Infinity/NaN。 */
function decimalStr(n: number | null | undefined, dp: number): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(dp);
}

/** JSON 快照归一：把 NaN/Infinity 折成 null（JSON 本无此值），保证落库结构确定可回读。 */
function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * 可空的 JSON 列写入值。
 * 注意：Prisma 对 `Json?` 列区分「不写」与「写 null」，要真正置空必须用 `Prisma.DbNull`。
 */
function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v == null ? (Prisma.DbNull as typeof Prisma.DbNull) : (v as Prisma.InputJsonValue);
}

/* ────────────────────────── 计算 → 列映射 ────────────────────────── */

/** 一次 V2 计算的完整产物（同时供落库与直接回给调用方，避免「页面一份、库里一份」的漂移）。 */
export interface DecisionSnapshot {
  calc: CalculationResult;
  report: ReturnType<typeof buildDecisionReport>;
}

/**
 * 把一份情景输入算成一个**可落库的完整快照**。
 *
 * 这是 V2 唯一允许产出结果的计算入口：本函数不做任何计算，只调用 `runCalculation()`
 * 并补上报告。任何调用方（API / 脚本 / 测试）都必须走这里，杜绝第二条计算路径。
 */
export function computeDecisionSnapshot(
  input: ScenarioInput,
  opts: { generatedAtIso?: string } = {},
): { ok: true; snapshot: DecisionSnapshot } | { ok: false; reason: string; detail: string; diagnostics: Diagnostic[] } {
  const outcome = runCalculation(input);
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      detail: outcome.detail,
      diagnostics: outcome.diagnostics,
    };
  }
  const generatedAtIso = opts.generatedAtIso ?? new Date().toISOString();
  const report = buildDecisionReport(outcome, { generatedAtIso });
  return { ok: true, snapshot: { calc: outcome, report } };
}

/** 引擎结果 → `ProjectScenario` 的 V2 列载荷（派生汇总列与 JSON 快照一并在内）。 */
export function decisionSnapshotToColumns(snapshot: DecisionSnapshot) {
  const { calc, report } = snapshot;
  const m = calc.economics.metrics;
  return {
    scenarioInput: jsonSafe(calc.inputSnapshot) as unknown as Prisma.InputJsonValue,
    engineVersion: calc.calcRef,
    benchmarkVersion: calc.benchmarkVersion,
    inputHash: calc.inputHash,
    decision: jsonSafe(calc.decision) as unknown as Prisma.InputJsonValue,
    report: jsonSafe(report) as unknown as Prisma.InputJsonValue,
    // 派生可查询汇总（Decimal 防浮点漂移）。未跑/失败一律 null，绝不填假值。
    capexNet: decimalStr(calc.economics.capex.netYuan, 2),
    npv: decimalStr(m.npvYuan, 2),
    irrPct: decimalStr(m.irr.ok ? (m.irr.valuePct ?? null) : null, 4),
    paybackYears: decimalStr(m.discountedPaybackYears, 2),
    roiRatio: decimalStr(m.roiRatio.ok ? (m.roiRatio.value ?? null) : null, 4),
    lcoeYuanPerKwh: decimalStr(m.lcoeYuanPerKwh, 4),
    npvEquity: decimalStr(m.equity.npvYuan, 2),
    irrEquityPct: decimalStr(m.equity.irr.ok ? (m.equity.irr.valuePct ?? null) : null, 4),
    calcStatus: "ok" as const,
    calcRef: calc.calcRef,
  };
}

/** 计算失败 → 只写状态与诊断，**不写任何数字列**（失败时留旧数字冒充是最危险的错误）。 */
function failureColumns(reason: string, detail: string) {
  const status =
    reason === "invalid_input" ? "invalid_input" : reason === "invariant_violation" ? "tech_error" : "error";
  return {
    // 失败时把输入原样留下（输入没算通不代表输入没价值，下一次重算还要用它）
    calcStatus: status,
    calcRef: null,
    engineVersion: null,
    benchmarkVersion: null,
    inputHash: null,
    // JSON 列的「置空」必须用 Prisma.DbNull，写 JS 的 null 会被 Prisma 当作"不修改"
    decision: jsonOrNull(null),
    report: jsonOrNull(null),
    capexNet: null,
    npv: null,
    irrPct: null,
    paybackYears: null,
    roiRatio: null,
    lcoeYuanPerKwh: null,
    npvEquity: null,
    irrEquityPct: null,
    calcError: detail.slice(0, 2000),
  };
}

/* ────────────────────────── 项目 / 情景 ────────────────────────── */

export type StoreResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: "invalid" | "not_found" | "engine_failed" | "error"; detail: string };

export interface CreateDecisionProjectInput {
  name: string;
  description?: string | null;
  regionId?: string | null;
  ownerId: string | null;
  /** 基线情景输入（必须已含服务费等必填项，见 scenario.ts）。 */
  scenarioInput: ScenarioInput;
  actor?: string | null;
  generatedAtIso?: string;
}

/**
 * 创建 V2 项目 + 其基线情景（一次事务）。
 *
 * 为什么在一个事务里：项目与基线情景是「一个概念的两半」——只建成项目而没有基线情景，
 * 会让工作台打开一个空壳；只建情景而没有项目，则外键悬空。二者必须同生共死。
 */
export async function createDecisionProject(
  input: CreateDecisionProjectInput,
): Promise<StoreResult<{ projectId: string; scenarioId: string; snapshot: DecisionSnapshot | null; failure: string | null }>> {
  const name = input.name?.trim();
  if (!name) return { ok: false, reason: "invalid", detail: "项目名称不能为空" };

  const computed = computeDecisionSnapshot(input.scenarioInput, { generatedAtIso: input.generatedAtIso });
  if (!computed.ok && computed.reason === "invalid_input") {
    // 输入不合法 → 连项目都不建：让用户先把输入改对，避免库里出现永远算不通的空项目
    return { ok: false, reason: "invalid", detail: computed.detail };
  }

  // regionId 外键护栏（对齐 V1 同款处理）：只有确实存在的 Region 行才落外键，否则诚实置空。
  let regionId: string | null = input.regionId ?? null;
  if (regionId) {
    const row = await prisma.region.findUnique({ where: { id: regionId }, select: { id: true } });
    if (!row) regionId = null;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          name,
          description: input.description ?? null,
          regionId,
          ownerId: input.ownerId,
        },
        select: { id: true },
      });

      const scenario = await tx.projectScenario.create({
        data: computed.ok
          ? {
              projectId: project.id,
              name: "基准情景",
              isBaseline: true,
              // V1 列给一个空对象占位即可（V2 不读它，但列本身非空约束需要满足）
              paramLayers: {},
              paramSnapshot: {},
              ...decisionSnapshotToColumns(computed.snapshot),
            }
          : {
              projectId: project.id,
              name: "基准情景",
              isBaseline: true,
              paramLayers: {},
              paramSnapshot: {},
              scenarioInput: jsonSafe(input.scenarioInput) as unknown as Prisma.InputJsonValue,
              ...failureColumns(computed.reason, computed.detail),
            },
        select: { id: true },
      });

      return {
        ok: true as const,
        projectId: project.id,
        scenarioId: scenario.id,
        snapshot: computed.ok ? computed.snapshot : null,
        failure: computed.ok ? null : computed.detail,
      };
    });
  } catch (e) {
    return { ok: false, reason: "error", detail: errorDetail(e) };
  }
}

/** 在一个 V2 项目下追加一个新情景（同一项目内多个情景用于横向比较）。 */
export async function addDecisionScenario(input: {
  projectId: string;
  name: string;
  scenarioInput: ScenarioInput;
  generatedAtIso?: string;
}): Promise<StoreResult<{ scenarioId: string; snapshot: DecisionSnapshot | null; failure: string | null }>> {
  const name = input.name?.trim();
  if (!name) return { ok: false, reason: "invalid", detail: "情景名称不能为空" };

  const computed = computeDecisionSnapshot(input.scenarioInput, { generatedAtIso: input.generatedAtIso });
  if (!computed.ok && computed.reason === "invalid_input") {
    return { ok: false, reason: "invalid", detail: computed.detail };
  }

  try {
    const scenario = await prisma.projectScenario.create({
      data: computed.ok
        ? {
            projectId: input.projectId,
            name,
            paramLayers: {},
            paramSnapshot: {},
            ...decisionSnapshotToColumns(computed.snapshot),
          }
        : {
            projectId: input.projectId,
            name,
            paramLayers: {},
            paramSnapshot: {},
            scenarioInput: jsonSafe(input.scenarioInput) as unknown as Prisma.InputJsonValue,
            ...failureColumns(computed.reason, computed.detail),
          },
      select: { id: true },
    });
    return {
      ok: true,
      scenarioId: scenario.id,
      snapshot: computed.ok ? computed.snapshot : null,
      failure: computed.ok ? null : computed.detail,
    };
  } catch (e) {
    if (isForeignKeyError(e)) return { ok: false, reason: "not_found", detail: "项目不存在" };
    return { ok: false, reason: "error", detail: errorDetail(e) };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 去掉对象里值为 `undefined` 的键。 */
function stripUndefined(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = val;
  return out;
}

/**
 * 把「增量补丁」合并到存档输入上。
 *
 * 为什么不能直接写 `{ ...base, ...patch }`：
 *   对象展开会把补丁里**显式出现的 `undefined`** 一并写进去，从而把一个本来有值的字段抹掉。
 *   前端在构造补丁时很容易留下 `{ note: undefined }` 这样的键（例如从表单里读一个空输入框），
 *   结果就是「只改了车队规模，却顺手清空了备注」——用户根本不会想到，也无从发现。
 *
 * 合并规则（刻意保持简单可预期）：
 *   - 值为 `undefined` 的键：**跳过**（视为"没提这件事"）；
 *   - 值为 `null` 的键：**照写**（那是"明确要置空"的意图）；
 *   - 两侧都是普通对象：合并一层（覆盖本契约全部结构；刻意不做深合并，
 *     免得数组被合并成四不像，也免得调试时无法解释某层到底怎么来的）；
 *   - 其余（含数组、标量）：整体替换。
 */
export function applyScenarioPatch(base: ScenarioInput, patch: Partial<ScenarioInput>): ScenarioInput {
  const baseRec = base as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...baseRec };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const prev = baseRec[k];
    merged[k] = isPlainObject(prev) && isPlainObject(v) ? { ...prev, ...stripUndefined(v) } : v;
  }
  return merged as unknown as ScenarioInput;
}

/**
 * 重算一个情景。
 *
 * `patch` 为「在当前存档输入之上的增量修改」——取存档输入而非调用方传来的整份输入，
 * 是为了保证「改一个参数」不会因为客户端漏传字段而静默重置其他参数。
 */
export async function recalculateDecisionScenario(input: {
  scenarioId: string;
  patch?: Partial<ScenarioInput>;
  generatedAtIso?: string;
}): Promise<StoreResult<{ snapshot: DecisionSnapshot | null; failure: string | null }>> {
  const existing = await prisma.projectScenario.findUnique({
    where: { id: input.scenarioId },
    select: { id: true, scenarioInput: true, engineVersion: true },
  });
  if (!existing) return { ok: false, reason: "not_found", detail: "情景不存在" };
  if (existing.scenarioInput == null) {
    return { ok: false, reason: "not_found", detail: "该情景不是 V2 情景（缺少 scenarioInput），无法用 V2 引擎重算" };
  }

  const base = existing.scenarioInput as unknown as ScenarioInput;
  const merged = input.patch ? applyScenarioPatch(base, input.patch) : base;

  const computed = computeDecisionSnapshot(merged, { generatedAtIso: input.generatedAtIso });
  try {
    await prisma.projectScenario.update({
      where: { id: input.scenarioId },
      data: computed.ok
        ? // 成功分支不再单独写 scenarioInput：`decisionSnapshotToColumns` 写入的就是
          // **本次实际参与计算的那份输入**（引擎回显的 inputSnapshot），
          // 比外面再传一份 merged 更不易出现「留档输入 ≠ 计算输入」的漂移。
          decisionSnapshotToColumns(computed.snapshot)
        : {
            // 输入保留（用户改坏的输入也要留住，下次好接着改），结果列全部清空
            ...failureColumns(computed.reason, computed.detail),
            scenarioInput: jsonSafe(merged) as unknown as Prisma.InputJsonValue,
          },
    });
  } catch (e) {
    return { ok: false, reason: "error", detail: errorDetail(e) };
  }
  return { ok: true, snapshot: computed.ok ? computed.snapshot : null, failure: computed.ok ? null : computed.detail };
}

/** 情景摘要（列表用，不外泄大 JSON）。 */
export interface DecisionScenarioSummary {
  id: string;
  name: string;
  isBaseline: boolean;
  calcStatus: string;
  calcRef: string | null;
  engineVersion: string | null;
  benchmarkVersion: string | null;
  inputHash: string | null;
  capexNetYuan: number | null;
  npvYuan: number | null;
  irrPct: number | null;
  paybackYears: number | null;
  lcoeYuanPerKwh: number | null;
  npvEquityYuan: number | null;
  irrEquityPct: number | null;
  scenarioIdLabel: string | null;
  updatedAt: string;
}

function dec(v: Prisma.Decimal | null): number | null {
  return v == null ? null : Number(v.toString());
}

/** 只读一个 V2 情景的完整快照（含输入、决策、报告）。 */
export async function readDecisionScenario(scenarioId: string) {
  const row = await prisma.projectScenario.findUnique({
    where: { id: scenarioId },
    select: {
      id: true,
      projectId: true,
      name: true,
      isBaseline: true,
      calcStatus: true,
      calcRef: true,
      engineVersion: true,
      benchmarkVersion: true,
      inputHash: true,
      scenarioInput: true,
      decision: true,
      report: true,
      updatedAt: true,
    },
  });
  if (!row) return null;
  return {
    ...row,
    updatedAt: row.updatedAt.toISOString(),
    scenarioInput: row.scenarioInput as unknown as ScenarioInput | null,
  };
}

/** 列出某项目下的全部 V2 情景（按基线优先、再按更新时间倒序）。 */
export async function listDecisionScenarios(projectId: string): Promise<DecisionScenarioSummary[]> {
  const rows = await prisma.projectScenario.findMany({
    where: { projectId, engineVersion: { not: null } },
    orderBy: [{ isBaseline: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      isBaseline: true,
      calcStatus: true,
      calcRef: true,
      engineVersion: true,
      benchmarkVersion: true,
      inputHash: true,
      capexNet: true,
      npv: true,
      irrPct: true,
      paybackYears: true,
      lcoeYuanPerKwh: true,
      npvEquity: true,
      irrEquityPct: true,
      scenarioInput: true,
      updatedAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isBaseline: r.isBaseline,
    calcStatus: r.calcStatus,
    calcRef: r.calcRef,
    engineVersion: r.engineVersion,
    benchmarkVersion: r.benchmarkVersion,
    inputHash: r.inputHash,
    capexNetYuan: dec(r.capexNet),
    npvYuan: dec(r.npv),
    irrPct: dec(r.irrPct),
    paybackYears: dec(r.paybackYears),
    lcoeYuanPerKwh: dec(r.lcoeYuanPerKwh),
    npvEquityYuan: dec(r.npvEquity),
    irrEquityPct: dec(r.irrEquityPct),
    scenarioIdLabel: ((r.scenarioInput as unknown as ScenarioInput | null)?.definition?.label ?? null),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** 删除一个非基线 V2 情景（基线情景不允许删，否则项目会失去唯一可复算的对照）。 */
export async function deleteDecisionScenario(
  scenarioId: string,
): Promise<StoreResult<{ deleted: true }>> {
  const row = await prisma.projectScenario.findUnique({
    where: { id: scenarioId },
    select: { isBaseline: true, engineVersion: true },
  });
  if (!row) return { ok: false, reason: "not_found", detail: "情景不存在" };
  if (row.isBaseline) return { ok: false, reason: "invalid", detail: "基准情景不可删除" };
  try {
    await prisma.projectScenario.delete({ where: { id: scenarioId } });
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, reason: "error", detail: errorDetail(e) };
  }
}

/** 列出某用户的 V2 项目（只含至少有一个 V2 情景的项目）。 */
export async function listDecisionProjects(ownerId: string, limit = 50) {
  const rows = await prisma.project.findMany({
    where: { ownerId, scenarios: { some: { engineVersion: { not: null } } } },
    orderBy: { updatedAt: "desc" },
    take: Math.max(1, Math.min(200, limit)),
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      scenarios: {
        where: { engineVersion: { not: null } },
        orderBy: [{ isBaseline: "desc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          name: true,
          isBaseline: true,
          calcStatus: true,
          npv: true,
          irrPct: true,
          paybackYears: true,
          lcoeYuanPerKwh: true,
          capexNet: true,
        },
      },
    },
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    scenarioCount: p.scenarios.length,
    baseline: p.scenarios[0]
      ? {
          id: p.scenarios[0].id,
          name: p.scenarios[0].name,
          calcStatus: p.scenarios[0].calcStatus,
          npvYuan: dec(p.scenarios[0].npv),
          irrPct: dec(p.scenarios[0].irrPct),
          paybackYears: dec(p.scenarios[0].paybackYears),
          lcoeYuanPerKwh: dec(p.scenarios[0].lcoeYuanPerKwh),
          capexNetYuan: dec(p.scenarios[0].capexNet),
        }
      : null,
  }));
}

/** 读一个 V2 项目（项目头 + V2 情景摘要），供工作台载入。 */
export async function readDecisionProject(projectId: string) {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      ownerId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!p) return null;
  const scenarios = await listDecisionScenarios(projectId);
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    scenarios,
  };
}

/* ────────────────────────── Actuals（实测回填） ────────────────────────── */

export interface UpsertActualInput {
  projectId: string;
  scenarioId?: string | null;
  periodYear: number;
  /** 0 = 年度汇总；1..12 = 自然月。 */
  periodMonth?: number;
  gridImportKwh?: number | null;
  pvGenerationKwh?: number | null;
  bessDischargeKwh?: number | null;
  deliveredKwh?: number | null;
  exportKwh?: number | null;
  gridCostYuan?: number | null;
  revenueYuan?: number | null;
  opexYuan?: number | null;
  availabilityPct?: number | null;
  source?: string;
  note?: string | null;
  recordedBy?: string | null;
}

/**
 * 写入/更新一条实测记录（幂等：同项目同期间重复提交即更新，不产生重复行）。
 *
 * 全部实测列走 `decimalStr`：`null` 与 `undefined` 都落成 `null`（= 没测），
 * 绝不落成 0——0 在实测语义里是「确实为零」，两者混淆会让偏差分析得出反向结论。
 */
export async function upsertProjectActual(input: UpsertActualInput): Promise<StoreResult<{ actualId: string }>> {
  const month = input.periodMonth ?? 0;
  if (!Number.isInteger(input.periodYear) || input.periodYear < 2000 || input.periodYear > 2200) {
    return { ok: false, reason: "invalid", detail: "年份不合法" };
  }
  if (!Number.isInteger(month) || month < 0 || month > 12) {
    return { ok: false, reason: "invalid", detail: "月份须为 0（年度）或 1..12" };
  }

  const data = {
    scenarioId: input.scenarioId ?? null,
    gridImportKwh: decimalStr(input.gridImportKwh ?? null, 3),
    pvGenerationKwh: decimalStr(input.pvGenerationKwh ?? null, 3),
    bessDischargeKwh: decimalStr(input.bessDischargeKwh ?? null, 3),
    deliveredKwh: decimalStr(input.deliveredKwh ?? null, 3),
    exportKwh: decimalStr(input.exportKwh ?? null, 3),
    gridCostYuan: decimalStr(input.gridCostYuan ?? null, 2),
    revenueYuan: decimalStr(input.revenueYuan ?? null, 2),
    opexYuan: decimalStr(input.opexYuan ?? null, 2),
    availabilityPct: decimalStr(input.availabilityPct ?? null, 2),
    source: input.source ?? "manual",
    note: input.note ?? null,
    recordedBy: input.recordedBy ?? null,
  };

  try {
    const row = await prisma.projectActual.upsert({
      where: {
        projectId_periodYear_periodMonth: {
          projectId: input.projectId,
          periodYear: input.periodYear,
          periodMonth: month,
        },
      },
      create: { projectId: input.projectId, periodYear: input.periodYear, periodMonth: month, ...data },
      update: data,
      select: { id: true },
    });
    return { ok: true, actualId: row.id };
  } catch (e) {
    if (isForeignKeyError(e)) return { ok: false, reason: "not_found", detail: "项目或情景不存在" };
    return { ok: false, reason: "error", detail: errorDetail(e) };
  }
}

/** 列出某项目的实测记录（按期间倒序）。 */
export async function listProjectActuals(projectId: string) {
  const rows = await prisma.projectActual.findMany({
    where: { projectId },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    take: 240,
  });
  return rows.map((r) => ({
    id: r.id,
    scenarioId: r.scenarioId,
    periodYear: r.periodYear,
    periodMonth: r.periodMonth,
    gridImportKwh: dec(r.gridImportKwh),
    pvGenerationKwh: dec(r.pvGenerationKwh),
    bessDischargeKwh: dec(r.bessDischargeKwh),
    deliveredKwh: dec(r.deliveredKwh),
    exportKwh: dec(r.exportKwh),
    gridCostYuan: dec(r.gridCostYuan),
    revenueYuan: dec(r.revenueYuan),
    opexYuan: dec(r.opexYuan),
    availabilityPct: dec(r.availabilityPct),
    source: r.source,
    note: r.note,
    recordedBy: r.recordedBy,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** 删除一条实测记录。 */
export async function deleteProjectActual(actualId: string): Promise<StoreResult<{ deleted: true }>> {
  try {
    await prisma.projectActual.delete({ where: { id: actualId } });
    return { ok: true, deleted: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { ok: false, reason: "not_found", detail: "实测记录不存在" };
    }
    return { ok: false, reason: "error", detail: errorDetail(e) };
  }
}

/* ────────────────────────── 版本指纹（供审计与报告） ────────────────────────── */

/** 本存储层写入的每一行都带这组版本指纹，供「按哪几版算的」自查。 */
export const DECISION_MODEL_COMPOSITION = {
  engineVersion: ENGINE_VERSION,
  modelVersion: MODEL_VERSION,
  benchmarkVersion: BENCHMARK_VERSION,
  reportBuilderVersion: REPORT_BUILDER_VERSION,
} as const;

/* ────────────────────────── 错误工具 ────────────────────────── */

function isForeignKeyError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2003" || e.code === "P2025");
}

function errorDetail(e: unknown): string {
  if (e instanceof Error) return e.message.slice(0, 500);
  return String(e).slice(0, 500);
}
