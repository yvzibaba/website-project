/**
 * V2 决策平台的**服务端编排层**：鉴权 + 输入契约 + 引擎调用 + 落库，收敛到一处。
 *
 * 为什么单独一层（在 `decision-store` 之上）：
 *   - `decision-store` 刻意「不含鉴权」（见其头注），把「谁能建/改哪个项目」交给调用方；
 *     本层就是那个调用方，把这条安全底线收敛到**一处**，供所有 V2 路由共用，
 *     杜绝每个端点各写一遍 owner 判断而漂移。
 *   - 命脉：本层**不自己算数**，一律转交 `decision-store → runCalculation()`；
 *     改参数 → 服务端重跑引擎 → 结果变 → 报告读最新快照，全程「程序算」。
 *
 * 铁律（安全）：
 *   - `ownerId` **只从服务端会话**取，绝不接受客户端传入（防冒名建/改他人项目）；
 *   - 资源级授权 = 「owner 本人 或 STAFF（REVIEWER/ADMIN）」，用纯函数判定，越权在**动库前**即拒；
 *   - 匿名项目（`ownerId=null`）仅 staff 可访问（保守拒绝，绝不让任意登录用户认领无主数据）；
 *   - 结果是判别联合（status: ok/invalid/not_found/forbidden/error），由 `api-guard.mutationResponse` 统一翻译。
 *   - 本层 server-only：直接 import prisma（经 store），绝不进任何 client bundle。
 */
import { z } from "zod";
import { STAFF_ROLES, type SessionUser } from "@app/kernel/lib/roles";
import { SCENARIO_COMPONENTS } from "@app/kernel/engine/types";
import type { ScenarioInput } from "@app/kernel/engine/types";
import { defaultScenarioInput, SCENARIO_TEMPLATES, buildScenarioFromTemplate, getScenarioTemplate } from "@app/kernel/engine/scenario";
import { validateScenarioInput } from "@app/kernel/engine/engine";
import { RECOMMEND_OBJECTIVES, recommendConfiguration } from "@app/kernel/engine/recommend";
import type { RecommendationRequest } from "@app/kernel/engine/recommend";
import { attributeScenarioDelta } from "@app/kernel/engine/attribution";
import { diagnoseScenario } from "@app/kernel/engine/diagnose";
import {
  addDecisionScenario,
  computeDecisionSnapshot,
  createDecisionProject,
  deleteDecisionScenario,
  deleteProjectActual,
  listDecisionProjects,
  listDecisionScenarios,
  listDecisionScenarioVersions,
  listProjectActuals,
  readDecisionProject,
  readDecisionScenario,
  recalculateDecisionScenario,
  saveDecisionScenarioAsVersion,
  upsertProjectActual,
} from "@app/kernel/server/decision-store";

/** 编排层版本（改鉴权口径 / 输入契约须升版记原因）。 */
export const DECISION_SERVICE_VERSION = "1.1.0"; // 1.1.0（R5 · 版本治理）：recalculate 透传 actor/reason/label 并回传 version + frozenSeq（重算会先冻结上一版）；新增 saveDecisionVersion / readDecisionVersions 两个 owner-or-staff 动作。鉴权口径不变（仍 owner 本人或 STAFF）。1.0.0：V2 编排初始。

/* ────────────────────────── 鉴权（纯函数优先，便于单测） ────────────────────────── */

/**
 * 纯函数：给定项目 owner 与当前会话用户，是否可访问？
 *   - STAFF（REVIEWER/ADMIN）：放行；
 *   - owner 本人：放行；
 *   - 其余（含 null owner 的无主项目）：一律拒。
 */
export function canAccessDecisionProject(ownerId: string | null | undefined, user: SessionUser): boolean {
  if (STAFF_ROLES.includes(user.role)) return true;
  return Boolean(ownerId) && ownerId === user.id;
}

/* ────────────────────────── 输入契约（Zod） ────────────────────────── */

