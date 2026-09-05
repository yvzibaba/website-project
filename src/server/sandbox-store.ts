/**
 * 沙盘「项目模型」持久层（中途重构 R3，server 域逻辑）。
 *
 * 这是《项目中途重构总控》§14 优先级 #2「项目模型」的落地：把 R2 计算引擎产出的 `CalcResult`
 * 连同**输入参数分层**（§5 参数引擎的 region/policy/user 三层 ValueLayer）持久化，并支持
 * 情景（多组参数对比，§14 #9）与版本（快照回滚，规则 13 / §9「报告读版本」）。
 *
 * 命脉铁律（§4）：**只存输入 + 可复算快照，绝不存「页面数字」**。
 *   - 每次写入前先 `runSandboxModel(layers)` 现算，落 `calcResult` 快照 + 从快照派生的少量精确汇总列；
 *   - 读回 / 回滚时**重新跑引擎**（`updateScenarioLayers` / `restoreScenarioFromVersion`），
 *     使「改参数 → 引擎重算 → 经济结果变」这条链在持久层同样成立，而不是把旧数字搬来搬去。
 *
 * 货币精确（第 15 条唯一动用 Decimal 处）：引擎内部估算是 Number（`sandbox-finance`），但**落库**的
 *   `capexNet/npv/irrPct/paybackYears/roiRatio` 用 Prisma `Decimal` 防浮点漂移（同 `Order.amount`），
 *   且一律以**四舍五入后的字符串**写入，绝不让 JS 浮点污染账。这些列是从 `calcResult` 派生的可查询冗余，
 *   单一真源仍是 JSON 快照；算不出（失败 / NaN / IRR 无解）时**诚实留 null，绝不填假值**（第 20 条）。
 *
 * ⚠️ 全部结论继承 R2 的 `needsProfessionalReview=true`（§16），本层不做任何「已核实」暗示；
 *    本层**不含鉴权**——「谁能建/改哪个项目」由调用方（R4 页面 / 路由）用 `requireUser` 把关。
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma, type ChangeAction, type Industry } from "@prisma/client";
import { runSandboxModel, type CalcResult } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import type { ResolveLayers } from "@/server/parameter-engine";

const log = logger.child({ module: "server/sandbox-store" });

/** 持久层版本（改映射口径须升版并记原因，规则 13）。 */
export const STORE_VERSION = "1.0.0";

/** 落库的参数分层（去掉引擎注入项 derived 与运行时钟 now，now 每次重算取当前时间）。 */
export type StoredParamLayers = Pick<ResolveLayers, "region" | "policy" | "user">;

/**
 * 从 `CalcResult` 派生可查询的精确汇总列（纯函数，脱离 DB 单测）。
 * 失败结果与算不出的指标一律 null（诚实，绝不用 0 冒充「没赚也没亏」）。
 */
export function projectCalcToColumns(calc: CalcResult): {
  calcStatus: string;
  calcRef: string;
  capexNet: string | null;
  npv: string | null;
  irrPct: string | null;
  paybackYears: string | null;
  roiRatio: string | null;
} {
  if (!calc.ok) {
    return {
      calcStatus: calc.reason, // tech_error | missing_econ_inputs | invalid_econ_inputs
      calcRef: calc.calcRef,
      capexNet: null,
      npv: null,
      irrPct: null,
      paybackYears: null,
      roiRatio: null,
    };
  }
  const m = calc.metrics;
  const irrVal = m.irr.ok ? m.irr.value : undefined;
  return {
    calcStatus: "ok",
    calcRef: calc.calcRef,
    capexNet: decimalStr(calc.capex.net, 2),
    npv: decimalStr(m.npv, 2),
    irrPct: irrVal != null ? decimalStr(irrVal * 100, 4) : null,
    paybackYears: decimalStr(m.discountedPaybackYears, 2), // 折现回收期；分析期内未回本→null
    roiRatio: m.roi.ok ? decimalStr(m.roi.value, 4) : null,
  };
}

/** 数值 → 定点小数字符串喂 Decimal 列；非有限（含 NaN）→ null，绝不写 Infinity/NaN。 */
function decimalStr(n: number | null | undefined, dp: number): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(dp);
}

/** JSON 快照归一：把 NaN/Infinity 折成 null（JSON 本无此值），保证落库结构确定可回读。 */
function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function changeLogArgs(
  entityId: string,
  action: ChangeAction,
  changedBy: string | null,
  reason: string,
  before: unknown,
  after: unknown,
): Prisma.ChangeLogUncheckedCreateInput {
  return {
    entityType: "Project",
    entityId,
    action,
    changedBy: changedBy ?? undefined,
    reason,
    before: jsonOrNull(before),
    after: jsonOrNull(after),
  };
}
function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v == null ? (Prisma.DbNull as typeof Prisma.DbNull) : (v as Prisma.InputJsonValue);
}

