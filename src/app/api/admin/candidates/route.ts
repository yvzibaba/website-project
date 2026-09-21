import { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse, readJsonSafe, errorResponse } from "@/server/api-guard";
import { requireRole, STAFF_ROLES } from "@/server/authz";
import {
  createCandidate,
  listCandidates,
  CANDIDATE_STORE_VERSION,
  type CandidateStoreResult,
  type CandidateRow,
  type CreateCandidateInput,
  type ListCandidatesQuery,
} from "@app/kernel/server/candidate-store";

/**
 * /api/admin/candidates —— R8「上游产业项目池」写读边界（mandate §八–§十一）。
 *
 * 双层门禁：layout 已挡 UI，本 route 再自鉴权（POST 走 `requireStaffWrite` = CSRF + REVIEWER/ADMIN；
 *   GET 走 `requireRole(STAFF_ROLES)` 只门禁读，不要求 CSRF）。越权 403、未登录 401（不泄露"存在此资源"）。
 *   表未 apply（P2021）时把 store 的 `tableMissing` **显式映射成 409 CONFLICT**（不是 500）：
 *   既诚实（"当前无法写入·表未迁移，属生产部署·创始人域"）又不假装成功。
 *
 * 版本回显（`storeVersion`）：让前端能一眼看出「这是哪一版裁决口径」，规则 13 版本可追溯。
 */
export const dynamic = "force-dynamic";

/**
 * 把 store 的判别联合结果 `{ok:true;data} | {ok:false;...}` 翻译成 api-guard 认得的
 *   LooseMutationLike `{status, ...}`。避免为了复用 HTTP 状态映射层而改动已测死的 store 结果形状
 *   （单一真源在 store 里，路由只做形状适配，宪法 §16）。
 * tableMissing → blocked(409)：既非代码 bug 亦非用户输入错，而是"当前生产尚未 apply 迁移"。
 */
function toLoose(res: CandidateStoreResult<CandidateRow | CandidateRow[]>) {
  if (res.ok) return { status: "ok" as const, candidate: res.data, storeVersion: CANDIDATE_STORE_VERSION };
  if ("invalid" in res && res.invalid) return { status: "invalid" as const, fieldErrors: res.fieldErrors };
  if ("tableMissing" in res && res.tableMissing)
    return {
      status: "blocked" as const,
      fieldErrors: { _: [res.error, "CandidateProject 表尚未迁移，属生产部署·创始人域"] },
    };
  if ("notFound" in res && res.notFound) return { status: "not_found" as const };
  const msg = "error" in res ? res.error : "未知错误";
  return { status: "error" as const, error: msg };
}

/** GET /api/admin/candidates?status=&industry=&region=&limit= —— 列表（staff 只门禁）。 */
export async function GET(request: Request): Promise<NextResponse> {
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) {
    if (authz.reason === "unauthenticated")
      return errorResponse("UNAUTHORIZED", "请先登录", 401);
    return errorResponse("FORBIDDEN", "需 REVIEWER 或 ADMIN 角色", 403);
  }
  const url = new URL(request.url);
  const q: ListCandidatesQuery = {
    status: url.searchParams.get("status") ?? undefined,
    industry: url.searchParams.get("industry") ?? undefined,
    region: url.searchParams.get("region") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 50) || undefined,
  };
  const res = await listCandidates(q);
  if (!res.ok) {
    if ("tableMissing" in res && res.tableMissing) {
      return errorResponse("CONFLICT", res.error, 409, {
        fields: { _: [res.error, "CandidateProject 表尚未迁移，属生产部署·创始人域"] },
      });
    }
    const msg = "error" in res ? res.error : "读取失败";
    return errorResponse("INTERNAL_ERROR", msg, 500);
  }
  return NextResponse.json({ ok: true, candidates: res.data, storeVersion: CANDIDATE_STORE_VERSION });
}

/** POST /api/admin/candidates —— 新建草料 + 当场程序筛查落库（mandate §九：非 LLM 打分）。 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const body = await readJsonSafe(request);
  if (!body.ok) return body.response;
  const result = await createCandidate(body.data as CreateCandidateInput);
  return mutationResponse(toLoose(result));
}
