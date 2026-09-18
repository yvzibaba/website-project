import {
  randomBytes,
  scrypt as _scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * 密码哈希（Phase 6 用户系统，server-only：依赖 node:crypto，只在服务端导入）。
 *
 * 选型理由（宪法第 2/4 条：冲突时选更简单、更少依赖的方案）：
 *   用 Node 内置 `node:crypto` 的 scrypt 而非 bcrypt/argon2 第三方包——零额外依赖、
 *   无需本机原生编译（Windows 环境友好）、scrypt 是内存困难型 KDF，抗 GPU 暴破，
 *   是 OWASP 认可的口令哈希算法之一。绝不存明文（SECURITY §1 / 宪法第 11 条）。
 *
 * 存储格式（自描述，便于将来无痛升级参数或算法）：
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 * 例如：scrypt$16384$8$1$<22 chars>$<88 chars>
 *
 * 校验用 `timingSafeEqual` 做定长时间比较，避免时序侧信道。
 */

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** scrypt 参数（OWASP 建议基线：N=2^14, r=8, p=1）。集中一处便于将来统一上调。 */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
/** 派生密钥长度（字节）。64 字节 = 512 位。 */
export const KEYLEN = 64;
/** 盐长度（字节）。16 字节 = 128 位随机盐。 */
const SALT_BYTES = 16;
/** 口令最大字节数上限，防止超长输入造成 scrypt 内存/CPU DoS。 */
export const MAX_PASSWORD_BYTES = 1024;

const ALGO = "scrypt";

/** hashPassword 的失败结果（输入过长等），用可辨识联合而非抛异常，便于调用方转成表单错误。 */
export type HashResult =
  | { ok: true; hash: string }
  | { ok: false; reason: "too_long" };

/**
 * 生成口令哈希串。
 * @param password 明文口令（调用方应已做长度/复杂度校验；此处再兜底防 DoS）。
 */
export async function hashPassword(password: string): Promise<HashResult> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return { ok: false, reason: "too_long" };
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEYLEN, { ...SCRYPT_PARAMS });
  const encoded = [
    ALGO,
    String(SCRYPT_PARAMS.N),
    String(SCRYPT_PARAMS.r),
    String(SCRYPT_PARAMS.p),
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
  return { ok: true, hash: encoded };
}

/**
 * 校验明文口令是否匹配已存哈希串。
 * 对格式非法、算法不符、长度不一致、口令超长一律返回 false（不抛异常，避免用户枚举/崩溃）。
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== "string") return false;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;

  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [algo, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (algo !== ALGO) return false;

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  if (N <= 0 || r <= 0 || p <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
