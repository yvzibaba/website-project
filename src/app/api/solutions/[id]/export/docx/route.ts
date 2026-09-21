import { NextResponse } from "next/server";
import { prisma } from "@app/kernel/lib/prisma";
import { getCurrentUser, STAFF_ROLES } from "@/server/authz";
import { errorResponse } from "@/server/api-guard";
import { hasPaidEntitlement } from "@/server/orders";
import { hasEntitlement } from "@/server/feature-flags";
import { CuidSchema } from "@app/kernel/lib/validation";
import { parseSolutionBody } from "@app/kernel/server/solution-body";
import { readSolutionSourceFromFinancials } from "@app/kernel/lib/solution-source";
import { SCENARIO_SCHEMA_VERSION } from "@app/kernel/engine/types";
import { buildDecisionReportDocx, type ReportForDocx } from "@/server/decision-report-docx";

/**
 * `GET /api/solutions/[id]/export/docx` — 买家/后台对**已成交方案**的离线交付件下载入口（R7-B-4 后半）。
 *
 * ## 一句话
 * 登录 + 满足下面任一 → 从 `Solution.body.extras.decisionReport`（R7-A 落库的**全文快照**）纯投影成 DOCX：
 *   - staff（REVIEWER/ADMIN）：任何时候都可预览自己或他人的方案（后台交付前审阅）；
 *   - `creatorId === user.id`：自助导出的买家，可在自己 DRAFT→PUBLISHED 全程随时把报告拉下来；
 *   - 已发布 + 有权访问（免费 / 已 PAID `hasPaidEntitlement`）：真实买家在付款确认后拿到交付物。
 * 其他一律 403。**不重算**，只用已经落库的 report 全文快照。
 *
 * ## 为什么走 extras 而不是回查 ProjectScenario
 * 买家的 sandboxSource 指针指向的情景可能已随作者修改升版（version++）——那时"报告 = 已购版本"必须锁死
 * 在**下单时那一份**上。R7-A `body.decisionReport` 正是这个锁死快照：随 Solution 一起持久化、与订单/权限
 * 同生命周期、天然免疫后续情景漂移。scenarioId 只用来**尝试**取 ProjectScenario.version 定文件名的 `Vx`
 * 段（拿不到 → `vUnknown`，绝不臆造版本号）。
 *
 * ## 失败即拒（mandate §R7-B-1）
 * - `Solution.status !== "PUBLISHED"` 且访问者非 staff / 非 creator → 403：审核中/草稿不外发（发布门 R7-C
 *   的**读侧兜底**，即便 R7-C 的状态机门未到位，此处也不给买家拿到未过审内容）；
 * - 无 `body.extras.decisionReport` → 404：V1 手工建方案或早期草案不带全文快照，DOCX 生成**没有可信源**、
 *   绝不退回去用其他字段拼一份看起来差不多的东西；
 * - `hasEntitlement("export")` 关闭 → 403（软门，V1 恒开）。
 */

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: Ctx): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return errorResponse("UNAUTHENTICATED", "请先登录。", 401);

  if (!hasEntitlement("export")) {
    return errorResponse("FORBIDDEN", "当前账号未开启导出权限。", 403);
  }

  const { id: solutionId } = await params;
  const idParsed = CuidSchema.safeParse(solutionId);
  if (!idParsed.success) return errorResponse("NOT_FOUND", "找不到该方案。", 404);

  const solution = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      price: true,
      creatorId: true,
      version: true,
      body: true,
      financials: { select: { id: true, assumptions: true } },
    },
  });
  if (!solution) return errorResponse("NOT_FOUND", "找不到该方案。", 404);

  const isStaff = STAFF_ROLES.includes(user.role);
  const isCreator = Boolean(solution.creatorId) && solution.creatorId === user.id;
  const isFree = solution.price === null || solution.price.toNumber() === 0;
  const paid =
    solution.status === "PUBLISHED"
      ? isFree || (await hasPaidEntitlement(solution.id, { userId: user.id, email: user.email }))
      : false;

  if (!(isStaff || isCreator || paid)) {
    return errorResponse(
      "FORBIDDEN",
      solution.status !== "PUBLISHED"
        ? "方案尚未发布，暂不可下载交付文档。"
        : "本方案为付费交付物，请先完成购买并由后台确认收款后再下载。",
      403,
    );
  }

  const parsed = parseSolutionBody(solution.body);
  const decisionReportExtra = parsed.extras.find((e) => e.key === "decisionReport");
  if (!decisionReportExtra) {
    return errorResponse(
      "NOT_FOUND",
      "本方案不含 V2 决策报告全文快照（可能为 V1 手工方案或早期草案），DOCX 离线交付仅在 V2 导出方案上可用。",
      404,
    );
  }
  const report = decisionReportExtra.content as ReportForDocx | null;
  if (!report || !Array.isArray(report.sections) || !report.provenance) {
    return errorResponse("CONFLICT", "方案内嵌的决策报告快照不完整或已损坏，无法生成 DOCX。", 409);
  }

  // 尽力反查 sandboxSource → ProjectScenario，仅为拿 version 定文件名 Vx；拿不到不阻断、绝不臆造。
  const srcRef = readSolutionSourceFromFinancials(
    solution.financials as Array<{ assumptions?: unknown }>,
  );
  let scenarioVersion: number | null = null;
  let projectName: string | null = null;
  let scenarioName: string | null = null;
  if (srcRef?.scenarioId) {
    const scenario = await prisma.projectScenario.findUnique({
      where: { id: srcRef.scenarioId },
      select: { id: true, name: true, version: true, project: { select: { name: true } } },
    });
    if (scenario) {
      scenarioVersion = scenario.version;
      scenarioName = scenario.name;
      projectName = scenario.project?.name ?? null;
    }
  }

  const built = await buildDecisionReportDocx({
    report,
    projectName,
    scenarioName,
    scenarioVersion,
    scenarioSchemaVersion: SCENARIO_SCHEMA_VERSION,
    titleOverride: solution.title,
    extraMeta: [
      ["方案 ID / Solution ID", solution.id],
      ["方案版本 / Solution Version", String(solution.version)],
      ["方案状态 / Solution Status", solution.status],
    ],
  });

  return new NextResponse(Buffer.from(built.buffer), {
    status: 200,
    headers: {
      "content-type": DOCX_MIME,
      "content-disposition": contentDisposition(built.filename),
      "cache-control": "no-store",
      "x-report-generated-at": built.exportedAtIso,
    },
  });
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
