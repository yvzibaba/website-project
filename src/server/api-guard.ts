import { NextResponse } from "next/server";
import { requireRole, STAFF_ROLES, type SessionUser } from "@/server/authz";
import { logger } from "@/lib/logger";

/**
 * 后台「写」HTTP 端点的统一门禁 + 结果翻译（Phase 13 M1）。
 *
 * 为什么：Phase 7 M5 / Phase 8 M1 建好案例、方案的**数据层 CRUD**时，刻意都留了一句
 * 「不做鉴权、HTTP 写路由延 Phase 13」——因为没有可信门禁就上线公开写端点违反安全底线
 * （宪法优先级：安全/数据质量 > 功能数量）。Phase 6 M2 的 `requireRole` 原语 + 双层防御经验
 * 已就绪，这一层把「谁在写」这件事收敛到**一处**，让所有 /api/admin/** 写端点共用同一套：
 *   1) CSRF 同源校验（纵深防御；Auth.js 会话 cookie 已 SameSite=Lax，跨站 POST 本就不带 cookie，
 *      这里再显式挡一道 Origin/Referer，绝不裸信）；
 *   2) 角色门禁 `requireRole(STAFF_ROLES)`（REVIEWER/ADMIN 才可写，USER 与未登录分别 403/401）；
 *   3) 数据层返回的判别联合（ok/invalid/not_found/blocked/error）统一翻译成带正确状态码的 JSON。
 * 单一翻译点 = 所有端点口径一致、不漂移（宪法第 16 条）。
 *
 * 诚实边界：actor 由**服务端会话**注入（`human:<id>`），绝不接受客户端传入的 actor/role；
 * 本层仍不含限流/幂等（V1 延后，见 ROADMAP）。
 */

const log = logger.child({ module: "server/api-guard" });

/** 落库审计用的操作者标识（写进 ChangeLog.changedBy）。 */
export function actorOf(user: SessionUser): string {
  return `human:${user.id}`;
}

/**
 * 纯函数：给定 Origin/Referer 头与请求 host，判定是否同源。
 *   - 无头信息（非浏览器脚本/curl 同源调用）→ 允许（真正防线是会话 cookie 的 SameSite + 鉴权）；
 *   - 能解析则 host 必须精确相等；解析失败按不安全处理（拒绝）。
 * 拆成纯函数便于单测锁死边界（SECURITY：CSRF 判定禁止口算）。
 */
export function isSameOrigin(originHeader: string | null, reqHost: string): boolean {
  if (!originHeader) return true;
  try {
    return new URL(originHeader).host === reqHost;
  } catch {
    return false;
  }
}

type GuardResult =
  | { ok: true; user: SessionUser; actor: string }
  | { ok: false; response: NextResponse };

/**
 * 保护一个 mutating 端点：CSRF 同源 + staff 角色。通过返回 {ok,user,actor}，
 * 否则返回已构造好的 NextResponse（401 未登录 / 403 越权或跨站），调用方直接 return。
 */
export async function requireStaffWrite(request: Request): Promise<GuardResult> {
  // 1) CSRF：优先 Origin，退化到 Referer 的 origin。
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  let originForCheck = origin;
  if (!originForCheck && referer) {
    try {
      originForCheck = new URL(referer).origin;
    } catch {
      originForCheck = referer; // 交给 isSameOrigin 解析失败即拒
    }
  }
  const host = new URL(request.url).host;
  if (!isSameOrigin(originForCheck, host)) {
    log.warn("csrf origin rejected", { origin: originForCheck, host });
    return {
      ok: false,
      response: errorResponse("FORBIDDEN", "跨站请求被拒绝（CSRF 同源校验）", 403),
    };
  }

  // 2) 角色门禁（角色只从服务端 JWT 会话读，绝不信任客户端）。
  const authz = await requireRole(STAFF_ROLES);
  if (!authz.ok) {
    if (authz.reason === "unauthenticated") {
      return { ok: false, response: errorResponse("UNAUTHORIZED", "需要登录后台", 401) };
    }
    return {
      ok: false,
      response: errorResponse("FORBIDDEN", "需要审核员或管理员权限", 403, {
        required: authz.required,
      }),
    };
  }

  return { ok: true, user: authz.user, actor: actorOf(authz.user) };
}

/** 统一错误响应体（对齐 src/lib/errors.ts 的 {error:{code,message,details?}} 结构）。 */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

/**
 * 数据层判别联合的公共形状（CaseMutationResult / SolutionMutationResult 结构兼容）。
 * 刻意**不用** `[key:string]: unknown` 索引签名——interface 不携带隐式索引签名，
 * 会导致上面的具体结果类型不可赋值（TS2345）；这里显式列出两个数据层会透出的所有 id/派生字段。
 */
interface MutationLike {
  status: "ok" | "invalid" | "not_found" | "blocked" | "error";
  fieldErrors?: Record<string, string[]>;
  error?: string;
  caseId?: string;
  evidenceId?: string;
  solutionId?: string;
  financialId?: string;
  unknownId?: string;
  recompute?: string;
}

/**
 * 把数据层写入结果翻译成 HTTP 响应。唯一口径：
 *   ok→200 · invalid→400 VALIDATION_ERROR（details=fieldErrors）· not_found→404
 *   blocked→409 CONFLICT · error→500（生产屏蔽原始 message）。
 */
export function mutationResponse(result: MutationLike): NextResponse {
  switch (result.status) {
    case "ok": {
      const rest: Record<string, unknown> = { ...result };
      delete rest.status; // 状态已隐含在 200 + ok:true，透出时剔除，保留 caseId/recompute 等派生字段
      return NextResponse.json({ ok: true, ...rest });
    }
    case "invalid":
      return errorResponse("VALIDATION_ERROR", "入参校验未通过", 400, {
        fields: result.fieldErrors ?? {},
      });
    case "not_found":
      return errorResponse("NOT_FOUND", "目标记录不存在", 404);
    case "blocked":
      return errorResponse("CONFLICT", "操作被守卫拒绝", 409, {
        fields: result.fieldErrors ?? {},
      });
    case "error": {
      const isProd = process.env.NODE_ENV === "production";
      return errorResponse("INTERNAL_ERROR", isProd ? "服务器内部错误" : result.error ?? "写入失败", 500);
    }
    default:
      return errorResponse("INTERNAL_ERROR", "未知结果状态", 500);
  }
}

/** 解析请求 JSON body；空体返回 {}，非法 JSON 抛错由调用方 catch 成 400。 */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text || text.length === 0) return {};
  return JSON.parse(text);
}

/** 便捷：包一层 try/catch，把 readJson 的 JSON.parse 抛错转成 400。 */
export async function readJsonSafe(request: Request): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, data: await readJson(request) };
  } catch {
    return { ok: false, response: errorResponse("VALIDATION_ERROR", "请求体不是合法 JSON", 400) };
  }
}
