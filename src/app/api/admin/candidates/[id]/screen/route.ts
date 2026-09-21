import type { NextResponse } from "next/server";
import { requireStaffWrite, mutationResponse } from "@/server/api-guard";
import {
  screenAndSave,
  CANDIDATE_STORE_VERSION,
  type CandidateStoreResult,
  type CandidateRow,
} from "@app/kernel/server/candidate-store";

/**
 * POST /api/admin/candidates/[id]/screen —— 手动重跑筛查（后台草料编辑后刷新裁决 · mandate §九）。
 *
 * 刻意只**重跑纯函数 + 回写既有行的 screeningResult/status/version**，不新建、不删除、不改列。
 * 迁移未 apply → 409 明确「CandidateProject 表尚未迁移」（诚实，不 500）。
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function toLoose(res: CandidateStoreResult<CandidateRow>) {
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

export async function POST(request: Request, ctx: Ctx): Promise<NextResponse> {
  const guard = await requireStaffWrite(request);
  if (!guard.ok) return guard.response;
  const { id } = await ctx.params;
  const result = await screenAndSave(id);
  return mutationResponse(toLoose(result));
}
