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
 *    本层**不含鉴权**——「谁能建/改哪个项目」由 R6.3 接上的路由层（`/api/sandbox/**`）用
 *    `requireSameOriginActor`（登录）+ `sandbox-projects` 的 owner-or-staff 判定把关，本层只认调用方已鉴权。
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma, type ChangeAction, type Industry } from "@prisma/client";
import { runSandboxModel, type CalcResult } from "@/server/sandbox-model";
import { resolveSandbox } from "@/server/sandbox-params";
import type { ResolveLayers, ValueLayer } from "@/server/parameter-engine";

const log = logger.child({ module: "server/sandbox-store" });

/** 持久层版本（改映射口径须升版并记原因，规则 13）。 */
export const STORE_VERSION = "1.0.3"; // 1.0.3：内核升级冻结策略（创始人裁决 2026-09-08）——updateScenarioLayers 在内核身份变化时同事务自动把旧成功结果冻结为 ProjectVersion；新增冻结摘要读路径（纯提取不重算）。零 schema 变更，全复用既有版本结构

/**
 * 落库的参数分层（去掉引擎注入项 `derived`——派生值注册在引擎里，不该持久化函数）。
 *
 * `now` 语义（R6.3 修正）：**判政策生效/过期的时钟作为「输入」被持久化并回放**，而非每次重算取当前时间。
 *   理由（§4 / 规则 7 可复算 / §9）：一个已存情景若用「此刻」重算，会随某省补贴到期而在未来悄悄变数——
 *   审计/版本系统绝不该有这种时间漂移。锁定当时时钟 → 同输入必得同结果，且服务端重算与客户端预览逐位对齐。
 *   省略 `now` 则回落引擎极早时间（epoch-0）——兼容既有仅传 `user` 值、不含日期窗的用例（如 R3 集成测试）。
 *   经 JSON 落库后 Date 会变成 ISO 串，故类型允许 `Date | string`，重放前由 `toEngineLayers` 统一复活。
 */
export interface StoredParamLayers {
  region?: ValueLayer;
  policy?: ValueLayer[];
  user?: ValueLayer;
  now?: Date | string | null;
}

/** 把可能来自 JSON 的日期字段复活成引擎要的 `Date`；无效/缺失 → undefined（绝不塞 Invalid Date）。 */
function toDate(v: Date | string | number | null | undefined): Date | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 复活单个 ValueLayer 的生效窗口（policy 层常带 effectiveFrom/Until，落库后为 ISO 串）。 */
function reviveValueLayer(l: ValueLayer): ValueLayer {
  const out: ValueLayer = { ...l };
  const ef = toDate(l.effectiveFrom as Date | string | null | undefined);
  const eu = toDate(l.effectiveUntil as Date | string | null | undefined);
  if (ef) out.effectiveFrom = ef;
  else delete out.effectiveFrom;
  if (eu) out.effectiveUntil = eu;
  else delete out.effectiveUntil;
  return out;
}

/**
 * 把持久化/客户端传来的分层归一成引擎入参：复活 `now` 与各层日期窗为真正的 `Date`。
 *
 * 为何必须（§4/§6 正确性）：`resolveParameters` 里 `now < layer.effectiveFrom` 若一侧是 JSON 反序列化出的
 *   **字符串**，关系运算会把字符串 `Number()` 成 `NaN` → 比较恒 false → 过期/未生效政策被**误判为现行**
 *   （与 `now` 回落 epoch-0 把现行政策误判为未生效，是同一处的两个方向性 bug）。落库回放前一律复活为 Date。
 * 纯函数、可离线单测；`region/policy/user` 缺省即不注入该层（保持既有空分层行为不变）。
 */
export function toEngineLayers(layers: StoredParamLayers): Omit<ResolveLayers, "derived"> {
  const out: Omit<ResolveLayers, "derived"> = {};
  if (layers.region) out.region = reviveValueLayer(layers.region);
  if (layers.policy) out.policy = layers.policy.map(reviveValueLayer);
  if (layers.user) out.user = reviveValueLayer(layers.user);
  const now = toDate(layers.now);
  if (now) out.now = now;
  return out;
}

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

/* ─────────── 冻结策略（创始人裁决 2026-09-08「历史项目"生成时模型版本"冻结策略」） ───────────
 * 目标：模型升级后，历史结论绝不被静默覆盖；每个快照可回答「按哪几版内核算的」。
 * 复用既有 ProjectVersion 不可变切片，不另建版本系统、不改 schema。
 * ──────────────────────────────────────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从 CalcResult（或其 JSON 快照）取 engineVersions 指纹；非对象/缺失 → undefined。 */
function engineVersionsOf(calc: unknown): Record<string, unknown> | undefined {
  if (isRecord(calc) && isRecord(calc.engineVersions)) return calc.engineVersions as Record<string, unknown>;
  return undefined;
}

