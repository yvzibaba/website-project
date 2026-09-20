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
import {
  addDecisionScenario,
  computeDecisionSnapshot,
  createDecisionProject,
  deleteDecisionScenario,
  deleteProjectActual,
  listDecisionProjects,
  listDecisionScenarios,
  listProjectActuals,
  readDecisionProject,
  readDecisionScenario,
  recalculateDecisionScenario,
  upsertProjectActual,
} from "@app/kernel/server/decision-store";

/** 编排层版本（改鉴权口径 / 输入契约须升版记原因）。 */
export const DECISION_SERVICE_VERSION = "1.0.0";

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

/** 重算：用「模板 id」或「增量补丁」二选一，禁止同时给（避免两处真相打架）。 */
export const recalculateSchema = z
  .object({
    templateId: z.string().trim().min(1).max(60).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => !(v.templateId && v.patch), {
    message: "不能同时指定模板与增量补丁（两处真相会打架）",
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
  };
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
