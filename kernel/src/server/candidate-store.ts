/**
 * R8 · 上游产业项目池「候选草料」持久层（server 域逻辑 · 只这一张新表）。
 *
 * 为什么存在（mandate §八–§十一「广泛发现，极度聚焦」）：V2 需要一个**比正式项目/方案轻得多**的
 *   草料池，把散落的产业线索先收进来、程序筛一遍、决定哪些值得进入正式研究。此前没有任何一张表承载
 *   「还没资格立项、但已值得记录」的东西。本层补上这块拼图，且**只新增 CandidateProject 一张表**
 *   （宪法「能派生就不新增表」——evidence/unknowns/screeningResult 全内联 JSONB，不建关联表）。
 *
 * 铁律（对齐 mandate §十）：
 *   - **裁决由纯函数程序算，不由 LLM 口算**：`createCandidate` / `screenAndSave` 都调
 *     `@app/kernel/lib/candidate-screening` 的 `screenCandidate`（有序六闸门槛状态机），
 *     把 verdict + 逐闸 trace + 原因快照落 `screeningResult`（可复算、可追溯，规则 7）。
 *   - **绝不碰 Benchmark / Engine / 参数层**（§十「AI 输出不得直接改基准/引擎」的更严版本——本层连读都不读）：
 *     发现期草料是"未核实的假设"，把它接进计算真源会污染整条经济链。守卫测试（tests/unit/r8-candidate-guard.test.ts）
 *     钉死本文件的 import 集合永不含 benchmark / engine / finance / parameter。
 *   - **AI 产出恒为候选、须人工核验**：`sourceType=AI_RESEARCH` 只影响展示，不改变"任何来源都要过六闸 +
 *     人裁决才 PROMOTED"的门槛；本层只提供 PROMOTE 的**回填指针字段**，真正的提升（写 Case/Project）
 *     留待人工在后台触发，且属创始人/真实数据域（此处不自动建 Case/Project）。
 *
 * 诚实（§20）：DB 表未迁移（`CandidateProject` 生产尚未 apply）时，prisma 会抛 P2021「table does not
 *   exist」——本层**捕获并降级**为 `{ ok:false, tableMissing:true }`，让上层显式标 `CODE COMPLETE /
 *   REAL-WORLD INPUT PENDING`，而非假装写成功或 500 崩溃。
 *
 * 边界：本文件是 server 域逻辑（route 层调用，受 `requireStaffWrite` CSRF + REVIEWER/ADMIN 门禁保护）。
 *   本仓刻意**不 `import "server-only"`**（vitest/纯 node 下会抛错），仅注释标注，与其余 *-store 同构。
 */
import { z } from "zod";
import { prisma } from "@app/kernel/lib/prisma";
import { logger } from "@app/kernel/lib/logger";
import { Prisma, type Industry } from "@prisma/client";
import {
  screenCandidate,
  CANDIDATE_SCREENING_VERSION,
  type CandidateScreeningInput,
  type ScreeningOutcome,
  type ScreeningVerdict,
} from "@app/kernel/lib/candidate-screening";

const log = logger.child({ module: "server/candidate-store" });

/** 持久层版本（改映射 / 落库字段口径须升版并记原因，规则 13）。 */
export const CANDIDATE_STORE_VERSION = "1.0.0"; // 1.0.0（R8）：首版，仅新增一张表 + 内联 JSONB。

/* ─────────────────────────── 白名单（String 列 + TS 校验，非 Prisma enum） ─────────────────────────── */

/** 来源类型白名单：AI 产出恒为候选（须人工核验），IMPORT 预留批量导入。 */
export const CANDIDATE_SOURCE_TYPES = ["MANUAL", "AI_RESEARCH", "IMPORT"] as const;
export type CandidateSourceType = (typeof CANDIDATE_SOURCE_TYPES)[number];

/**
 * 状态白名单：NEW → SCREENING 是过程态；写入即由六闸裁定落到 verdict 四态之一；
 * PROMOTED 为人工提升后的终态（本层不自动置，留待后台人工触发）。
 */
