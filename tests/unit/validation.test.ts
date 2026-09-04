import { describe, it, expect } from "vitest";
import {
  CuidSchema,
  UuidSchema,
  SlugSchema,
  PaginationSchema,
  SortOrderSchema,
  makeSortSchema,
  SearchQuerySchema,
  IndustrySchema,
  CaseStageSchema,
  EvidenceTypeSchema,
  EvidenceGradeSchema,
  MaturitySchema,
  LicenseTypeSchema,
  LicenseReviewStatusSchema,
  SolutionStatusSchema,
  CurrencySchema,
  BuyerTypeSchema,
  OrderStatusSchema,
  ChangeActionSchema,
  UserRoleSchema,
  PASSWORD_MIN,
  PASSWORD_MAX,
  EmailSchema,
  PasswordSchema,
  RegisterInputSchema,
  LoginInputSchema,
  paginatedResponseSchema,
  HealthResponseSchema,
} from "@/lib/validation";
import { z } from "zod";

describe("validation — ID schemas", () => {
  it("accepts a Prisma-style cuid", () => {
    expect(CuidSchema.safeParse("ck9x7y2z00000xyzabc123de").success).toBe(true);
  });

  it("rejects malformed cuid", () => {
    expect(CuidSchema.safeParse("not-a-cuid").success).toBe(false);
    expect(CuidSchema.safeParse("").success).toBe(false);
    expect(CuidSchema.safeParse("x".repeat(40)).success).toBe(false);
  });

  it("accepts UUID v4 and rejects v1/nil", () => {
    expect(UuidSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
    expect(UuidSchema.safeParse("550e8400-e29b-11d4-a716-446655440000").success).toBe(false); // v1
    expect(UuidSchema.safeParse("00000000-0000-0000-0000-000000000000").success).toBe(false); // nil 非 v4
  });

  it("accepts url-safe slug and rejects bad ones", () => {
    expect(SlugSchema.safeParse("green-methanol-2026").success).toBe(true);
    expect(SlugSchema.safeParse("single").success).toBe(true);
    expect(SlugSchema.safeParse("-leading").success).toBe(false);
    expect(SlugSchema.safeParse("trailing-").success).toBe(false);
    expect(SlugSchema.safeParse("Upper").success).toBe(false);
    expect(SlugSchema.safeParse("with space").success).toBe(false);
  });
});

describe("validation — PaginationSchema", () => {
  it("applies defaults when input is empty", () => {
    const r = PaginationSchema.parse({});
    expect(r).toEqual({ page: 1, pageSize: 20, offset: 0, limit: 20 });
  });

  it("coerces string query params to numbers", () => {
    const r = PaginationSchema.parse({ page: "3", pageSize: "50" });
    expect(r).toEqual({ page: 3, pageSize: 50, offset: 100, limit: 50 });
  });

  it("computes offset correctly", () => {
    expect(PaginationSchema.parse({ page: 5, pageSize: 10 }).offset).toBe(40);
  });

  it("rejects page < 1", () => {
    expect(PaginationSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ page: -1 }).success).toBe(false);
  });

  it("rejects pageSize > 100 (防止一次拉爆数据库)", () => {
    expect(PaginationSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ pageSize: 100 }).success).toBe(true);
  });

  it("rejects non-integer values", () => {
    expect(PaginationSchema.safeParse({ page: 1.5 }).success).toBe(false);
  });
});

describe("validation — sorting", () => {
  it("SortOrderSchema only accepts asc/desc", () => {
    expect(SortOrderSchema.safeParse("asc").success).toBe(true);
    expect(SortOrderSchema.safeParse("desc").success).toBe(true);
    expect(SortOrderSchema.safeParse("ASC").success).toBe(false);
  });

  it("makeSortSchema whitelists fields and builds orderBy", () => {
    const Sort = makeSortSchema(["createdAt", "score", "title"] as const);
    const r = Sort.parse({ sortBy: "score", sortOrder: "asc" });
    expect(r.orderBy).toEqual({ score: "asc" });
  });

  it("makeSortSchema defaults to first field + desc", () => {
    const Sort = makeSortSchema(["createdAt", "score"] as const);
    const r = Sort.parse({});
    expect(r.sortBy).toBe("createdAt");
    expect(r.sortOrder).toBe("desc");
    expect(r.orderBy).toEqual({ createdAt: "desc" });
  });

  it("makeSortSchema rejects non-whitelisted field (SQL 注入防护)", () => {
    const Sort = makeSortSchema(["createdAt", "score"] as const);
    expect(Sort.safeParse({ sortBy: "password" }).success).toBe(false);
    expect(Sort.safeParse({ sortBy: "createdAt; DROP TABLE" }).success).toBe(false);
  });
});

