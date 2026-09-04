import { randomUUID } from "node:crypto";

/**
 * Request ID 工具集。
 *
 * 用途（宪法第 20 条 可追溯 / 总控第 31 节 成本控制）：
 *   - 每个入站请求分配唯一 id，贯穿日志/错误响应/AI 成本记录，便于事后定位。
 *   - 客户端可通过 x-request-id 头自带 id（例如重试时复用），服务端校验后采纳。
 *
 * 格式约定：
 *   - 标准：UUID v4（36 字符），跨服务无冲突。
 *   - 前缀：可选 `req_` 便于日志 grep（默认不加，保持与第三方网关兼容）。
 *
 * 安全（宪法第 21 条）：
 *   - 不接受客户端传入的任意字符串，必须通过 isValidRequestId 校验（长度 + 字符集），
 *     防止日志注入（CRLF）与超长 header 攻击。
 */

export const REQUEST_ID_HEADER = "x-request-id";

/** 合法 request-id 正则：字母数字 + 连字符，长度 8–64。 */
const VALID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function generateRequestId(): string {
  return randomUUID();
}

export function isValidRequestId(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  return VALID_PATTERN.test(value);
}

/**
 * 从入站 header 提取或生成 request-id。
 * 客户端传入的 id 必须通过校验，否则丢弃并新生成（防止伪造/注入）。
 */
export function extractOrGenerateRequestId(
  headerValue: string | null | undefined,
): { requestId: string; fromClient: boolean } {
  if (isValidRequestId(headerValue)) {
    return { requestId: headerValue as string, fromClient: true };
  }
  return { requestId: generateRequestId(), fromClient: false };
}

/**
 * 把 request-id 安全地写进日志上下文（去除 CRLF 等控制字符，双保险）。
 */
export function sanitizeForLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}
