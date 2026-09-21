import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/authz";
import { errorResponse } from "@/server/api-guard";
import { hasEntitlement } from "@/server/feature-flags";
import { readOneDecisionScenario } from "@app/kernel/server/decision-service";
import { SCENARIO_SCHEMA_VERSION } from "@app/kernel/engine/types";
import type { DecisionReport } from "@app/kernel/engine/types";
import { buildDecisionReportDocx } from "@/server/decision-report-docx";

/**
 * `GET /api/workbench/decision/scenarios/[id]/export/docx` — V2 决策报告的**离线交付**入口（R7-B-4 前半）。
 *
 * ## 一句话
 * 已登录 + owner-or-staff（复用 `readOneDecisionScenario` 的 `canAccessDecisionProject`）→ 读**已冻结**
 * 的 `report`（引擎产出、经黄金回归与 provenance 校验后落库）→ `buildDecisionReportDocx` **纯投影**成
 * DOCX → 带 `Content-Disposition: attachment` 回浏览器。零重算、零改报、零改数据库。
 *
 * ## 与 R7-A 导出方案的关系（不重复、不冲突）
 * R7-A `/export`（POST）把同一份 report 映射成 **DRAFT Solution**（商品入口，走发布→下单→交付闭环）；
 * R7-B 本 `/export/docx`（GET）把同一份 report 直接输出成 **DOCX 附件**（离线交付工件）。两者数字**同源**
 * （同一 ProjectScenario.report 快照）——「网页报告 = DOCX 数字全一致」是结构性事实，非巧合。
 *
 * ## 失败即拒（mandate §R7-B-1「不重算不修饰」）
 * `calcStatus !== "ok"` 或 report 缺失（tech_error / 未算通）→ 409 + 诚实说明；绝不给脏/未算情景
 * 编一份看起来能交付的 DOCX。`hasEntitlement("export")` 关闭 → 403（软门，V1 恒开）。
 *
 * ## 安全（mandate §R7-B-6）
 * - 未登录：401；
 * - 越权读别人项目：`readOneDecisionScenario` 走 `canAccessDecisionProject` 返回 `forbidden` → 403；
 * - 项目/情景不存在：→ 404；
 * - GET 是安全方法，**不做 CSRF**（Auth.js 会话 cookie SameSite=Lax 已挡跨站 POST，GET 无写副作用）。
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

  const { id: scenarioId } = await params;
  const read = await readOneDecisionScenario({ scenarioId, user });
  if (read.status === "not_found") return errorResponse("NOT_FOUND", "找不到该情景。", 404);
  if (read.status === "forbidden") return errorResponse("FORBIDDEN", "无权访问该情景。", 403);
  if (read.status !== "ok") return errorResponse("BAD_REQUEST", "读取情景失败。", 400);

  const scenario = read.scenario as unknown as {
    id: string;
    name: string;
    calcStatus: string;
    version: number | null;
    report: DecisionReport | null;
  };
  const project = read.project as unknown as { name?: string | null } | null;

  if (scenario.calcStatus !== "ok" || !scenario.report) {
    return errorResponse(
      "CONFLICT",
      "本情景尚未算通或缺少冻结报告，DOCX 无法在不重算的前提下生成——请先在工作台完成一次成功计算。",
      409,
    );
  }

  const built = await buildDecisionReportDocx({
    report: scenario.report,
    projectName: project?.name ?? null,
    scenarioName: scenario.name,
    scenarioVersion: scenario.version,
    scenarioSchemaVersion: SCENARIO_SCHEMA_VERSION,
    extraMeta: [["情景记录 ID / DB Scenario ID", scenario.id]],
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

/** RFC 5987 `filename*` 以 UTF-8 编码，保证中文项目名跨浏览器不糊。ASCII 回落用同名字去特殊字符。 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
