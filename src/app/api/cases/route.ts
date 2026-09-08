import { NextResponse } from "next/server";
import type { Industry } from "@prisma/client";
import { errorResponse } from "@/server/api-guard";
import { listPublicCases } from "@/server/cases";
import { getIndustryBySlug } from "@/server/industries";

/**
 * /api/cases — 公开只读案例列表（Phase 4 模块 A）。
 *
 * 供客户端组件（行业详情页真实案例预览等）在浏览器端拉取公开案例：
 *   - 恒 includeDemo=false：DEMO 只属于 /cases?demo=1 的开发验证，公开 API 绝不透出（宪法第 20 条）；
 *   - 只读 GET：无写面、不查会话、不入库；
 *   - industry 用 slug（kebab-case，与 URL 口径一致），非法 slug → 400；
 *   - limit 上限 12（预览场景够用，防批量拉取）。
 * DB 失败 → 500 + 统一错误体（客户端组件据此降级提示，与数据层"ok:false 不崩溃"策略衔接）。
 */
export const dynamic = "force-dynamic";

const MAX_LIMIT = 12;
const DEFAULT_LIMIT = 6;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const industrySlug = url.searchParams.get("industry");
  const q = url.searchParams.get("q")?.trim().slice(0, 100) || undefined;
  const limitRaw = Number(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT));
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  let industry: Industry | undefined;
  if (industrySlug) {
    const meta = getIndustryBySlug(industrySlug);
    if (!meta) {
      return errorResponse("VALIDATION_ERROR", `未知行业 slug：${industrySlug}`, 400);
    }
    industry = meta.enum;
  }

  const result = await listPublicCases({
    industry,
    q,
    includeDemo: false,
    sortBy: "discoveredAt",
    sortOrder: "desc",
    offset: 0,
    limit,
    page: 1,
    pageSize: limit,
  });

  if (!result.ok) {
    const isProd = process.env.NODE_ENV === "production";
    return errorResponse("INTERNAL_ERROR", isProd ? "案例查询暂不可用" : result.error ?? "案例查询失败", 500);
  }

  return NextResponse.json({
    ok: true,
    total: result.total,
    hasMore: result.hasNext,
    items: result.items.map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary,
      industrySlug: c.industrySlug,
      industryName: c.industryName,
      regionName: c.regionName,
      discoveredAt: c.discoveredAt,
      opportunityScore: c.opportunityScore,
      evidenceConfidence: c.evidenceConfidence,
      isDemo: c.isDemo,
    })),
  });
}
