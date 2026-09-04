/**
 * 后台 client 组件共用的「写请求」薄封装（Phase 13 M4）。
 *
 * 为什么抽这一层：M4 的编辑台有 5 个 client 组件都要 POST/PATCH/DELETE 到 `/api/admin/**`。
 * 门禁（CSRF + requireStaffWrite）与判别联合结果翻译全在 `api-guard` 一处（宪法第 16 条单一真源），
 * UI 侧只需「发请求 → 拿 ok/失败原因 → 如实回报」。与其每个组件抄一遍 fetch + json 解析 +
 * `error.details.fields` 提取（抄 5 遍必漂移），不如收敛成一个小函数。刻意保持极薄、零业务判断。
 *
 * 注：这是纯 TS 模块（非 React 组件），由 "use client" 组件 import 后随客户端 bundle 走。
 */

export interface MutateResult {
  /** HTTP 2xx 且响应体 `ok:true`。 */
  ok: boolean;
  status: number;
  /** 失败时后端回传的 message（若有）。 */
  message?: string;
  /** 校验/守卫失败时按字段归类的原因（`error.details.fields`）。 */
  fields?: Record<string, string[]>;
}

/** 把按字段归类的原因摊平成一句人类可读提示（用于「发布被拦：<原因>」这类回显）。 */
export function fieldHints(fields?: Record<string, string[]>): string[] {
  return fields ? Object.values(fields).flat().filter(Boolean) : [];
}

/**
 * 发一个写请求并归一化响应。body=undefined 表示无请求体（如 DELETE）。
 * 不抛异常：网络/解析失败一律归一为 `ok:false`，让调用方据 status 决定是否 `router.refresh()`。
 */
export async function mutateJson(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<MutateResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: { code?: string; message?: string; details?: { fields?: Record<string, string[]> } } }
      | null;
    if (res.ok && json?.ok) return { ok: true, status: res.status };
    return {
      ok: false,
      status: res.status,
      message: json?.error?.message ?? `请求失败（HTTP ${res.status}）`,
      fields: json?.error?.details?.fields,
    };
  } catch {
    return { ok: false, status: 0, message: "网络错误，请稍后重试" };
  }
}
