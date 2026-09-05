/**
 * 沙盘「项目保存 / 情景更新 / 版本 / 回滚 / 读取」的**服务端编排 + 资源级鉴权**（中途重构 R6.3）。
 *
 * 为什么单独一层（在 R3 `sandbox-store` 之上）：
 *   - `sandbox-store` 刻意「不含鉴权」（见其头注），把「谁能建/改哪个项目」交给调用方；本层就是那个调用方，
 *     把这条安全底线收敛到**一处**（宪法第 16 条单一真源 / §28 权限测试重点），供 4 条 `/api/sandbox/**` 路由共用，
 *     杜绝每个端点各写一遍 owner 判断而漂移。
 *   - 命脉（§4）：本层**不自己算数**，一律转交 `sandbox-store`，后者在写入/回滚时 `runSandboxModel` 现算落库快照 +
 *     Decimal 汇总列；改参数 → 服务端重跑引擎 → 结果变 → 报告读最新版本，全程「程序算」。
 *
 * 铁律（安全）：
 *   - `ownerId` **只从服务端会话**（已登录 `user.id`）取，绝不接受客户端传入的 ownerId/actor（防冒名建/改他人项目）；
 *   - 资源级授权 = 「owner 本人 或 STAFF（REVIEWER/ADMIN）」，用纯函数 `canAccessProject` 判定，越权在**动库前**即拒；
 *   - 匿名 dev 项目（`ownerId=null`）仅 staff 可访问（保守拒绝，绝不让任意登录用户认领无主数据）；
 *   - 结果是不含裸抛的判别联合（ok/invalid/not_found/forbidden/error），由 `api-guard.mutationResponse` 统一翻译。
 *   - 本层 server-only：直接 import prisma，绝不进任何 client bundle。
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { STAFF_ROLES, type SessionUser } from "@/server/authz";
import {
  createProject,
  updateScenarioLayers,
  saveScenarioAsVersion,
  restoreScenarioFromVersion,
  getProjectWithScenarios,
  listScenarioVersions,
  type StoredParamLayers,
} from "@/server/sandbox-store";

const log = logger.child({ module: "server/sandbox-projects" });

/** 编排层版本（改鉴权口径 / 输入契约须升版记原因，规则 13）。 */
export const SANDBOX_PROJECTS_VERSION = "1.0.0";

/** 审计主体标识（写进 ChangeLog.savedBy/changedBy）；口径对齐 api-guard.actorOf，本地内联避免跨层依赖。 */
function actorOf(user: SessionUser): string {
  return `human:${user.id}`;
}

/* ────────────────────────── 鉴权（纯函数优先，便于 §28 单测） ────────────────────────── */

/**
 * 纯函数：给定项目 owner 与当前会话用户，是否可访问该项目？
 *   - STAFF（REVIEWER/ADMIN）：放行（后台治理）；
 *   - owner 本人：放行；
 *   - 其余（含 null owner 的匿名 dev 项目 vs 普通 USER）：一律拒（保守，绝不认领无主数据）。
 */
export function canAccessProject(ownerId: string | null | undefined, user: SessionUser): boolean {
  if (STAFF_ROLES.includes(user.role)) return true;
  return Boolean(ownerId) && ownerId === user.id;
}

/* ────────────────────────── 输入契约（Zod） ────────────────────────── */

/**
 * 参数分层：当作「不透明对象」**原样保留**（`z.record(z.string(), z.any())` 不改写、不剥离任何键）。
 *   刻意不做深层 ValueLayer 校验——那样会把 `region/policy` 里的 `effectiveFrom/effectiveUntil/source/bounds`
 *   等未声明键**静默剥掉**，直接破坏 R6.3 的政策日期窗复活（§4/§6 正确性）。引擎侧本就对脏值诚实降级、
 *   绝不裸抛（缺键→calcStatus 失败），故这里只保证「是对象」，把结构真相交给引擎而非校验器。
 */
const layersSchema = z.record(z.string(), z.any());

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "项目名称不能为空").max(200, "名称过长（≤200 字）"),
  description: z.string().trim().max(2000, "描述过长（≤2000 字）").optional(),
  regionId: z.string().trim().max(100).optional(),
  layers: layersSchema.default({}),
});

export const updateScenarioSchema = z.object({
  layers: layersSchema,
});

export const saveVersionSchema = z.object({
  label: z.string().trim().max(100).optional(),
  note: z.string().trim().max(2000).optional(),
});

export const restoreVersionSchema = z.object({
  versionId: z.string().trim().min(1, "缺少 versionId"),
});