/* 一次「算 + 准备入库数据」的中间产物（纯，供建/改情景复用）。 */
function computeScenarioData(layers: StoredParamLayers) {
  const calc = runSandboxModel(layers);
  const numeric = resolveSandbox(layers).numeric;
  return {
    paramLayers: jsonSafe(layers) as object,
    paramSnapshot: jsonSafe(numeric) as object,
    calcResult: jsonSafe(calc) as object,
    ...projectCalcToColumns(calc),
  };
}

/** 建项目结果判别联合（不裸抛，Prisma 错误归一）。 */
export type CreateProjectResult =
  | { ok: true; projectId: string; scenarioId: string }
  | { ok: false; reason: "invalid" | "error"; detail: string };

export interface CreateProjectInput {
  name: string;
  description?: string;
  industry?: Industry;
  regionId?: string | null;
  ownerId?: string | null;
  /** 初始参数分层（省略则纯基线占位假设）。 */
  initialLayers?: StoredParamLayers;
  /** 审计主体（"human:<id>"），仅记录、非鉴权。 */
  actor?: string | null;
}

/**
 * 创建项目 + 其基线情景（一次事务，现算基线 `CalcResult` 一并落库）。
 * §4 命脉：`initialLayers` 里改了任何参数 → 落库的 calcResult 与汇总列即随之变。
 */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const name = input.name?.trim();
  if (!name) return { ok: false, reason: "invalid", detail: "项目名称不能为空" };

  const layers: StoredParamLayers = input.initialLayers ?? {};
  const data = computeScenarioData(layers);

  try {
    const project = await prisma.project.create({
      data: {
        name,
        description: input.description?.trim() || null,
        industry: input.industry ?? "NEW_ENERGY",
        regionId: input.regionId ?? null,
        ownerId: input.ownerId ?? null,
        status: "DRAFT",
        scenarios: {
          create: {
            name: "基准情景",
            isBaseline: true,
            paramLayers: data.paramLayers,
            paramSnapshot: data.paramSnapshot,
            calcResult: data.calcResult,
            calcStatus: data.calcStatus,
            calcRef: data.calcRef,
            capexNet: data.capexNet,
            npv: data.npv,
            irrPct: data.irrPct,
            paybackYears: data.paybackYears,
            roiRatio: data.roiRatio,
          },
        },
      },
      select: { id: true, scenarios: { where: { isBaseline: true }, select: { id: true } } },
    });
    const scenarioId = project.scenarios[0]?.id ?? "";
    await prisma.changeLog.create({
      data: changeLogArgs(project.id, "CREATE", input.actor ?? null, "创建沙盘项目 + 基线情景", null, {
        name,
        calcStatus: data.calcStatus,
      }),
    });
    log.info("sandbox project created", { projectId: project.id, calcStatus: data.calcStatus });
    return { ok: true, projectId: project.id, scenarioId };
  } catch (e) {
    return prismaErr(e, "createProject");
  }
}

/** 更新情景参数分层 → 现算重跑 → 回写快照与汇总列（version++）。§4 命脉的持久化落点。 */
export async function updateScenarioLayers(
  scenarioId: string,
  layers: StoredParamLayers,
  opts: { actor?: string | null } = {},
): Promise<
  { ok: true; calcStatus: string; version: number } | { ok: false; reason: "not_found" | "error"; detail: string }
> {
  const data = computeScenarioData(layers);
  try {
    const existing = await prisma.projectScenario.findUnique({
      where: { id: scenarioId },
      select: { id: true, projectId: true, version: true },
    });
    if (!existing) return { ok: false, reason: "not_found", detail: "情景不存在" };

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.projectScenario.update({
        where: { id: scenarioId },
        data: {
          paramLayers: data.paramLayers,
          paramSnapshot: data.paramSnapshot,
          calcResult: data.calcResult,
          calcStatus: data.calcStatus,
          calcRef: data.calcRef,
          capexNet: data.capexNet,
          npv: data.npv,
          irrPct: data.irrPct,
          paybackYears: data.paybackYears,
          roiRatio: data.roiRatio,
          version: { increment: 1 },
        },
        select: { version: true },
      });
      await tx.changeLog.create({
        data: changeLogArgs(
          existing.projectId,
          "UPDATE",
          opts.actor ?? null,
          "更新情景参数并重算",
          { version: existing.version },
          { version: s.version, calcStatus: data.calcStatus },
        ),
      });
      return s;
    });
    return { ok: true, calcStatus: data.calcStatus, version: updated.version };
  } catch (e) {
    return prismaErr(e, "updateScenarioLayers");
  }
}