export const CANDIDATE_STATUSES = [
  "NEW",
  "SCREENING",
  "CANDIDATE",
  "NEED_MORE_EVIDENCE",
  "REJECT",
  "READY_FOR_PROJECT",
  "PROMOTED",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** 行业白名单（对齐 prisma `Industry` enum；此处用字符串避免运行时依赖 enum 生成顺序）。 */
export const CANDIDATE_INDUSTRIES = [
  "NEW_ENERGY",
  "INDUSTRIAL_MANUFACTURING",
  "TRANSPORTATION",
  "AGRICULTURE_FORESTRY_FISHERY",
  "EDUCATION_TRAINING",
  "REAL_ESTATE_CONSTRUCTION",
  "OTHER",
] as const;

/* ─────────────────────────── 入参 schema（写边界再校验一遍，防录入/落库规则漂移） ─────────────────────────── */

const EvidenceItemSchema = z.object({
  claim: z.string().trim().max(2000).optional(),
  kind: z.string().trim().max(40).optional(),
  confidence: z.number().int().min(0).max(100).nullish(),
  sourceUrl: z.string().trim().max(2000).nullish(),
  note: z.string().trim().max(2000).nullish(),
});

/**
 * 筛查提示（可选）：`paramCompleteness / hasEconomics / industryValuePresent / disqualifiers`
 *   不是 CandidateProject 的独立列（保持"只一张表"），故随草料临时传入，缺省时：
 *   - paramCompleteness 由**实际列的填充度**派生（[description,technology,estimatedScale,region] present 比例），
 *   - economics / industryValue 默认 false（发现期"未确证"→ 保守，倾向 NEED_MORE_EVIDENCE/CANDIDATE 而非误放行）。
 *   传入的 hints 会连同归一后的严格输入一起快照进 `screeningResult.inputs`，保证可复算。
 */
export const ScreeningHintsSchema = z.object({
  paramCompleteness: z.number().min(0).max(1).nullish(),
  disqualifiers: z.array(z.string().trim().min(1)).max(50).nullish(),
  hasEconomics: z.boolean().nullish(),
  industryValuePresent: z.boolean().nullish(),
});

export const CreateCandidateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  industry: z.enum(CANDIDATE_INDUSTRIES).default("NEW_ENERGY"),
  region: z.string().trim().max(200).nullish(),
  source: z.string().trim().min(1).max(2000),
  sourceType: z.enum(CANDIDATE_SOURCE_TYPES).default("MANUAL"),
  description: z.string().trim().max(5000).nullish(),
  technology: z.string().trim().max(2000).nullish(),
  estimatedScale: z.string().trim().max(200).nullish(),
  evidence: z.array(EvidenceItemSchema).max(200).default([]),
  unknowns: z.array(z.record(z.string().max(50), z.unknown())).max(200).optional(),
  screeningHints: ScreeningHintsSchema.optional(),
});
export type CreateCandidateInput = z.input<typeof CreateCandidateSchema>;

/* ─────────────────────────── 结果形状（判别联合 · 失败不裸抛） ─────────────────────────── */

export interface CandidateRow {
  id: string;
  title: string;
  industry: Industry;
  region: string | null;
  source: string;
  sourceType: string;
  description: string | null;
  technology: string | null;
  estimatedScale: string | null;
  evidence: Prisma.JsonValue;
  unknowns: Prisma.JsonValue;
  screeningResult: Prisma.JsonValue;
  status: string;
  version: number;
  promotedCaseId: string | null;
  promotedProjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CandidateStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; invalid: true; fieldErrors: Record<string, string[]> }
  | { ok: false; tableMissing: true; error: string }
  | { ok: false; notFound: true }
  | { ok: false; error: string };

/** 判别 Prisma 是否因"表未迁移"报错（P2021）。迁移应用属创始人域（生产部署 STOP）。 */
function isTableMissing(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "P2021"
  );
}

/** JSON 深拷贝（去函数 / undefined，保 JSONB 往返稳定，同 decision-store.jsonSafe）。 */
function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
function jsonForCol(v: unknown): Prisma.InputJsonValue {
  return (v == null ? Prisma.DbNull : jsonSafe(v)) as Prisma.InputJsonValue;
}

/**
 * 列填充度派生参数完整度：无显式 hint 时，用 [description,technology,estimatedScale,region]
 *   四项里非空的比例近似"关键参数填了多少"。刻意的粗口径（发现期草料本就不完整）。
 */
function deriveParamCompleteness(c: {
  description?: string | null;
  technology?: string | null;
  estimatedScale?: string | null;
  region?: string | null;
}): number {
  const fields = [c.description, c.technology, c.estimatedScale, c.region];
  const present = fields.filter((f) => typeof f === "string" && f.trim().length > 0).length;
  return present / fields.length;
}

/** 可传给归一函数的最小结构（新建吃校验后的完整 input，重算吃既有行 + 上次快照 hints）。 */
interface ScreenableFragment {
  title?: string | null;
  region?: string | null;
  technology?: string | null;
  description?: string | null;
  estimatedScale?: string | null;
  evidence?: CandidateScreeningInput["evidence"];
  screeningHints?: Partial<{
    paramCompleteness: number | null;
    disqualifiers: string[] | null;
    hasEconomics: boolean | null;
    industryValuePresent: boolean | null;
  }>;
}