/**
 * 情景输入契约。
 *
 * **刻意只做浅层结构校验**：本层负责回答「这是不是一个结构上像 `ScenarioInput` 的东西」，
 * 而不重复实现引擎的业务规则。深层数值规则（窗口倒挂、负车队、零并网容量、单位量纲…）
 * 由 `validateScenarioInput()` 与 `runCalculation()` 给出——那里的诊断带字段路径与影响说明，
 * 远比 zod 的通用文案更有用，且**只有一处**，不会出现"校验器说行、引擎说不行"的分裂。
 *
 * 嵌套对象用 `.passthrough()`：只做类型门禁（是对象），绝不剥离任何键
 * （剥离键会让用户填的值被静默丢掉，是比拒绝更糟的失败方式）。
 */
const looseObject = z.record(z.string(), z.unknown());

/** 引擎要求的必填项：服务费属市场调节价，必须由使用者显式给出，绝不代填默认值。 */
export const decisionScenarioInputSchema = z
  .object({
    schemaVersion: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1, "情景名称不能为空").max(120, "情景名称过长（≤120 字）"),
    definition: z
      .object({
        id: z.string().trim().min(1).max(80),
        label: z.string().trim().min(1).max(120),
        components: z
          .array(z.enum(SCENARIO_COMPONENTS))
          .min(1, "至少需要一个参与计算的组件")
          .max(SCENARIO_COMPONENTS.length, "组件超出可选集合"),
        managedCharging: z.boolean(),
        intent: z.string().max(500),
      })
      .passthrough(),
    site: looseObject,
    truck: looseObject,
    charging: looseObject,
    pv: looseObject,
    bess: looseObject,
    grid: looseObject,
    economics: z
      .object({
        // 唯一在此层强制「必须显式给出」的字段：它是市场调节价，没有可依据的默认值。
        chargingServiceFeeYuanPerKwh: z
          .number({ message: "必须显式给出充电服务费（市场调节价，无可依据的默认值）" })
          .finite("服务费必须是有限数字"),
        electricityResalePriceYuanPerKwh: z.number().finite().optional(),
      })
      .passthrough(),
    unknowns: z.record(z.string(), z.string()).optional(),
    note: z.string().max(2000).optional(),
  })
  .passthrough();

export const createDecisionProjectSchema = z.object({
  name: z.string().trim().min(1, "项目名称不能为空").max(200, "项目名称过长（≤200 字）"),
  description: z.string().trim().max(2000, "描述过长（≤2000 字）").optional(),
  regionId: z.string().trim().max(100).optional().nullable(),
  scenarioInput: decisionScenarioInputSchema,
});

export const addScenarioSchema = z.object({
  name: z.string().trim().min(1, "情景名称不能为空").max(120),
  scenarioInput: decisionScenarioInputSchema,
});

/** 重算：用「模板 id」或「增量补丁」二选一，禁止同时给（避免两处真相打架）；可附版本说明。 */
export const recalculateSchema = z
  .object({
    templateId: z.string().trim().min(1).max(60).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    // R5 版本治理：本次重算"为什么变"（写进冻结版本的 note + ChangeLog.reason），纯审计、非计算输入。
    reason: z.string().trim().max(2000).optional(),
    label: z.string().trim().max(100).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((v) => !(v.templateId && v.patch), {
    message: "不能同时指定模板与增量补丁（两处真相会打架）",
  });

/** 显式「存为新版本」的入参（只带命名/说明，不带任何计算输入——版本冻结的是当前已存结果）。 */
export const saveVersionSchema = z.object({
  label: z.string().trim().max(100).optional(),
  note: z.string().trim().max(2000).optional(),
});

export const actualSchema = z.object({
  scenarioId: z.string().trim().max(60).optional().nullable(),
  periodYear: z.number().int().min(2000).max(2200),
  periodMonth: z.number().int().min(0).max(12).optional(),
  gridImportKwh: z.number().finite().nonnegative().optional().nullable(),
  pvGenerationKwh: z.number().finite().nonnegative().optional().nullable(),
  bessDischargeKwh: z.number().finite().nonnegative().optional().nullable(),
  deliveredKwh: z.number().finite().nonnegative().optional().nullable(),
  exportKwh: z.number().finite().nonnegative().optional().nullable(),
  gridCostYuan: z.number().finite().optional().nullable(),
  revenueYuan: z.number().finite().optional().nullable(),
  opexYuan: z.number().finite().optional().nullable(),
  availabilityPct: z.number().finite().min(0).max(100).optional().nullable(),
  source: z.enum(["manual", "meter", "import"]).optional(),
  note: z.string().max(2000).optional().nullable(),
});

/* ────────────────────────── 结果判别联合（直接对接 mutationResponse） ────────────────────────── */

export type ServiceResult =
  | { status: "ok"; [k: string]: unknown }
  | { status: "invalid"; fieldErrors: Record<string, string[]>; error?: string }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "error"; error: string };

function toFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join(".") : "(root)";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** 把 zod 解析结果翻译成统一的 invalid 分支。 */
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): { ok: true; data: T } | { ok: false; result: ServiceResult } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, result: { status: "invalid", fieldErrors: toFieldErrors(parsed.error) } };
  return { ok: true, data: parsed.data };
}

