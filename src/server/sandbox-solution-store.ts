/**
 * 沙盘「产业方案草案 → 落库」编排（中途重构 R8.2 · 总控最高优先级「商业闭环」的第二块拼图）。
 *
 * 职责：把 R8.1 的**纯映射桥**（`sandbox-solution.ts` 产出的 `SandboxSolutionDraft`，在浏览器里由引擎
 * 现算）落成一条**真实的 `Solution` DRAFT 行**，并挂上财务条目（`SolutionFinancial`）与关键未知
 * （`UnknownVariable`），从而接进平台既有的「方案后台 → 发布（publishGuard）→ 查看 → 购买（Order）」闭环。
 *
 * 设计（宪法第 2/7/16 条 + 「AI 做劳动、人做关键决策」）：
 *   - **不另写一遍落库逻辑**：全部委托 `solution-admin` 里**已单测/集成测死**的 `createSolution` /
 *     `addSolutionFinancial` / `addSolutionUnknown`（第 16 条单一真源）——它们各自守住 `SolutionCreateSchema`
 *     校验、`caseId` 外键预检（拒 `P2003`、给清楚的 `fieldErrors.caseId`）、强制 `status=DRAFT`、写 `ChangeLog`。
 *   - **绝不自动发布**：只建 DRAFT；能否对外售卖由人在后台补真实数据 + 定价后经 `publishGuard` 决定
 *     （沙盘草案 `needsProfessionalReview=true` + `riskDomains` 非空，发布时若无价 / 未勾专业确认必被拦）。
 *   - **诚实搬运、绝不重算**：本层不做任何经济计算，数字是客户端引擎算好后随草案上行；服务端**结构校验**
 *     （复用同一批 Zod schema）后原样落库，与 R6.2/R6.3「服务端不复算、只守结构与权限」同一口径。
 *     安全边界：本端点受 **staff（REVIEWER/ADMIN）+ CSRF** 门禁——能手工建/改方案后台本就是 staff 权限，
 *     导出桥不赋予任何人超过 `POST /api/admin/solutions` 的权力（普通访客 / 买家碰不到）。
 *   - **失败诚实回报、不裸抛、不留半脏成功**：`createSolution` 未 `ok` 即整笔中止并透传其状态
 *     （invalid/not_found/blocked/error）；方案建成后的财务 / 未知条目若个别失败，记入 `warnings` 而非
 *     伪报成功（方案仍是合法 DRAFT，可后台补齐）。
 *
 * 边界：`Solution.caseId` 是**必填非空外键**（R8.1 头注已述）——这是 R6.4 `regionId` 的 `P2003` 教训的
 *   同类风险，故导出前**必须**先由人指定一个真实存在的案例；本层用 `createSolution` 的外键预检兜住，
 *   案例不存在 → `invalid.caseId`，绝不 500。
 */

import { z } from "zod";
// 注：本模块为 server 域逻辑（route 层调用）。本仓刻意不 import "server-only"（vitest/node 会抛错），仅注释标注。
import { CuidSchema, SlugSchema, CurrencySchema } from "@/lib/validation";
import {
  createSolution,
  addSolutionFinancial,
  addSolutionUnknown,
  SolutionFinancialInputSchema,
  SolutionUnknownInputSchema,
} from "@/server/solution-admin";

/** 落库编排口径版本（组合规则 / 回写字段变化须升版记因，宪法第 13 条）。 */
export const SANDBOX_SOLUTION_STORE_VERSION = "1.0.0";

/* ─────────────────────────── 入参 schema（复用既有单一真源，防录入/落库两套规则漂移） ─────────────────────────── */

/** 十进制价格串（与 `solution-admin.DecimalStringSchema` 同形：非负、最多 6 位小数）。 */
const PriceStringSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, "价格必须是十进制数字（不含负号）");

/**
 * 导出落库入参：一份 R8.1 草案的**可落库子集** + 人指定的 `caseId`（必填外键）。
 * 财务 / 未知条目**直接复用** `solution-admin` 的入参 schema（同一份校验，绝不各写一套）。
 */
