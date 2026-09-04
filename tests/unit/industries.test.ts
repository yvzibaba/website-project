import { describe, it, expect } from "vitest";
import {
  INDUSTRIES,
  PUBLIC_CASE_STAGES,
  getIndustryBySlug,
  getIndustryByEnum,
  getIndustrySlug,
  isValidIndustrySlug,
} from "@/server/industries";
import { IndustrySchema, SlugSchema, type Industry } from "@/lib/validation";

/**
 * 行业数据层单元测试（纯函数与常量，不触库）。
 *
 * 重点守护两条不变量（宪法第 13 条版本化 / 第 5 条可验证）：
 *   1. INDUSTRIES 与 prisma Industry 枚举一一对应，且 slug 合法、唯一；
 *   2. slug ↔ enum 双向映射自洽，未知输入安全回落。
 * getIndustryCaseCounts() 触库，放 integration 测试。
 */

describe("INDUSTRIES 常量完整性", () => {
  it("恰好覆盖 7 个行业（六大 + OTHER），与 IndustrySchema 数量一致", () => {
    expect(INDUSTRIES).toHaveLength(7);
    expect(INDUSTRIES).toHaveLength(IndustrySchema.options.length);
  });

  it("每个枚举值都在 IndustrySchema 中，且无遗漏无重复", () => {
    const enums = INDUSTRIES.map((i) => i.enum);
    expect(new Set(enums).size).toBe(enums.length);
    expect([...enums].sort()).toEqual([...IndustrySchema.options].sort());
  });

  it("每个 slug 合法（SlugSchema）且唯一", () => {
    const slugs = INDUSTRIES.map((i) => i.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(SlugSchema.safeParse(slug).success).toBe(true);
    }
  });

  it("每个行业都有非空的中英文名、简介与图标", () => {
    for (const i of INDUSTRIES) {
      expect(i.name.trim().length).toBeGreaterThan(0);
      expect(i.nameEn.trim().length).toBeGreaterThan(0);
      expect(i.tagline.trim().length).toBeGreaterThan(0);
      expect(i.icon.length).toBeGreaterThan(0);
    }
  });

  it("OTHER 作为兜底排在最后", () => {
    expect(INDUSTRIES[INDUSTRIES.length - 1].enum).toBe("OTHER");
  });
});

describe("PUBLIC_CASE_STAGES", () => {
  it("只包含对外可见的漏斗阶段（DEEP_CASE 及以后）", () => {
    expect(PUBLIC_CASE_STAGES).toEqual([
      "DEEP_CASE",
      "KEY_SOLUTION",
      "PREMIUM_SOLUTION",
    ]);
  });

  it("不含内部流水线阶段 CANDIDATE / KEY_RESEARCH", () => {
    expect(PUBLIC_CASE_STAGES).not.toContain("CANDIDATE");
    expect(PUBLIC_CASE_STAGES).not.toContain("KEY_RESEARCH");
  });
});

describe("getIndustryBySlug", () => {
  it("合法 slug 返回对应行业", () => {
    expect(getIndustryBySlug("new-energy")?.enum).toBe("NEW_ENERGY");
    expect(getIndustryBySlug("agriculture-forestry-fishery")?.enum).toBe(
      "AGRICULTURE_FORESTRY_FISHERY",
    );
  });

  it("未知/非法 slug 返回 undefined", () => {
    expect(getIndustryBySlug("not-a-real-industry")).toBeUndefined();
    expect(getIndustryBySlug("NEW_ENERGY")).toBeUndefined(); // 枚举名不是 slug
    expect(getIndustryBySlug("")).toBeUndefined();
  });
});

describe("getIndustryByEnum", () => {
  it("每个枚举都能取回行业", () => {
    for (const value of IndustrySchema.options) {
      expect(getIndustryByEnum(value as Industry)).toBeDefined();
    }
  });
});

describe("getIndustrySlug", () => {
  it("枚举 → slug 与 INDUSTRIES 一致", () => {
    for (const i of INDUSTRIES) {
      expect(getIndustrySlug(i.enum)).toBe(i.slug);
    }
  });

  it("未知枚举回落 other（防御性，类型上不应发生）", () => {
    expect(getIndustrySlug("SOMETHING_ELSE" as Industry)).toBe("other");
  });
});

describe("isValidIndustrySlug", () => {
  it("对所有合法 slug 返回 true", () => {
    for (const i of INDUSTRIES) {
      expect(isValidIndustrySlug(i.slug)).toBe(true);
    }
  });

  it("对非法 slug 返回 false", () => {
    expect(isValidIndustrySlug("nope")).toBe(false);
    expect(isValidIndustrySlug("New-Energy")).toBe(false);
    expect(isValidIndustrySlug("")).toBe(false);
  });
});

describe("slug ↔ enum 双向自洽", () => {
  it("bySlug 与 byEnum 指向同一对象", () => {
    for (const i of INDUSTRIES) {
      expect(getIndustryBySlug(i.slug)).toBe(getIndustryByEnum(i.enum));
    }
  });
});