/**
 * 去掉 `ownerId` 字段后返回浅拷贝。
 * 服务层对外的 project 载荷不暴露所有者标识（鉴权已在上游完成），
 * 用函数而非解构省略，避免产生未使用的局部变量。
 */
function withoutOwnerId<T extends { ownerId: string | null }>(project: T): Omit<T, "ownerId"> {
  const out: Record<string, unknown> = { ...project };
  delete out.ownerId;
  return out as Omit<T, "ownerId">;
}

/* ────────────────────────── 情景模板目录（声明式，供 UI 选择） ────────────────────────── */

/**
 * 列出可用的情景模板（供工作台「新建情景」下拉）。
 *
 * 只回目录，不回算好的数——按模板算数是引擎的事，且必须由服务端在落库时现算，
 * 客户端拿到的模板只有「定义」，不含任何结果，避免数字在两层之间对不上。
 */
export function listScenarioTemplates() {
  return SCENARIO_TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    components: [...t.components],
    managedCharging: t.managedCharging,
    intent: t.intent,
  }));
}

/** 按模板 id 生成一份情景输入（服务费仍需调用方给出）。未知模板如实报错，不猜。 */
export function buildTemplateInput(
  templateId: string,
  feeYuanPerKwh: number,
): { ok: true; input: ScenarioInput } | { ok: false; detail: string } {
  if (!getScenarioTemplate(templateId)) return { ok: false, detail: `未知的情景模板：${templateId}` };
  const built = buildScenarioFromTemplate(templateId, {
    name: getScenarioTemplate(templateId)!.label,
    chargingServiceFeeYuanPerKwh: feeYuanPerKwh,
  });
  return { ok: true, input: built.input };
}

/** 默认（山西重卡）情景输入骨架。 */
export function buildDefaultInput(feeYuanPerKwh: number): ScenarioInput {
  return defaultScenarioInput({
    chargingServiceFeeYuanPerKwh: feeYuanPerKwh,
    name: "山西重卡能源项目（默认对照）",
  }).input;
}

/* ────────────────────────── 读操作 ────────────────────────── */

export async function listMyDecisionProjects(input: { user: SessionUser }): Promise<ServiceResult> {
  const projects = await listDecisionProjects(input.user.id);
  return { status: "ok", projects };
}

export async function readOneDecisionProject(input: {
  projectId: string;
  user: SessionUser;
}): Promise<ServiceResult> {
  const project = await readDecisionProject(input.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };
  return { status: "ok", project: withoutOwnerId(project) };
}

export async function readOneDecisionScenario(input: {
  scenarioId: string;
  user: SessionUser;
}): Promise<ServiceResult> {
  const scenario = await readDecisionScenario(input.scenarioId);
  if (!scenario) return { status: "not_found" };
  const project = await readDecisionProject(scenario.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };
  return { status: "ok", scenario, project: withoutOwnerId(project) };
}

export async function listScenarioSummaries(input: {
  projectId: string;
  user: SessionUser;
}): Promise<ServiceResult> {
  const project = await readDecisionProject(input.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };
  return { status: "ok", scenarios: await listDecisionScenarios(input.projectId) };
}