/**
 * 把情景当前态冻结为一个不可变版本（seq = 该场景 max+1），供回滚 / 逐版本报告（§9 / 规则 13）。
 * 冻结的是**当前已算好**的 paramLayers/paramSnapshot/calcResult（就地取快照，不重算）。
 */
export async function saveScenarioAsVersion(
  scenarioId: string,
  opts: { label?: string; note?: string; savedBy?: string | null } = {},
): Promise<
  { ok: true; versionId: string; seq: number } | { ok: false; reason: "not_found" | "error"; detail: string }
> {
  try {
    const sc = await prisma.projectScenario.findUnique({
      where: { id: scenarioId },
      select: {
        id: true,
        projectId: true,
        paramLayers: true,
        paramSnapshot: true,
        calcResult: true,
        calcRef: true,
      },
    });
    if (!sc) return { ok: false, reason: "not_found", detail: "情景不存在" };

    const maxSeq = await prisma.projectVersion.aggregate({
      where: { scenarioId },
      _max: { seq: true },
    });
    const seq = (maxSeq._max.seq ?? 0) + 1;
    const needsReview =
      sc.calcResult && typeof sc.calcResult === "object" && "needsProfessionalReview" in (sc.calcResult as object)
        ? Boolean((sc.calcResult as { needsProfessionalReview?: unknown }).needsProfessionalReview)
        : true;

    const created = await prisma.$transaction(async (tx) => {
      const v = await tx.projectVersion.create({
        data: {
          scenarioId,
          projectId: sc.projectId,
          seq,
          label: opts.label?.trim() || null,
          note: opts.note?.trim() || null,
          paramLayers: sc.paramLayers as object,
          paramSnapshot: sc.paramSnapshot as object,
          calcResult: (sc.calcResult ?? Prisma.DbNull) as Prisma.InputJsonValue,
          calcRef: sc.calcRef,
          needsProfessionalReview: needsReview,
          savedBy: opts.savedBy ?? null,
        },
        select: { id: true, seq: true },
      });
      await tx.changeLog.create({
        data: changeLogArgs(sc.projectId, "UPDATE", opts.savedBy ?? null, `存为版本 v${seq}`, null, {
          scenarioId,
          seq,
        }),
      });
      return v;
    });
    return { ok: true, versionId: created.id, seq: created.seq };
  } catch (e) {
    return prismaErr(e, "saveScenarioAsVersion");
  }
}

/**
 * 回滚：把某历史版本的参数分层取回、**重新跑引擎**写回情景当前态（version++）。
 * 刻意重算而非直接搬旧 calcResult——引擎升版后回滚会得到同参数下的**最新**结果（§4，规则 7 可复算）。
 */
export async function restoreScenarioFromVersion(
  scenarioId: string,
  versionId: string,
  opts: { actor?: string | null } = {},
): Promise<
  | { ok: true; calcStatus: string; version: number }
  | { ok: false; reason: "not_found" | "forbidden" | "error"; detail: string }
> {
  try {
    const [sc, ver] = await Promise.all([
      prisma.projectScenario.findUnique({ where: { id: scenarioId }, select: { id: true, projectId: true } }),
      prisma.projectVersion.findUnique({
        where: { id: versionId },
        select: { id: true, scenarioId: true, paramLayers: true },
      }),
    ]);
    if (!sc) return { ok: false, reason: "not_found", detail: "情景不存在" };
    if (!ver || ver.scenarioId !== scenarioId)
      return { ok: false, reason: "forbidden", detail: "该版本不属于此情景" };

    const layers = ver.paramLayers as StoredParamLayers;
    return updateScenarioLayers(scenarioId, layers, { actor: opts.actor ?? null });
  } catch (e) {
    return prismaErr(e, "restoreScenarioFromVersion");
  }
}

/** 读项目（含其情景列表与汇总列），不含鉴权。 */
export async function getProjectWithScenarios(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    include: {
      scenarios: { orderBy: [{ isBaseline: "desc" }, { createdAt: "asc" }] },
      region: { select: { id: true, name: true, code: true } },
    },
  });
}

/** 读某情景的版本时间线（倒序）。 */
export async function listScenarioVersions(scenarioId: string) {
  return prisma.projectVersion.findMany({
    where: { scenarioId },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true, label: true, note: true, calcRef: true, savedBy: true, createdAt: true },
  });
}

/** Prisma 已知错误归一（不裸抛，指面对齐 case/solution-admin 口径）。 */
function prismaErr(e: unknown, where: string): { ok: false; reason: "error"; detail: string } {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    log.warn(`${where} prisma error`, { code: e.code });
    return { ok: false, reason: "error", detail: `数据库错误(${e.code})` };
  }
  log.error(`${where} failed`, { err: e });
  return { ok: false, reason: "error", detail: "持久层操作失败" };
}