/* ────────────────────────── 结果判别联合（对齐 api-guard.mutationResponse） ────────────────────────── */

export type SandboxProjectResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ status: "ok" } & T)
  | { status: "invalid"; fieldErrors: Record<string, string[]> }
  | { status: "not_found"; error?: string }
  | { status: "forbidden"; error?: string }
  | { status: "error"; error?: string };

/** 与 ok 泛型无关的失败臂——可直接并入任意 `SandboxProjectResult<T>`（供鉴权不通过时提前 return）。 */
type Denied =
  | { status: "invalid"; fieldErrors: Record<string, string[]> }
  | { status: "not_found"; error?: string }
  | { status: "forbidden"; error?: string }
  | { status: "error"; error?: string };

function invalid(detail: string, field = "name"): Denied {
  return { status: "invalid", fieldErrors: { [field]: [detail] } };
}

/* ────────────────────────── 资源级访问解析（查库拿 owner，越权在动库前拦） ────────────────────────── */

type Access = { ok: true; projectId: string } | { ok: false; result: Denied };

async function accessByProjectId(projectId: string, user: SessionUser): Promise<Access> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true },
  });
  if (!project) return { ok: false, result: { status: "not_found", error: "项目不存在" } };
  if (!canAccessProject(project.ownerId, user)) {
    log.warn("sandbox project access denied", { projectId, userId: user.id, role: user.role });
    return { ok: false, result: { status: "forbidden", error: "无权访问该沙盘项目" } };
  }
  return { ok: true, projectId };
}

async function accessByScenarioId(scenarioId: string, user: SessionUser): Promise<Access> {
  const sc = await prisma.projectScenario.findUnique({
    where: { id: scenarioId },
    select: { id: true, projectId: true, project: { select: { ownerId: true } } },
  });
  if (!sc) return { ok: false, result: { status: "not_found", error: "情景不存在" } };
  if (!canAccessProject(sc.project?.ownerId, user)) {
    log.warn("sandbox scenario access denied", { scenarioId, userId: user.id, role: user.role });
    return { ok: false, result: { status: "forbidden", error: "无权访问该情景所属项目" } };
  }
  return { ok: true, projectId: sc.projectId };
}

/* ────────────────────────── 精简视图（不外泄大 JSON / Decimal，UI 只 needed 字段） ────────────────────────── */

const num = (d: unknown): number | null => (d == null ? null : Number(d));

interface ScenarioView {
  id: string;
  name: string;
  isBaseline: boolean;
  version: number;
  calcStatus: string;
  calcRef: string | null;
  capexNet: number | null;
  npv: number | null;
  irrPct: number | null;
  paybackYears: number | null;
  roiRatio: number | null;
  updatedAt: string;
}

