import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserWrite, mutationResponse, readJsonSafe, errorResponse } from "@/server/api-guard";
import { hasEntitlement } from "@/server/feature-flags";
import { STAFF_ROLES } from "@/server/authz";
import { CuidSchema } from "@app/kernel/lib/validation";
import { readOneDecisionScenario } from "@app/kernel/server/decision-service";
import { buildSolutionDraftFromDecision, type DecisionEconColumns } from "@app/kernel/lib/decision-to-solution";
import { persistSolutionDraft } from "@app/kernel/server/solution-store";
import { logger } from "@app/kernel/lib/logger";
import type { DecisionReport, ScenarioInput } from "@app/kernel/engine/types";

/**
 * `/api/workbench/decision/scenarios/[id]/export` — 把 V2 决策报告**导出成 DRAFT 产业方案**（R7-A · 商业闭环最小加性桥）。
 *
 * 分层：登录 + CSRF → owner-or-staff 授权（复用 `readOneDecisionScenario`）→ 读已存快照（含同源 Decimal 派生列）
 *      → 纯函数映射（`buildSolutionDraftFromDecision`，零 engine 依赖、零重算）→ 已测 `persistSolutionDraft`
 *      落 DRAFT Solution（含 FK 预检 / 强制 DRAFT / 审计）。**不新造任何商业系统**。
 *
 * 铁律：
 *   - **失败态禁止导出**：`calcStatus !== "ok"` 或 `report == null` 一律拒（映射函数 `ok:false` 直译 400 + blockers），
 *     绝不给脏数据 / 未算通的情景编一份看起来能卖的商品。
 *   - **只搬运不重算**：本路由不 import `runCalculation`，不 import `buildDecisionReport`；所有数字来自
 *     `readDecisionScenario` 已投影的 `report` 与同源 Decimal 派生列。
 *   - **禁止自动发布 / 自动定价**：走 `persistSolutionDraft` 恒 DRAFT 落库；`publishBlockers` 只回显给人，
 *     发布仍由 staff 后台经 `publishGuard` 决定；价格由人在导出时指定（可空 → 阻塞项）。
 *   - **ownerId / creatorId 只从会话注入**，绝不接受客户端传入。
 *   - `caseId` 是必填非空外键——由人在导出时指定；缺失 → `persistSolutionDraft` 的 FK 预检诚实拦下
 *     （映射层也把它登记为 `publishBlockers`，UI 可提前提示）。
 *
 * 与 V1 `/api/workbench/solution` 的关系：**平行、加性、不共享写入路径**。V1 走客户端沙盘现算的
 * `sandboxSource` 指针；V2 走服务端已存的 `scenarioId`（决策项目的 ProjectScenario），二者落到同一批
 * 已测的 Solution/Financial/Unknown 表，接进同一批已测的 `publishGuard`/`Order`/`hasPaidEntitlement` 闭环。
 */
export const dynamic = "force-dynamic";

const log = logger.child({ module: "api/workbench/decision/scenarios/[id]/export" });

interface Ctx {
  params: Promise<{ id: string }>;
}

/** 客户端 body：caseId 必填（外键）、price 可选（十进制串、非负、≤6 位小数）、currency 可选。 */
const ExportBodySchema = z.object({
  caseId: CuidSchema,
  price: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, "价格必须是十进制数字（不含负号）")
    .optional(),
  currency: z.enum(["CNY", "USD"]).optional(),
});

export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireUserWrite(request);
  if (!guard.ok) return guard.response;

  if (!hasEntitlement("export")) {
    return errorResponse("FORBIDDEN", "导出产业方案暂未开放，请联系客服开通", 403);
  }

  const parsedJson = await readJsonSafe(request);
  if (!parsedJson.ok) return parsedJson.response;

  const bodyParse = ExportBodySchema.safeParse(parsedJson.data ?? {});
  if (!bodyParse.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of bodyParse.error.issues) {
      const key = issue.path.join(".") || "_";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return mutationResponse({ status: "invalid", fieldErrors });
  }
  const { caseId, price, currency } = bodyParse.data;

  const { id: scenarioId } = await params;

  // 授权 + 读取（readOneDecisionScenario 内部走 canAccessDecisionProject，越权在动库前即拒）。
  const read = await readOneDecisionScenario({ scenarioId, user: guard.user });
  if (read.status !== "ok") return mutationResponse(read);

  const scenario = read.scenario as {
    id: string;
    name: string;
    calcStatus: string;
    version: number;
    report: DecisionReport | null;
    scenarioInput: ScenarioInput | null;
    econ: DecisionEconColumns;
  } | undefined;
  if (!scenario) {
    return errorResponse("INTERNAL", "读取情景返回缺少 scenario 字段", 500);
  }

  const draft = buildSolutionDraftFromDecision({
    report: scenario.report,
    scenarioInput: scenario.scenarioInput ?? null,
    econ: scenario.econ,
    calcStatus: scenario.calcStatus,
    scenarioName: scenario.name,
    scenarioVersion: scenario.version,
    price,
    currency,
    caseId,
  });

  if (!draft.ok) {
    // 失败态 / 无报告：诚实回 400 + blockers，前端据此禁用/说明即可，绝不落库。
    return mutationResponse({
      status: "invalid",
      error: `${draft.error.reason}: ${draft.error.detail}`,
      fieldErrors: { calcStatus: [draft.error.detail] },
      publishBlockers: draft.publishBlockers,
    });
  }

  const persistInput = {
    caseId,
    title: draft.title,
    slug: draft.slug,
    summary: draft.summary,
    body: draft.body,
    riskDomains: draft.riskDomains,
    needsProfessionalReview: draft.needsProfessionalReview,
    price: draft.price,
    currency: draft.currency,
    financials: draft.financials,
    unknowns: draft.unknowns,
    publishBlockers: draft.publishBlockers,
    sandboxSource: { scenarioId: scenario.id },
  };

  const result = await persistSolutionDraft(persistInput, guard.actor, { creatorId: guard.user.id });
  if (result.status === "ok") {
    log.info("decision scenario exported as DRAFT solution", {
      userId: guard.user.id,
      scenarioId: scenario.id,
      solutionId: result.solutionId,
    });
    return mutationResponse({ ...result, isStaff: STAFF_ROLES.includes(guard.user.role) });
  }
  return mutationResponse(result);
}