export async function listActuals(input: { projectId: string; user: SessionUser }): Promise<ServiceResult> {
  const project = await readDecisionProject(input.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };
  return { status: "ok", actuals: await listProjectActuals(input.projectId) };
}

/* ────────────────────────── 写操作 ────────────────────────── */

export async function createDecisionProjectForUser(input: {
  user: SessionUser;
  body: unknown;
  generatedAtIso?: string;
}): Promise<ServiceResult> {
  const parsed = parseWith(createDecisionProjectSchema, input.body);
  if (!parsed.ok) return parsed.result;

  const r = await createDecisionProject({
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    regionId: parsed.data.regionId ?? null,
    ownerId: input.user.id, // 只从会话取，绝不接受客户端传入
    scenarioInput: parsed.data.scenarioInput as unknown as ScenarioInput,
    actor: `human:${input.user.id}`,
    generatedAtIso: input.generatedAtIso,
  });
  if (!r.ok) {
    if (r.reason === "invalid") return { status: "invalid", fieldErrors: { scenarioInput: [r.detail] } };
    if (r.reason === "not_found") return { status: "not_found" };
    return { status: "error", error: r.detail };
  }
  return {
    status: "ok",
    projectId: r.projectId,
    scenarioId: r.scenarioId,
    calcStatus: r.snapshot ? "ok" : "engine_failed",
    calcError: r.failure,
    // 计算失败时明确告知「项目建了，但结论没算出来」，绝不让 UI 以为拿到了结果
    warning: r.failure ? "项目已保存，但本次计算未通过校验，结论不可用，请修正输入后重算。" : undefined,
  };
}

export async function addScenarioToProject(input: {
  projectId: string;
  user: SessionUser;
  body: unknown;
  generatedAtIso?: string;
}): Promise<ServiceResult> {
  const project = await readDecisionProject(input.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };

  const parsed = parseWith(addScenarioSchema, input.body);
  if (!parsed.ok) return parsed.result;

  const r = await addDecisionScenario({
    projectId: input.projectId,
    name: parsed.data.name,
    scenarioInput: parsed.data.scenarioInput as unknown as ScenarioInput,
    generatedAtIso: input.generatedAtIso,
  });
  if (!r.ok) {
    if (r.reason === "invalid") return { status: "invalid", fieldErrors: { scenarioInput: [r.detail] } };
    if (r.reason === "not_found") return { status: "not_found" };
    return { status: "error", error: r.detail };
  }
  return {
    status: "ok",
    scenarioId: r.scenarioId,
    calcStatus: r.snapshot ? "ok" : "engine_failed",
    calcError: r.failure,
  };
}

export async function recalculateScenario(input: {
  scenarioId: string;
  user: SessionUser;
  body: unknown;
  generatedAtIso?: string;
}): Promise<ServiceResult> {
  const existing = await readDecisionScenario(input.scenarioId);
  if (!existing) return { status: "not_found" };
  const project = await readDecisionProject(existing.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };

  const parsed = parseWith(recalculateSchema, input.body ?? {});
  if (!parsed.ok) return parsed.result;

  let patch: Partial<ScenarioInput> | undefined;

  if (parsed.data.templateId) {
    const base = existing.scenarioInput;
    const fee = base?.economics?.chargingServiceFeeYuanPerKwh;
    if (!Number.isFinite(fee)) {
      // 模板切换会整体替换定义，但服务费属经营策略、必须保留——否则会把用户填的服务费悄悄抹掉
      return {
        status: "invalid",
        fieldErrors: { templateId: ["当前情景没有可继承的充电服务费，请先给出服务费再按模板切换"] },
      };
    }
    const built = buildTemplateInput(parsed.data.templateId, fee as number);
    if (!built.ok) return { status: "invalid", fieldErrors: { templateId: [built.detail] } };
    patch = built.input;
  } else if (parsed.data.patch) {
    patch = parsed.data.patch as Partial<ScenarioInput>;
  }

  const r = await recalculateDecisionScenario({
    scenarioId: input.scenarioId,
    patch,
    generatedAtIso: input.generatedAtIso,
    actor: `human:${input.user.id}`, // 只从会话取，绝不信客户端传的 actor
    reason: parsed.data.reason ?? parsed.data.note ?? null,
    label: parsed.data.label ?? null,
  });
  if (!r.ok) {
    if (r.reason === "invalid") return { status: "invalid", fieldErrors: { patch: [r.detail] } };
    if (r.reason === "not_found") return { status: "not_found" };
    return { status: "error", error: r.detail };
  }
  return {
    status: "ok",
    calcStatus: r.snapshot ? "ok" : "engine_failed",
    calcError: r.failure,
    version: r.version,
    frozenSeq: r.frozenSeq,
    // 诚实告知：重算不覆盖历史——上一版成功结果已被冻结为不可变版本，可回看、可比对。
    warning:
      r.frozenSeq != null
        ? `上一版结果已冻结为不可变版本 v${r.frozenSeq}（不会被本次重算覆盖）。`
        : undefined,
  };
}