describe("validation — SearchQuerySchema", () => {
  it("trims and accepts normal keywords", () => {
    expect(SearchQuerySchema.parse("  沼气 甲醇  ")).toBe("沼气 甲醇");
  });

  it("rejects empty / whitespace-only", () => {
    expect(SearchQuerySchema.safeParse("").success).toBe(false);
    expect(SearchQuerySchema.safeParse("   ").success).toBe(false);
  });

  it("rejects over-long input", () => {
    expect(SearchQuerySchema.safeParse("a".repeat(101)).success).toBe(false);
    expect(SearchQuerySchema.safeParse("a".repeat(100)).success).toBe(true);
  });

  it("strips control characters", () => {
    expect(SearchQuerySchema.parse("abc\u0000def")).toBe("abcdef");
  });
});

describe("validation — 业务枚举与 prisma/schema.prisma 同步", () => {
  it("Industry has 7 members (六大行业 + OTHER)", () => {
    expect(IndustrySchema.options).toHaveLength(7);
    expect(IndustrySchema.options).toContain("NEW_ENERGY");
    expect(IndustrySchema.options).toContain("OTHER");
  });

  it("CaseStage has 5 funnel stages", () => {
    expect(CaseStageSchema.options).toEqual([
      "CANDIDATE",
      "KEY_RESEARCH",
      "DEEP_CASE",
      "KEY_SOLUTION",
      "PREMIUM_SOLUTION",
    ]);
  });

  it("EvidenceType enforces 事实/假设/推断/预测 (宪法第 7 条)", () => {
    expect(EvidenceTypeSchema.options).toEqual([
      "FACT",
      "ASSUMPTION",
      "INFERENCE",
      "PREDICTION",
    ]);
  });

  it("EvidenceGrade 与 prisma 同步：总控 §11 来源权威度 S/A/B/C/D（5 级）", () => {
    expect(EvidenceGradeSchema.options).toEqual(["S", "A", "B", "C", "D"]);
    expect(EvidenceGradeSchema.options).toHaveLength(5);
  });

  it("Maturity has 4 levels", () => {
    expect(MaturitySchema.options).toHaveLength(4);
  });

  it("LicenseType has 11 members and flags risky ones", () => {
    expect(LicenseTypeSchema.options).toHaveLength(11);
    for (const risky of ["GPL", "AGPL", "PROPRIETARY", "UNKNOWN"]) {
      expect(LicenseTypeSchema.options).toContain(risky);
    }
  });

  it("LicenseReviewStatus has 4 states", () => {
    expect(LicenseReviewStatusSchema.options).toHaveLength(4);
    expect(LicenseReviewStatusSchema.options).toContain("NEEDS_HUMAN_REVIEW");
  });

  it("SolutionStatus is the 3-state V1 set (not the 7-state pipeline)", () => {
    expect(SolutionStatusSchema.options).toEqual([
      "DRAFT",
      "UNDER_HUMAN_REVIEW",
      "PUBLISHED",
    ]);
  });

  it("Currency defaults include CNY + USD", () => {
    expect(CurrencySchema.options).toEqual(["CNY", "USD"]);
  });

  it("BuyerType has individual + enterprise", () => {
    expect(BuyerTypeSchema.options).toEqual(["INDIVIDUAL", "ENTERPRISE"]);
  });

  it("OrderStatus has 4 states", () => {
    expect(OrderStatusSchema.options).toEqual([
      "PENDING",
      "PAID",
      "REFUNDED",
      "CANCELED",
    ]);
  });

  it("ChangeAction supports rollback (宪法第 13 条版本化)", () => {
    expect(ChangeActionSchema.options).toContain("ROLLBACK");
  });
});