function toScenarioView(s: {
  id: string;
  name: string;
  isBaseline: boolean;
  version: number;
  calcStatus: string;
  calcRef: string | null;
  capexNet: unknown;
  npv: unknown;
  irrPct: unknown;
  paybackYears: unknown;
  roiRatio: unknown;
  updatedAt: Date;
}): ScenarioView {
  return {
    id: s.id,
    name: s.name,
    isBaseline: s.isBaseline,
    version: s.version,
    calcStatus: s.calcStatus,
    calcRef: s.calcRef,
    capexNet: num(s.capexNet),
    npv: num(s.npv),
    irrPct: num(s.irrPct),
    paybackYears: num(s.paybackYears),
    roiRatio: num(s.roiRatio),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/* ────────────────────────── 编排函数（路由先 requireSameOriginActor 拿到 user，再调这里） ────────────────────────── */

/** 建项目 + 基线情景：ownerId 强制为会话用户；initialLayers 现算落库（§4）。 */
export async function createSandboxProject(
  body: unknown,
  ctx: { user: SessionUser },
): Promise<SandboxProjectResult<{ projectId: string; scenarioId: string }>> {
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return { status: "invalid", fieldErrors: zodFieldErrors(parsed.error) };
  }
  const res = await createProject({
    name: parsed.data.name,
    description: parsed.data.description,
    regionId: parsed.data.regionId ?? null,
    ownerId: ctx.user.id, // ★只信服务端会话，杜绝客户端传 ownerId 冒名
    initialLayers: parsed.data.layers as StoredParamLayers,
    actor: actorOf(ctx.user),
  });
  if (res.ok) {
    log.info("sandbox project created via api", { projectId: res.projectId, userId: ctx.user.id });
    return { status: "ok", projectId: res.projectId, scenarioId: res.scenarioId };
  }
  if (res.reason === "invalid") return invalid(res.detail);
  return { status: "error", error: res.detail };
}

/** 改情景参数分层 → 服务端重跑引擎落新快照（version++）。 */
export async function updateSandboxScenario(
  scenarioId: string,
  body: unknown,
  ctx: { user: SessionUser },
): Promise<SandboxProjectResult<{ calcStatus: string; version: number }>> {
  const access = await accessByScenarioId(scenarioId, ctx.user);
  if (!access.ok) return access.result;
  const parsed = updateScenarioSchema.safeParse(body);
  if (!parsed.success) return { status: "invalid", fieldErrors: zodFieldErrors(parsed.error) };

  const res = await updateScenarioLayers(scenarioId, parsed.data.layers as StoredParamLayers, {
    actor: actorOf(ctx.user),
  });
  if (res.ok) return { status: "ok", calcStatus: res.calcStatus, version: res.version };
  if (res.reason === "not_found") return { status: "not_found", error: res.detail };
  return { status: "error", error: res.detail };
}

/** 把情景当前态冻结为不可变版本（seq++），供回滚 / 逐版本报告（§9 / 规则 13）。 */
export async function saveSandboxScenarioVersion(
  scenarioId: string,
  body: unknown,
  ctx: { user: SessionUser },
): Promise<SandboxProjectResult<{ versionId: string; seq: number }>> {
  const access = await accessByScenarioId(scenarioId, ctx.user);
  if (!access.ok) return access.result;
  const parsed = saveVersionSchema.safeParse(body ?? {});
  if (!parsed.success) return { status: "invalid", fieldErrors: zodFieldErrors(parsed.error) };

  const res = await saveScenarioAsVersion(scenarioId, {
    label: parsed.data.label,
    note: parsed.data.note,
    savedBy: actorOf(ctx.user),
  });
  if (res.ok) return { status: "ok", versionId: res.versionId, seq: res.seq };
  if (res.reason === "not_found") return { status: "not_found", error: res.detail };
  return { status: "error", error: res.detail };
}

/** 回滚：取历史版本参数分层 → 重新跑引擎写回情景当前态（version++）。 */
export async function restoreSandboxScenarioVersion(
  scenarioId: string,
  body: unknown,
  ctx: { user: SessionUser },
): Promise<SandboxProjectResult<{ calcStatus: string; version: number }>> {
  const access = await accessByScenarioId(scenarioId, ctx.user);
  if (!access.ok) return access.result;
  const parsed = restoreVersionSchema.safeParse(body);
  if (!parsed.success) return { status: "invalid", fieldErrors: zodFieldErrors(parsed.error) };

  const res = await restoreScenarioFromVersion(scenarioId, parsed.data.versionId, { actor: actorOf(ctx.user) });
  if (res.ok) return { status: "ok", calcStatus: res.calcStatus, version: res.version };
  if (res.reason === "not_found") return { status: "not_found", error: res.detail };
  if (res.reason === "forbidden") return { status: "forbidden", error: res.detail };
  return { status: "error", error: res.detail };
}

/** 读项目（含情景列表精简视图）——须先过 owner-or-staff。 */
export async function readSandboxProject(
  projectId: string,
  ctx: { user: SessionUser },
): Promise<SandboxProjectResult<{ project: unknown }>> {
  const access = await accessByProjectId(projectId, ctx.user);
  if (!access.ok) return access.result;
  const project = await getProjectWithScenarios(projectId);
  if (!project) return { status: "not_found", error: "项目不存在" };
  return {
    status: "ok",
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      regionId: project.regionId,
      status: project.status,
      ownerId: project.ownerId,
      updatedAt: project.updatedAt.toISOString(),
      region: project.region ?? null,
      scenarios: project.scenarios.map(toScenarioView),
    },
  };
}

/** 读某情景版本时间线（倒序）——须先过 owner-or-staff。 */
export async function readSandboxScenarioVersions(
  scenarioId: string,
  ctx: { user: SessionUser },
): Promise<SandboxProjectResult<{ versions: unknown }>> {
  const access = await accessByScenarioId(scenarioId, ctx.user);
  if (!access.ok) return access.result;
  const rows = await listScenarioVersions(scenarioId);
  return {
    status: "ok",
    versions: rows.map((v) => ({
      id: v.id,
      seq: v.seq,
      label: v.label,
      note: v.note,
      calcRef: v.calcRef,
      savedBy: v.savedBy,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

/* Zod error → api-guard 期望的 fieldErrors（{ field: [msg,...] }）。 */
function zodFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of err.issues) {
    const key = i.path.length ? String(i.path[0]) : "_";
    (out[key] ??= []).push(i.message);
  }
  return out;
}