/**
 * 显式「把当前情景存为一个不可变新版本」（不重算、不改当前态）。
 * 用于用户想给当下这版结论打个里程碑（如「电价上调后定稿」）。owner-or-staff，越权在动库前拒。
 */
export async function saveDecisionVersion(input: {
  scenarioId: string;
  user: SessionUser;
  body: unknown;
}): Promise<ServiceResult> {
  const existing = await readDecisionScenario(input.scenarioId);
  if (!existing) return { status: "not_found" };
  const project = await readDecisionProject(existing.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };

  const parsed = parseWith(saveVersionSchema, input.body ?? {});
  if (!parsed.ok) return parsed.result;

  const r = await saveDecisionScenarioAsVersion(input.scenarioId, {
    label: parsed.data.label,
    note: parsed.data.note,
    savedBy: `human:${input.user.id}`,
  });
  if (!r.ok) {
    if (r.reason === "invalid") return { status: "invalid", fieldErrors: { scenario: [r.detail] } };
    if (r.reason === "not_found") return { status: "not_found" };
    return { status: "error", error: r.detail };
  }
  return { status: "ok", versionId: r.versionId, seq: r.seq };
}

/** 读某情景的 V2 版本时间线（回看历史怎么来的）。owner-or-staff。 */
export async function readDecisionVersions(input: {
  scenarioId: string;
  user: SessionUser;
}): Promise<ServiceResult> {
  const existing = await readDecisionScenario(input.scenarioId);
  if (!existing) return { status: "not_found" };
  const project = await readDecisionProject(existing.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };

  return { status: "ok", versions: await listDecisionScenarioVersions(input.scenarioId) };
}

export async function deleteScenario(input: {
  scenarioId: string;
  user: SessionUser;
}): Promise<ServiceResult> {
  const existing = await readDecisionScenario(input.scenarioId);
  if (!existing) return { status: "not_found" };
  const project = await readDecisionProject(existing.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };

  const r = await deleteDecisionScenario(input.scenarioId);
  if (!r.ok) {
    if (r.reason === "invalid") return { status: "invalid", fieldErrors: { scenarioId: [r.detail] } };
    if (r.reason === "not_found") return { status: "not_found" };
    return { status: "error", error: r.detail };
  }
  return { status: "ok", deleted: true };
}

export async function saveActual(input: {
  projectId: string;
  user: SessionUser;
  body: unknown;
}): Promise<ServiceResult> {
  const project = await readDecisionProject(input.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };

  const parsed = parseWith(actualSchema, input.body);
  if (!parsed.ok) return parsed.result;

  const r = await upsertProjectActual({
    projectId: input.projectId,
    ...parsed.data,
    recordedBy: `human:${input.user.id}`,
  });
  if (!r.ok) {
    if (r.reason === "invalid") return { status: "invalid", fieldErrors: { actual: [r.detail] } };
    if (r.reason === "not_found") return { status: "not_found" };
    return { status: "error", error: r.detail };
  }
  return { status: "ok", actualId: r.actualId };
}