describe("validation — 响应包装", () => {
  it("paginatedResponseSchema validates a well-formed payload", () => {
    const Item = z.object({ id: z.string(), title: z.string() });
    const Schema = paginatedResponseSchema(Item);
    const ok = Schema.safeParse({
      data: [{ id: "1", title: "案例 A" }],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    expect(ok.success).toBe(true);
  });

  it("paginatedResponseSchema rejects negative total", () => {
    const Item = z.object({ id: z.string() });
    const Schema = paginatedResponseSchema(Item);
    expect(
      Schema.safeParse({
        data: [],
        pagination: { page: 1, pageSize: 20, total: -1, totalPages: 0 },
      }).success,
    ).toBe(false);
  });

  it("HealthResponseSchema matches the /api/health payload shape", () => {
    const ok = HealthResponseSchema.safeParse({
      ok: true,
      service: "website-project",
      version: "0.4.2",
      node: "v24.17.0",
      uptime_sec: 12,
      db: { ok: true, latency_ms: 300 },
      timestamp: new Date().toISOString(),
      requestId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(ok.success).toBe(true);
  });

  it("HealthResponseSchema allows nullable latency and omits requestId", () => {
    const ok = HealthResponseSchema.safeParse({
      ok: false,
      service: "website-project",
      version: "0.4.2",
      node: "v24.17.0",
      uptime_sec: 1,
      db: { ok: false, latency_ms: null, error: "connect failed" },
      timestamp: new Date().toISOString(),
    });
    expect(ok.success).toBe(true);
  });
});

describe("validation — 认证 schemas (Phase 6)", () => {
  it("UserRoleSchema 与 prisma/schema.prisma 的 UserRole 枚举同步", () => {
    expect(UserRoleSchema.options).toEqual(["USER", "REVIEWER", "ADMIN"]);
    expect(UserRoleSchema.safeParse("SUPERUSER").success).toBe(false);
  });

  it("EmailSchema 去首尾空白并转小写（同邮箱归一，防多账号）", () => {
    expect(EmailSchema.parse("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(EmailSchema.parse("A@B.io")).toBe("a@b.io");
  });

  it("EmailSchema 拒绝非法邮箱与超长邮箱", () => {
    expect(EmailSchema.safeParse("not-an-email").success).toBe(false);
    expect(EmailSchema.safeParse("").success).toBe(false);
    expect(EmailSchema.safeParse(`${"a".repeat(250)}@b.com`).success).toBe(false);
    expect(EmailSchema.safeParse("ok@example.com").success).toBe(true);
  });

  it("PasswordSchema 强制最小 8 位、最多 128 位", () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(PASSWORD_MAX).toBe(128);
    expect(PasswordSchema.safeParse("a".repeat(7)).success).toBe(false);
    expect(PasswordSchema.safeParse("a".repeat(8)).success).toBe(true);
    expect(PasswordSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(PasswordSchema.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("RegisterInputSchema 空串 name 归一化为 undefined，非空保留", () => {
    const empty = RegisterInputSchema.parse({
      email: "u@e.com",
      password: "password123",
      name: "   ",
    });
    expect(empty.name).toBeUndefined();
    expect(empty.email).toBe("u@e.com");

    const named = RegisterInputSchema.parse({
      email: "u@e.com",
      password: "password123",
      name: " 小明 ",
    });
    expect(named.name).toBe("小明");
  });

  it("RegisterInputSchema 拒绝弱密码与非法邮箱", () => {
    expect(
      RegisterInputSchema.safeParse({ email: "u@e.com", password: "short" }).success,
    ).toBe(false);
    expect(
      RegisterInputSchema.safeParse({ email: "bad", password: "password123" }).success,
    ).toBe(false);
  });

  it("LoginInputSchema 口令只要求非空（不以长度泄露账号是否存在）", () => {
    // 登录处 min 1 而非 min 8：避免"密码太短"错误提示暴露账号是否存在
    expect(LoginInputSchema.safeParse({ email: "u@e.com", password: "x" }).success).toBe(
      true,
    );
    expect(
      LoginInputSchema.safeParse({ email: "u@e.com", password: "" }).success,
    ).toBe(false);
    expect(
      LoginInputSchema.safeParse({ email: "u@e.com", password: "a".repeat(129) })
        .success,
    ).toBe(false);
  });
});
