import { z } from "zod";

/**
 * 通用校验 schema 集（Zod v4）。
 *
 * 设计目标（宪法第 7 条 数据质量 / 总控第 12 节数据模型）：
 *   - 所有 API Route 入参必须先过 schema，禁止裸 trust req.body；
 *   - 分页/排序/ID 等横切关注点集中定义，避免每个路由各写一套；
 *   - 错误消息中文化（面向最终用户的提示直接可用）。
 *
 * 用法：
 *   const q = PaginationSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
 *   const id = CuidSchema.parse(params.id);
 */

/* ─────────────────────────── ID / 标识符 ─────────────────────────── */

/** Prisma cuid() 生成的 ID：c 开头 + 小写字母数字，长度通常 25。放宽到 20–32 兼容历史数据。 */
export const CuidSchema = z
  .string()
  .regex(/^c[a-z0-9]{19,31}$/, "ID 格式不正确");

/** UUID v4（用于 request-id、外部系统对接）。 */
export const UuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "UUID 格式不正确",
  );

/** 通用 slug（URL 友好标识）：小写字母数字连字符，1–128 字符。 */
export const SlugSchema = z
  .string()
  .min(1, "slug 不能为空")
  .max(128, "slug 过长")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug 只能包含小写字母、数字和连字符");

/* ─────────────────────────── 分页 / 排序 ─────────────────────────── */

/**
 * 分页参数 schema（从 query string 解析）。
 *
 * 约定：
 *   page  从 1 开始（用户友好），默认 1
 *   pageSize 默认 20，上限 100（防止一次拉爆数据库 / Serverless 内存）
 *
 * 输出额外计算 offset，便于 Prisma skip。
 */
export const PaginationSchema = z
  .object({
    page: z.coerce.number().int().min(1, "page 最小为 1").max(10_000).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1, "pageSize 最小为 1")
      .max(100, "pageSize 最大为 100")
      .default(20),
  })
  .transform((v) => ({
    page: v.page,
    pageSize: v.pageSize,
    offset: (v.page - 1) * v.pageSize,
    limit: v.pageSize,
  }));

export type Pagination = z.infer<typeof PaginationSchema>;
export type PaginationInput = z.input<typeof PaginationSchema>;

/** 排序方向。 */
export const SortOrderSchema = z.enum(["asc", "desc"]);
export type SortOrder = z.infer<typeof SortOrderSchema>;

/**
 * 构造排序 schema：限定可排序字段白名单（防止 SQL 注入 / 全字段排序拖垮索引）。
 *
 * 用法：
 *   const SortSchema = makeSortSchema(["createdAt", "score", "title"] as const);
 *   const s = SortSchema.parse({ sortBy: "score", sortOrder: "desc" });
 */
export function makeSortSchema<TFields extends readonly string[]>(
  fields: TFields,
  defaultField: TFields[number] = fields[0],
) {
  return z
    .object({
      sortBy: z.enum(fields as unknown as [string, ...string[]]).default(defaultField),
      sortOrder: SortOrderSchema.default("desc"),
    })
    .transform((v) => ({
      sortBy: v.sortBy as TFields[number],
      sortOrder: v.sortOrder,
      orderBy: { [v.sortBy]: v.sortOrder } as Record<TFields[number], SortOrder>,
    }));
}

/* ─────────────────────────── 搜索 ─────────────────────────── */

/**
 * 搜索关键词 schema（总控第 18 节搜索系统）。
 *
 * V1 用 ILIKE 模糊匹配即可，不引入全文索引/向量（宪法第 22 条 V1 不做）。
 * 限制：1–100 字符，去除首尾空白，过滤控制字符防日志注入。
 */
export const SearchQuerySchema = z
  .string()
  .trim()
  .min(1, "搜索关键词不能为空")
  .max(100, "搜索关键词过长")
  .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim())
  .pipe(z.string().min(1, "搜索关键词不能全是控制字符"));

/* ─────────────────────────── 业务枚举（与 prisma/schema.prisma 一一对应） ─────────────────────────── */

/**
 * ⚠️ 以下枚举值必须与 prisma/schema.prisma 中的 enum 保持同步。
 * 修改 schema 后须同步更新此处；Phase 5 计划引入生成脚本（prisma → zod）自动同步，
 * 在此之前靠单元测试 tests/unit/validation.test.ts 断言枚举成员数量与值来兜底。
 */

/** 六大行业 + OTHER（总控第 6 节首页体验「六大行业」）。 */
export const IndustrySchema = z.enum([
  "NEW_ENERGY",
  "INDUSTRIAL_MANUFACTURING",
  "TRANSPORTATION",
  "AGRICULTURE_FORESTRY_FISHERY",
  "EDUCATION_TRAINING",
  "REAL_ESTATE_CONSTRUCTION",
  "OTHER",
]);
export type Industry = z.infer<typeof IndustrySchema>;

/** 案例漏斗阶段：候选(60) → 重点研究(20) → 深度案例(10) → 重点方案(3) → 精品方案(1)（总控第 9 节）。 */
export const CaseStageSchema = z.enum([
  "CANDIDATE",
  "KEY_RESEARCH",
  "DEEP_CASE",
  "KEY_SOLUTION",
  "PREMIUM_SOLUTION",
]);
export type CaseStage = z.infer<typeof CaseStageSchema>;