export async function removeActual(input: {
  actualId: string;
  projectId: string;
  user: SessionUser;
}): Promise<ServiceResult> {
  const project = await readDecisionProject(input.projectId);
  if (!project) return { status: "not_found" };
  if (!canAccessDecisionProject(project.ownerId, input.user)) return { status: "forbidden" };

  const r = await deleteProjectActual(input.actualId);
  if (!r.ok) {
    if (r.reason === "not_found") return { status: "not_found" };
    return { status: "error", error: r.detail };
  }
  return { status: "ok", deleted: true };
}

/* ────────────────────────── 单一生产计算入口（只算不存） ────────────────────────── */

/**
 * **唯一的生产计算入口**：把一份情景输入算成完整结果，但**不写库**。
 *
 * 为什么要有「只算不存」这一档：
 *   - 工作台需要「改一个参数先看看会怎样」的即时反馈，若每改一次都落库，
 *     数据库会被草稿淹没，历史版本也会失去意义；
 *   - 但它必须走**同一条**计算路径——若为预览另写一套轻量算法，页面上看到的数
 *     和保存后的数就会不一致，本项目最不能接受的就是这种「看起来正常的错数」。
 *   因此这里只是把 `runCalculation()` 的结果原样返回，一个公式都不重写。
 *
 * 返回结构刻意与落库路径同源（同一个 `computeDecisionSnapshot`），
 * 因此「预览的数字」与「保存的数字」在结构上就不可能不同。
 */
export function calculatePreview(input: { body: unknown; generatedAtIso?: string }): ServiceResult {
  const parsed = parseWith(decisionScenarioInputSchema, input.body);
  if (!parsed.ok) return parsed.result;

  const computed = computeDecisionSnapshot(parsed.data as unknown as ScenarioInput, {
    generatedAtIso: input.generatedAtIso,
  });
  if (!computed.ok) {
    return {
      status: "ok",
      calculated: false,
      reason: computed.reason,
      detail: computed.detail,
      diagnostics: computed.diagnostics,
      result: null,
    };
  }
  return {
    status: "ok",
    calculated: true,
    reason: null,
    detail: null,
    result: computed.snapshot.calc,
    report: computed.snapshot.report,
  };
}

/* ────────────────────────── 输入预检（供 UI 即时反馈，不落库） ────────────────────────── */

/**
 * 预检一份情景输入：返回 fatal / warnings，**不写库**。
 *
 * 用途：工作台在用户点「保存」之前就能看到「这个配置算不算得出来」，
 * 而不是等到保存失败才知道。与保存路径共用同一个 `validateScenarioInput()`，
 * 因此预检结论与保存结论必然一致（不会出现"预检说行、保存说不行"）。
 */
export function precheckScenarioInput(input: {
  body: unknown;
}): ServiceResult {
  const parsed = parseWith(decisionScenarioInputSchema, input.body);
  if (!parsed.ok) return parsed.result;
  const v = validateScenarioInput(parsed.data as unknown as ScenarioInput);
  return {
    status: "ok",
    fatal: v.fatal,
    warnings: v.warnings,
    canCalculate: v.fatal.length === 0,
  };
}

/* ────────────────────────── 自动推荐（M5 · 配置寻优） ────────────────────────── */

/** 档位数组：有限非负数，长度受限（防止客户端用超大档位数组把服务端算力打满）。 */
const finiteTierArray = z.array(z.number().finite().nonnegative()).min(1).max(40);

/**
 * 自动推荐请求契约。
 *
 * `base` 复用 `decisionScenarioInputSchema`——推荐器与计算/落库**共用同一个输入契约**。
 * 这不是省事，而是刻意的：如果推荐入口接受一种"简化版输入"，那么
 * 「推荐的配置」与「按这个配置保存后算出来的结果」就会走两套校验，
 * 迟早出现"推荐说可行、保存后不可行"的分裂。
 *
 * `maxEvaluations` 上限 2000：单次完整计算实测约 27 ms，2000 次约 54 秒，
 * 已经远超一次交互式请求的合理时长。设上限是防止该端点变成"匿名算力入口"。
 */
