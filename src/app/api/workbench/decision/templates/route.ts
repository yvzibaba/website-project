import type { NextResponse } from "next/server";
import { mutationResponse } from "@/server/api-guard";
import { buildDefaultInput, buildTemplateInput, listScenarioTemplates } from "@app/kernel/server/decision-service";

/**
 * `/api/workbench/decision/templates` —— 列出可用的**声明式情景模板**。
 *
 * 只回目录（id / 名称 / 组件集合 / 是否有序充电 / 一句话意图），
 * **不回任何算好的数字**——数字必须由服务端在计算/落库时现算，
 * 客户端拿到的模板只有"定义"，从结构上排除了"两层数字对不上"的可能。
 *
 * 可附带 `?fee=<元/kWh>` 以同时返回一份可直接提交的输入骨架：
 *   - `buildTemplateInput(templateId, fee)` 或 `buildDefaultInput(fee)`。
 *   之所以要求显式给服务费：它是市场调节价（官方明确由经营者自主定价），
 *   行业水平没有官方数值——给它默认值就等于把编造的市场价混进结论。
 *
 * 本端点为**只读**且不含项目数据，无需登录。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const templates = listScenarioTemplates();

  const feeRaw = url.searchParams.get("fee");
  if (feeRaw === null) {
    return mutationResponse({ status: "ok", templates });
  }

  const fee = Number(feeRaw);
  if (!Number.isFinite(fee) || fee < 0) {
    return mutationResponse({
      status: "invalid",
      fieldErrors: { fee: ["服务费必须是大于等于 0 的有限数字"] },
    });
  }

  const seedTemplateId = url.searchParams.get("templateId");
  const seeds: Record<string, unknown> = { default: buildDefaultInput(fee) };
  for (const t of templates) {
    const built = buildTemplateInput(t.id, fee);
    seeds[t.id] = built.ok ? built.input : null;
  }

  return mutationResponse({
    status: "ok",
    templates,
    seeds,
    seedTemplateId: seedTemplateId ?? "default",
  });
}