/** 证据类型：严格区分 事实/假设/推断/预测（宪法第 7 条）。 */
export const EvidenceTypeSchema = z.enum([
  "FACT",
  "ASSUMPTION",
  "INFERENCE",
  "PREDICTION",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/** 总控 §11 证据等级（来源权威度）：与"类型"正交的第二条轴，v1 仅作元数据/标注，不进可信度打分。 */
export const EvidenceGradeSchema = z.enum(["S", "A", "B", "C", "D"]);
export type EvidenceGrade = z.infer<typeof EvidenceGradeSchema>;

/** 技术成熟度。 */
export const MaturitySchema = z.enum([
  "EMERGING",
  "DEVELOPING",
  "MATURE",
  "UNKNOWN",
]);
export type Maturity = z.infer<typeof MaturitySchema>;

/** 开源许可证类型（宪法第 11 条：UNKNOWN/GPL/AGPL/PROPRIETARY 默认转人工复核）。 */
export const LicenseTypeSchema = z.enum([
  "MIT",
  "APACHE_2_0",
  "BSD_2_CLAUSE",
  "BSD_3_CLAUSE",
  "MPL_2_0",
  "LGPL",
  "GPL",
  "AGPL",
  "PROPRIETARY",
  "UNKNOWN",
  "OTHER",
]);
export type LicenseType = z.infer<typeof LicenseTypeSchema>;

/** 许可证复核状态。 */
export const LicenseReviewStatusSchema = z.enum([
  "NOT_REVIEWED",
  "APPROVED",
  "NEEDS_HUMAN_REVIEW",
  "REJECTED",
]);
export type LicenseReviewStatus = z.infer<typeof LicenseReviewStatusSchema>;

/** 方案状态（V1 只做 草稿/人工审核中/已发布 三态，Bull-Bear-Judge-QA 是过程不是落库态）。 */
export const SolutionStatusSchema = z.enum([
  "DRAFT",
  "UNDER_HUMAN_REVIEW",
  "PUBLISHED",
]);
export type SolutionStatus = z.infer<typeof SolutionStatusSchema>;

/** 币种（V1 默认 CNY，USD 预留）。 */
export const CurrencySchema = z.enum(["CNY", "USD"]);
export type Currency = z.infer<typeof CurrencySchema>;

/** 买家类型。 */
export const BuyerTypeSchema = z.enum(["INDIVIDUAL", "ENTERPRISE"]);
export type BuyerType = z.infer<typeof BuyerTypeSchema>;

/** 订单状态。 */
export const OrderStatusSchema = z.enum([
  "PENDING",
  "PAID",
  "REFUNDED",
  "CANCELED",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** ChangeLog 操作类型（宪法第 13 条版本化）。 */
export const ChangeActionSchema = z.enum([
  "CREATE",
  "UPDATE",
  "DELETE",
  "ROLLBACK",
]);
export type ChangeAction = z.infer<typeof ChangeActionSchema>;

/** 用户角色（SECURITY §4 最小角色：普通用户 / 审核员 / 管理员）。 */
export const UserRoleSchema = z.enum(["USER", "REVIEWER", "ADMIN"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

/* ─────────────────────────── 认证（Phase 6 用户系统） ─────────────────────────── */

/**
 * 口令策略常量（集中一处，便于注册页提示与 schema 复用）。
 * 最小 8 位（业界通用基线）；最大 128 位（配合 password.ts 的 DoS 上限，前端更早拦截）。
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * 邮箱：先去首尾空白并转小写（邮箱本地部分大小写不敏感按惯例统一小写存储，避免同一邮箱多账号），
 * 再校验格式，长度上限 254（RFC 5321）。
 */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "邮箱过长")
  .pipe(z.email("邮箱格式不正确"));
export type Email = z.infer<typeof EmailSchema>;

/** 口令（注册用）：强制最小长度。 */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `密码至少 ${PASSWORD_MIN} 位`)
  .max(PASSWORD_MAX, `密码最多 ${PASSWORD_MAX} 位`);

/** 注册入参。name 可选（1–50 字），空串归一化为 undefined。 */
export const RegisterInputSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: z
    .string()
    .trim()
    .max(50, "昵称最多 50 字")
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});
export type RegisterInput = z.infer<typeof RegisterInputSchema>;

/**
 * 登录入参。口令只要求非空——不在登录处强制最小长度，
 * 以免通过"长度错误"泄露账号是否存在（登录失败一律同一提示）。
 */
export const LoginInputSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, "请输入密码").max(PASSWORD_MAX, "密码过长"),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

/* ─────────────────────────── 通用响应包装 ─────────────────────────── */

/**
 * 分页响应包装 schema（服务端构造 / 客户端校验都用得上）。
 *
 * 用法：
 *   const PaginatedCases = paginatedResponseSchema(CaseDtoSchema);
 */
export function paginatedResponseSchema<TItem extends z.ZodTypeAny>(itemSchema: TItem) {
  return z.object({
    data: z.array(itemSchema),
    pagination: z.object({
      page: z.number().int().min(1),
      pageSize: z.number().int().min(1),
      total: z.number().int().min(0),
      totalPages: z.number().int().min(0),
    }),
  });
}

/** 健康检查响应 schema（与 /api/health 路由保持同步）。 */
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  node: z.string(),
  uptime_sec: z.number(),
  db: z.object({
    ok: z.boolean(),
    latency_ms: z.number().nullable(),
    error: z.string().optional(),
  }),
  timestamp: z.string(),
  requestId: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