/** 把草料 + hints 归一成严格筛查输入（供 assessCandidate & 快照 inputs）。 */
function buildScreeningInput(c: ScreenableFragment): CandidateScreeningInput {
  const hints = c.screeningHints ?? {};
  return {
    titlePresent: typeof c.title === "string" && c.title.trim().length > 0,
    regionPresent: typeof c.region === "string" && c.region.trim().length > 0,
    technologyPresent: typeof c.technology === "string" && c.technology.trim().length > 0,
    evidence: Array.isArray(c.evidence) ? c.evidence : [],
    paramCompleteness:
      typeof hints.paramCompleteness === "number"
        ? hints.paramCompleteness
        : deriveParamCompleteness(c),
    disqualifiers: Array.isArray(hints.disqualifiers) ? hints.disqualifiers : [],
    hasEconomics: hints.hasEconomics === true,
    industryValuePresent: hints.industryValuePresent === true,
  };
}

/** 把纯函数裁决 + 归一输入组装成 `screeningResult` JSONB 快照（可复算 · 可追溯）。 */
function buildScreeningSnapshot(input: CandidateScreeningInput, outcome: ScreeningOutcome) {
  return {
    screeningVersion: CANDIDATE_SCREENING_VERSION,
    storeVersion: CANDIDATE_STORE_VERSION,
    computedAt: new Date().toISOString(),
    verdict: outcome.verdict,
    gates: outcome.gates,
    reasons: outcome.reasons,
    thresholds: outcome.thresholds,
    inputs: input, // 归一后的严格输入快照 → 任何人可拿它重跑 screenCandidate 复现 verdict
  };
}

/* ─────────────────────────── 写路径 ─────────────────────────── */

/**
 * 新建候选并**当场程序筛查**落库：跑 `assessCandidate` → status=verdict，`screeningResult`=完整快照。
 * 校验失败 → invalid（带 fieldErrors）；表未迁移 → tableMissing（不假装成功）。
 */
export async function createCandidate(
  raw: CreateCandidateInput,
): Promise<CandidateStoreResult<CandidateRow>> {
  const parsed = CreateCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { ok: false, invalid: true, fieldErrors };
  }
  const input = parsed.data;
  const screeningInput = buildScreeningInput(input);
  const outcome = screenCandidate(screeningInput);
  const snapshot = buildScreeningSnapshot(screeningInput, outcome);

  try {
    const row = await prisma.candidateProject.create({
      data: {
        title: input.title,
        industry: input.industry as Industry,
        region: input.region ?? null,
        source: input.source,
        sourceType: input.sourceType,
        description: input.description ?? null,
        technology: input.technology ?? null,
        estimatedScale: input.estimatedScale ?? null,
        evidence: jsonForCol(input.evidence ?? []),
        unknowns: input.unknowns == null ? Prisma.DbNull : jsonForCol(input.unknowns),
        screeningResult: jsonForCol(snapshot),
        status: outcome.verdict as CandidateStatus,
        version: 1,
      },
    });
    log.info("candidate created + screened", {
      id: row.id,
      verdict: outcome.verdict,
      sourceType: input.sourceType,
    });
    return { ok: true, data: row as unknown as CandidateRow };
  } catch (e) {
    if (isTableMissing(e)) {
      log.warn("candidate create skipped — table not migrated yet", { code: "P2021" });
      return { ok: false, tableMissing: true, error: "CandidateProject 表尚未迁移（待生产部署域）" };
    }
    log.error("candidate create failed", { err: (e as Error)?.message });
    return { ok: false, error: (e as Error)?.message ?? "create failed" };
  }
}

/**
 * 对既有候选**重跑筛查**并回写（新增/编辑草料后刷新裁决，规则 13 版本自增 +1，不新增历史行）。
 * 找不到 → notFound；表未迁移 → tableMissing。
 */