export const recommendRequestSchema = z.object({
  base: decisionScenarioInputSchema,
  existingGridCapacityKw: z.number().finite().nonnegative().optional(),
  space: z
    .object({
      chargerCounts: finiteTierArray.optional(),
      chargerPowersKw: finiteTierArray.optional(),
      bessEnergiesKwh: finiteTierArray.optional(),
      pvCapacitiesKwp: finiteTierArray.optional(),
      gridCapacitiesKw: finiteTierArray.optional(),
      managedChargingOptions: z.array(z.boolean()).min(1).max(2).optional(),
    })
    .optional(),
  objective: z.enum(RECOMMEND_OBJECTIVES).optional(),
  constraints: z
    .object({
      requireFeasible: z.boolean().optional(),
      requireNoUnserved: z.boolean().optional(),
      minNpvYuan: z.number().finite().optional(),
      maxPaybackYears: z.number().finite().positive().nullable().optional(),
    })
    .optional(),
  maxEvaluations: z.number().int().min(1).max(2000).optional(),
  refine: z.boolean().optional(),
});

/**
 * 在给定情景底座上搜索最优配置（**只算不存**）。
 *
 * 与 `calculatePreview` 同级：都是"算给用户看"的路径，都不写库。
 * 区别只在于前者算**一套**给定配置，后者算**很多套**并给出推荐。
 * 两者共用同一个 `runCalculation()` 与同一个输入契约，因此
 * 「推荐时看到的数」与「按推荐保存后算出来的数」必然一致。
 *
 * 本函数**不读也不写任何项目数据**（输入完全来自请求体），因此没有可越权的资源；
 * 鉴权与限流由路由层负责。
 */
export function recommendPreview(input: { body: unknown }): ServiceResult {
  const parsed = parseWith(recommendRequestSchema, input.body);
  if (!parsed.ok) return parsed.result;

  const out = recommendConfiguration(parsed.data as unknown as RecommendationRequest);
  if (!out.ok) {
    return {
      status: "ok",
      recommended: false,
      reason: out.reason,
      detail: out.detail,
      diagnostics: out.diagnostics,
      result: null,
    };
  }
  return { status: "ok", recommended: true, reason: null, detail: null, result: out };
}

/* ────────────────────────── 差异归因（M6 · 两情景"差在哪、各差多少"） ────────────────────────── */

/**
 * 两情景对比归因的请求契约。
 *
 * 只收两个已存档情景的 id + 目标口径，**不接受客户端传输入**——输入一律从库里已存的
 * 快照读取，这样"归因用的数"和"当初报告里的数"必然同源同版，杜绝客户端塞一套来路不明
 * 的输入进来算个结论。
 */
export const compareAttributionSchema = z.object({
  scenarioAId: z.string().trim().min(1).max(60),
  scenarioBId: z.string().trim().min(1).max(60),
  objective: z.enum(["npv", "equityNpv", "payback"]).optional(),
});

/**
 * 对同一账号可访问的两个已存档情景做**只算不存**的差异归因。
 *
 * 与 `recommendPreview` 同级：都是"算给用户看"，都不写库。命脉一致——本层不自己算，
 * 交给 `attributeScenarioDelta()`，后者又只用引擎唯一入口 `runCalculation()`。
 *
 * 鉴权：两个情景各自的宿主项目，当前用户都必须可访问（owner 本人或 STAFF），
 * 任一越权即在计算前 `forbidden`，绝不让用户借归因端点窥探他人数据。
 */
export async function compareScenarios(input: { body: unknown; user: SessionUser }): Promise<ServiceResult> {
  const parsed = parseWith(compareAttributionSchema, input.body);
  if (!parsed.ok) return parsed.result;
  const { scenarioAId, scenarioBId, objective } = parsed.data;

  const sa = await readDecisionScenario(scenarioAId);
  if (!sa) return { status: "not_found" };
  const sb = await readDecisionScenario(scenarioBId);
  if (!sb) return { status: "not_found" };

  const pa = await readDecisionProject(sa.projectId);
  const pb = await readDecisionProject(sb.projectId);
  if (!pa || !pb) return { status: "not_found" };
  if (!canAccessDecisionProject(pa.ownerId, input.user) || !canAccessDecisionProject(pb.ownerId, input.user)) {
    return { status: "forbidden" };
  }

  if (!sa.scenarioInput || !sb.scenarioInput) {
    return { status: "invalid", fieldErrors: { scenario: ["至少一个情景没有可复算的输入快照，无法归因（请重算后再对比）。"] } };
  }

  const out = attributeScenarioDelta(sa.scenarioInput, sb.scenarioInput, objective ? { objective } : {});
  if (!out.ok) {
    // 归因"作不出结论"是合法结果（如同情景 / 输入算不通），如实返回，绝不返回半成品。
    return {
      status: "ok",
      attributed: false,
      reason: out.reason,
      detail: out.detail,
      result: null,
      scenarioAId,
      scenarioBId,
    };
  }
  return { status: "ok", attributed: true, reason: null, detail: null, result: out };
}