/**
 * engineVersions 指纹：**键排序后**序列化。
 * 必须与键序无关——Postgres jsonb 列不保留对象键序（读回时键被规范化重排），直接 stringify
 * 会让「同内核」被误判为「指纹变化」，产生冗余冻结（E2E 实证）。值仅版本串，排序即唯一规范形。
 */
function engineVersionsFingerprint(ev: Record<string, unknown> | undefined): string {
  if (!ev) return "";
  return JSON.stringify(Object.keys(ev).sort().map((k) => [k, ev[k]]));
}

/**
 * 判定「写新结果前是否必须先把旧结果冻结为不可变版本」（纯函数，离线单测）。
 *
 * 触发条件（任一成立，且旧结果为**成功**快照——失败快照不是结论，覆写无损失）：
 *   1. calcRef 变化（如 model@1.0.0 → model@1.1.0，即模型升版后重算）；
 *   2. engineVersions 指纹变化（含**没有** engineVersions 键的更老历史行——首次再编辑即受保护）。
 * 同内核下的普通参数编辑 → 不冻结（version++ 就地覆盖正是 §4 命脉的日常路径）。
 */
export function shouldAutoFreezeVersion(input: {
  oldCalcRef: string | null;
  oldCalcResult: unknown;
  nextCalcRef: string;
  nextEngineVersions?: Record<string, unknown>;
}): { freeze: boolean; why: string } {
  const old = input.oldCalcResult;
  if (!isRecord(old) || old.ok !== true) return { freeze: false, why: "旧结果缺失或非成功快照" };
  const oldRef = typeof old.calcRef === "string" ? old.calcRef : input.oldCalcRef;
  if (oldRef != null && oldRef !== input.nextCalcRef)
    return { freeze: true, why: `calcRef ${oldRef} → ${input.nextCalcRef}` };
  const oldEv = engineVersionsOf(old);
  if (engineVersionsFingerprint(oldEv) !== engineVersionsFingerprint(input.nextEngineVersions))
    return { freeze: true, why: "engineVersions 指纹变化（含历史行缺版本键）" };
  return { freeze: false, why: "" };
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** 冻结版本的可展示摘要（全部从冻结 calcResult JSON **原样提取**，绝不重算——历史数字不变的承诺）。 */
export interface FrozenVersionSummary {
  calcStatus: string;
  calcRef: string | null;
  capexNet: string | null;
  opexY1Gross: string | null;
  npv: string | null;
  irrPct: string | null;
  paybackYears: string | null;
  roiRatio: string | null;
  engineVersions: {
    model: string | null;
    tech: string | null;
    finance: string | null;
    params: string | null;
    /** 旧行缺键 → null（API 层映射 "none" = SVE 之前生成）。 */
    storage: string | null;
  };
}

function frozenNullSummary(
  calcStatus: string,
  calcRef: string | null,
  engineVersions: FrozenVersionSummary["engineVersions"],
): FrozenVersionSummary {
  return {
    calcStatus,
    calcRef,
    capexNet: null,
    opexY1Gross: null,
    npv: null,
    irrPct: null,
    paybackYears: null,
    roiRatio: null,
    engineVersions,
  };
}

/**
 * 把一条冻结 calcResult JSON 提炼为可展示摘要。成功快照复用 `projectCalcToColumns`
 * （同一四舍五入/诚实 null 口径），另补 opexY1 与 engineVersions；形态损坏时诚实降级
 * calcStatus="unreadable"，绝不抛错、绝不编数。
 */
export function frozenVersionSummary(calcResult: unknown): FrozenVersionSummary {
  const ev: Record<string, unknown> = engineVersionsOf(calcResult) ?? {};
  const engineVersions = {
    model: strOrNull(ev.model),
    tech: strOrNull(ev.tech),
    finance: strOrNull(ev.finance),
    params: strOrNull(ev.params),
    storage: strOrNull(ev.storage),
  };
  if (!isRecord(calcResult)) return frozenNullSummary("unreadable", null, engineVersions);
  if (calcResult.ok !== true) {
    const status = typeof calcResult.reason === "string" ? calcResult.reason : "unreadable";
    return frozenNullSummary(status, strOrNull(calcResult.calcRef), engineVersions);
  }
  try {
    const cols = projectCalcToColumns(calcResult as unknown as CalcResult);
    const opex = isRecord(calcResult.opexY1) ? calcResult.opexY1 : {};
    return {
      ...cols,
      opexY1Gross: decimalStr(typeof opex.gross === "number" ? opex.gross : null, 2),
      engineVersions,
    };
  } catch {
    return frozenNullSummary("unreadable", strOrNull(calcResult.calcRef), engineVersions);
  }
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
  // ★用归一（复活 now 与政策日期窗）后的分层喂引擎，保证服务端重算 == 客户端预览、可复算确定（§4/§6/§9）。
  const engineLayers = toEngineLayers(layers);
  const calc = runSandboxModel(engineLayers);
  const numeric = resolveSandbox(engineLayers).numeric;
  return {
    paramLayers: jsonSafe(layers) as object, // 存原始输入（now 及日期窗 JSON 化后为 ISO 串，回放时再复活）
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

  // regionId 外键安全护栏（§17 E2E 抓出的真 bug）：沙盘「选地区」用的是内存地区包代码
  // （如 "shanxi" / "national"），而 Project.regionId 是指向规范 Region 表（cuid）的外键。
  // R5 之前二者不建表链接——直接把包代码塞进外键会 P2003、保存即 500。故：仅当传入的 regionId
  // 确有其 Region 行才落该外键，否则诚实置空（地区真值已完整存于 layers / paramSnapshot，绝不丢）。
  let regionId: string | null = input.regionId ?? null;
  if (regionId) {
    const regionRow = await prisma.region.findUnique({ where: { id: regionId }, select: { id: true } });
    if (!regionRow) {
      log.info("sandbox regionId not a canonical Region row; leaving Project.regionId null", { regionId });
      regionId = null;
    }
  }

  try {
    const project = await prisma.project.create({
      data: {
        name,
        description: input.description?.trim() || null,
        industry: input.industry ?? "NEW_ENERGY",
        regionId,
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

/** 更新情景参数分层 → 现算重跑 → 回写快照与汇总列（version++）。§4 命脉的持久化落点。
 *
 * 冻结策略（创始人裁决 2026-09-08）：写新结果前若检测到**计算内核身份变化**（shouldAutoFreezeVersion），
 * 在**同一事务内**先把旧成功结果冻结为一条不可变 ProjectVersion（seq=max+1，ChangeLog 记原因），
 * 再就地覆写当前态——历史结论绝不被新模型静默覆盖。同内核普通参数编辑照旧 version++、不产生冗余版本。
 */
export async function updateScenarioLayers(
  scenarioId: string,
  layers: StoredParamLayers,
  opts: { actor?: string | null } = {},
): Promise<
  | { ok: true; calcStatus: string; version: number; frozenSeq?: number }
  | { ok: false; reason: "not_found" | "error"; detail: string }
> {
  const data = computeScenarioData(layers);
  try {
    const existing = await prisma.projectScenario.findUnique({
      where: { id: scenarioId },
      select: {
        id: true,
        projectId: true,
        version: true,
        calcRef: true,
        calcResult: true,
        paramLayers: true,
        paramSnapshot: true,
      },
    });
    if (!existing) return { ok: false, reason: "not_found", detail: "情景不存在" };

    const freeze = shouldAutoFreezeVersion({
      oldCalcRef: existing.calcRef,
      oldCalcResult: existing.calcResult,
      nextCalcRef: data.calcRef,
      nextEngineVersions: engineVersionsOf(data.calcResult),
    });

    const updated = await prisma.$transaction(async (tx) => {
      let frozenSeq: number | undefined;
      if (freeze.freeze) {
        const maxSeq = await tx.projectVersion.aggregate({
          where: { scenarioId },
          _max: { seq: true },
        });
        frozenSeq = (maxSeq._max.seq ?? 0) + 1;
        await tx.projectVersion.create({
          data: {
            scenarioId,
            projectId: existing.projectId,
            seq: frozenSeq,
            label: null,
            note: `自动冻结（内核升级保护）：${freeze.why}`,
            paramLayers: existing.paramLayers as object,
            paramSnapshot: existing.paramSnapshot as object,
            calcResult: (existing.calcResult ?? Prisma.DbNull) as Prisma.InputJsonValue,
            calcRef: existing.calcRef,
            needsProfessionalReview:
              existing.calcResult &&
              typeof existing.calcResult === "object" &&
              "needsProfessionalReview" in (existing.calcResult as object)
                ? Boolean((existing.calcResult as { needsProfessionalReview?: unknown }).needsProfessionalReview)
                : true,
            savedBy: opts.actor ?? null,
          },
          select: { seq: true },
        });
        await tx.changeLog.create({
          data: changeLogArgs(
            existing.projectId,
            "UPDATE",
            opts.actor ?? null,
            `内核升级自动冻结旧结果为版本 v${frozenSeq}（${freeze.why}）`,
            { calcRef: existing.calcRef },
            { calcRef: data.calcRef, frozenSeq },
          ),
        });
      }
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
      return { s, frozenSeq };
    });
    return {
      ok: true,
      calcStatus: data.calcStatus,
      version: updated.s.version,
      ...(updated.frozenSeq != null ? { frozenSeq: updated.frozenSeq } : {}),
    };
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

/** 读某情景的版本时间线（倒序）。`frozen` 为该版本冻结结果的**原样提取**摘要（不重算，历史数字不变）。 */
export async function listScenarioVersions(scenarioId: string) {
  const rows = await prisma.projectVersion.findMany({
    where: { scenarioId },
    orderBy: { seq: "desc" },
    select: {
      id: true,
      seq: true,
      label: true,
      note: true,
      calcRef: true,
      savedBy: true,
      createdAt: true,
      calcResult: true,
    },
  });
  return rows.map((r) => ({ ...r, frozen: frozenVersionSummary(r.calcResult) }));
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