export async function screenAndSave(
  id: string,
): Promise<CandidateStoreResult<CandidateRow>> {
  if (!/^[a-z0-9]{10,}$/i.test(id)) return { ok: false, notFound: true };
  try {
    const existing = await prisma.candidateProject.findUnique({ where: { id } });
    if (!existing) return { ok: false, notFound: true };

    // 从**列 + 既有快照 inputs** 重建筛查输入（若存过 inputs 则复用其 economics/industryValue/disqualifiers
    //   等无法从列派生的 hint，保持与上次一致的可复算性；否则回落列派生）。
    const priorInputs = extractPriorInputs(existing.screeningResult);
    const screeningInput = buildScreeningInput({
      title: existing.title,
      region: existing.region,
      technology: existing.technology,
      description: existing.description,
      estimatedScale: existing.estimatedScale,
      evidence: asEvidenceArray(existing.evidence),
      screeningHints: priorInputs,
    });
    const outcome = screenCandidate(screeningInput);
    const snapshot = buildScreeningSnapshot(screeningInput, outcome);

    const row = await prisma.candidateProject.update({
      where: { id },
      data: {
        screeningResult: jsonForCol(snapshot),
        status: outcome.verdict as CandidateStatus,
        version: { increment: 1 },
      },
    });
    return { ok: true, data: row as unknown as CandidateRow };
  } catch (e) {
    if (isTableMissing(e)) {
      return { ok: false, tableMissing: true, error: "CandidateProject 表尚未迁移（待生产部署域）" };
    }
    log.error("candidate rescreen failed", { id, err: (e as Error)?.message });
    return { ok: false, error: (e as Error)?.message ?? "screen failed" };
  }
}

/* ─────────────────────────── 读路径 ─────────────────────────── */

export interface ListCandidatesQuery {
  status?: string;
  industry?: string;
  region?: string;
  limit?: number;
}

/** 列表：默认按 createdAt 倒序，可按 status/industry/region 过滤。表未迁移 → tableMissing。 */
export async function listCandidates(
  q: ListCandidatesQuery = {},
): Promise<CandidateStoreResult<CandidateRow[]>> {
  const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
  const where: Prisma.CandidateProjectWhereInput = {};
  if (q.status && (CANDIDATE_STATUSES as readonly string[]).includes(q.status)) where.status = q.status;
  if (q.industry && (CANDIDATE_INDUSTRIES as readonly string[]).includes(q.industry))
    where.industry = q.industry as Industry;
  if (q.region && q.region.trim()) where.region = { contains: q.region.trim(), mode: "insensitive" };

  try {
    const rows = await prisma.candidateProject.findMany({ where, orderBy: { createdAt: "desc" }, take: limit });
    return { ok: true, data: rows as unknown as CandidateRow[] };
  } catch (e) {
    if (isTableMissing(e)) {
      return { ok: false, tableMissing: true, error: "CandidateProject 表尚未迁移（待生产部署域）" };
    }
    log.error("candidate list failed", { err: (e as Error)?.message });
    return { ok: false, error: (e as Error)?.message ?? "list failed" };
  }
}

export async function getCandidate(id: string): Promise<CandidateStoreResult<CandidateRow>> {
  if (!/^[a-z0-9]{10,}$/i.test(id)) return { ok: false, notFound: true };
  try {
    const row = await prisma.candidateProject.findUnique({ where: { id } });
    if (!row) return { ok: false, notFound: true };
    return { ok: true, data: row as unknown as CandidateRow };
  } catch (e) {
    if (isTableMissing(e)) {
      return { ok: false, tableMissing: true, error: "CandidateProject 表尚未迁移（待生产部署域）" };
    }
    log.error("candidate get failed", { id, err: (e as Error)?.message });
    return { ok: false, error: (e as Error)?.message ?? "get failed" };
  }
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function asEvidenceArray(v: unknown): CandidateScreeningInput["evidence"] {
  return Array.isArray(v) ? (v as CandidateScreeningInput["evidence"]) : [];
}

/** 从既有 screeningResult JSONB 里取出上次快照的 hints（仅取无法从列派生的那几项）。 */
function extractPriorInputs(sr: Prisma.JsonValue): ScreeningHintsSnapshot | undefined {
  if (!sr || typeof sr !== "object" || Array.isArray(sr)) return undefined;
  const inputs = (sr as Record<string, unknown>).inputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return undefined;
  const i = inputs as Record<string, unknown>;
  return {
    paramCompleteness: typeof i.paramCompleteness === "number" ? i.paramCompleteness : null,
    disqualifiers: Array.isArray(i.disqualifiers) ? (i.disqualifiers as string[]) : null,
    hasEconomics: typeof i.hasEconomics === "boolean" ? i.hasEconomics : null,
    industryValuePresent:
      typeof i.industryValuePresent === "boolean" ? i.industryValuePresent : null,
  };
}

/** 上次快照里能作为 hints 复用的子集（null = 上次没给，回落列派生）。 */
type ScreeningHintsSnapshot = Partial<{
  paramCompleteness: number | null;
  disqualifiers: string[] | null;
  hasEconomics: boolean | null;
  industryValuePresent: boolean | null;
}>;

export type { ScreeningVerdict };