/* ────────────────────────── 免费诊断（M4 · P5 · 免登录给结论倾向） ────────────────────────── */

/**
 * 免费诊断的请求契约：**只收"用户真正知道的那几件事"**
 * （车队规模、日里程、运营天数、充电窗口、并网容量、打算收的服务费），
 * 其余一律由服务端从默认基准补齐——与自动推荐同一套底座、同一个输入契约。
 *
 * `chargingServiceFeeYuanPerKwh` **必填、无默认**：服务费是市场调节价，
 * 给它默认值等于把"编造的市场价"混进免费结论。让使用者填自己打算收的价，
 * 才是诚实的免费层。
 */
export const diagnoseFreeSchema = z.object({
  chargingServiceFeeYuanPerKwh: z.number().finite().positive().max(10),
  truckCount: z.number().int().min(1).max(5000).optional(),
  dailyMileageKm: z.number().finite().min(1).max(2000).optional(),
  operatingDaysPerYear: z.number().int().min(1).max(365).optional(),
  chargingWindowStartHour: z.number().int().min(0).max(23).optional(),
  chargingWindowEndHour: z.number().int().min(1).max(48).optional(),
  existingGridCapacityKw: z.number().finite().positive().max(2_000_000).optional(),
  templateId: z.string().trim().min(1).max(40).optional(),
});

/**
 * 免登录免费诊断（**只算不存、不鉴权、不碰任何项目数据**）。
 *
 * 命脉一致：本层不自己算，交给 `diagnoseScenario()`，后者只用引擎唯一入口
 * `runCalculation()`。因此"免费看到的结论"与"登录后按同一输入保存后算出的结论"
 * 出自同一台机器、同一套公式，结构上不可能分叉。
 *
 * 鉴权：无（这是公开漏斗）。防刷由路由层负责（同源 CSRF + 按 IP 频控）。
 */
export function diagnoseFree(input: { body: unknown }): ServiceResult {
  const parsed = parseWith(diagnoseFreeSchema, input.body);
  if (!parsed.ok) return parsed.result;
  const b = parsed.data;

  const templateId = b.templateId ?? "pv-bess-tou";
  if (!getScenarioTemplate(templateId)) {
    return { status: "invalid", fieldErrors: { templateId: [`未知的情景模板：${templateId}`] } };
  }

  const built = defaultScenarioInput({
    chargingServiceFeeYuanPerKwh: b.chargingServiceFeeYuanPerKwh,
    templateId,
    name: "免费诊断（未落库）",
  });
  const si = built.input;
  // 只覆盖用户提供的少数项，其余保持默认基准（与推荐同底座）。
  if (b.truckCount != null) si.truck.truckCount = b.truckCount;
  if (b.dailyMileageKm != null) si.truck.dailyMileageKm = b.dailyMileageKm;
  if (b.operatingDaysPerYear != null) si.truck.operatingDaysPerYear = b.operatingDaysPerYear;
  if (b.chargingWindowStartHour != null) si.truck.chargingWindowStartHour = b.chargingWindowStartHour;
  if (b.chargingWindowEndHour != null) si.truck.chargingWindowEndHour = b.chargingWindowEndHour;
  if (b.existingGridCapacityKw != null) si.grid.capacityKw = b.existingGridCapacityKw;

  const result = diagnoseScenario(si);
  return { status: "ok", freeTier: true, result };
}