export const SandboxSolutionPersistSchema = z.object({
  caseId: CuidSchema,
  title: z.string().trim().min(1, "标题不能为空").max(300, "标题过长"),
  slug: SlugSchema,
  summary: z.string().trim().max(5000).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  riskDomains: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  needsProfessionalReview: z.boolean().optional(),
  price: PriceStringSchema.optional(),
  currency: CurrencySchema.optional(),
  financials: z.array(SolutionFinancialInputSchema).max(10).optional(),
  unknowns: z.array(SolutionUnknownInputSchema).max(200).optional(),
  /** 客户端算出的发布阻塞清单：仅原样回显给人（不参与落库判定），故宽松接收。 */
  publishBlockers: z.array(z.string().max(500)).max(50).optional(),
});
export type SandboxSolutionPersistInput = z.infer<typeof SandboxSolutionPersistSchema>;

/* ─────────────────────────── 结果类型（与 api-guard.MutationLike 结构兼容，可直喂 mutationResponse） ─────────────────────────── */

export interface SandboxSolutionPersistResult {
  status: "ok" | "invalid" | "not_found" | "blocked" | "error";
  solutionId?: string;
  fieldErrors?: Record<string, string[]>;
  error?: string;
  /** 成功落库的财务 / 未知条目数（观测用；个别条目失败会进 warnings 而非计数）。 */
  financialCount?: number;
  unknownCount?: number;
  /** 方案已建成、但后续财务 / 未知条目个别未落成的诚实告警（不伪报整笔失败）。 */
  warnings?: string[];
  /** 原样回显客户端带来的发布阻塞项，供 UI 提醒「还差这些才能发布」。 */
  publishBlockers?: string[];
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

function toFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * 把一份沙盘产业方案草案落库为 **DRAFT** `Solution`（+ 财务 + 关键未知）。
 * 全程委托 `solution-admin` 已测函数；**绝不自动发布**（发布由人在后台经 publishGuard 决定）。
 */
export async function persistSandboxSolutionDraft(
  input: unknown,
  actor?: string,
): Promise<SandboxSolutionPersistResult> {
  const parsed = SandboxSolutionPersistSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid", fieldErrors: toFieldErrors(parsed.error) };
  }
  const d = parsed.data;
  const publishBlockers = d.publishBlockers;

  // 1) 建方案（createSolution 内部：校验 SolutionCreateSchema + caseId 外键预检 + 强制 DRAFT + CREATE 审计）。
  const created = await createSolution(
    {
      title: d.title,
      slug: d.slug,
      caseId: d.caseId,
      summary: d.summary,
      body: d.body,
      price: d.price,
      currency: d.currency,
      riskDomains: d.riskDomains,
      needsProfessionalReview: d.needsProfessionalReview ?? true,
    },
    actor,
  );
  if (created.status !== "ok" || !created.solutionId) {
    // 透传 invalid / not_found / blocked / error（含 fieldErrors，如 caseId 不存在 / slug 冲突 / price 非法）。
    return {
      status: created.status,
      fieldErrors: created.fieldErrors,
      error: created.error,
      ...(publishBlockers ? { publishBlockers } : {}),
    };
  }
  const solutionId = created.solutionId;

  // 2) 追加财务条目（各条独立事务；个别失败记 warnings，不让整笔伪失败——方案仍是合法 DRAFT）。
  const warnings: string[] = [];
  let financialCount = 0;
  for (const f of d.financials ?? []) {
    const r = await addSolutionFinancial(solutionId, f, actor);
    if (r.status === "ok") financialCount += 1;
    else warnings.push(`财务条目落库未成功（${r.error ?? r.status}）：可在方案后台手动补录。`);
  }

  // 3) 追加关键未知变量（addSolutionUnknown 内部自动同步 unknownVariableCount）。
  let unknownCount = 0;
  for (const u of d.unknowns ?? []) {
    const r = await addSolutionUnknown(solutionId, u, actor);
    if (r.status === "ok") unknownCount += 1;
    else warnings.push(`关键未知落库未成功（${r.error ?? r.status}）。`);
  }

  return {
    status: "ok",
    solutionId,
    financialCount,
    unknownCount,
    ...(warnings.length ? { warnings } : {}),
    ...(publishBlockers ? { publishBlockers } : {}),
  };
}
