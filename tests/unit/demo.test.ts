import { describe, it, expect } from "vitest";
import {
  DEMO_SOURCE_TYPE,
  DEMO_TITLE_PREFIX,
  isDemoEntity,
  caseDemoVisibility,
  solutionDemoVisibility,
} from "@/server/demo";

/**
 * DEMO 可见性 helper 单元测试（纯函数，不触库）。
 *
 * 守护宪法第 20 条的关键不变量：
 *   - 默认（includeDemo=false）必须排除 DEMO_FIXTURE，且**保留 sourceType=null 的真实案例**
 *     （Prisma `{ not }` 在 SQL 里会连 NULL 一起过滤，必须显式 OR null 兜底）；
 *   - includeDemo=true 时不加过滤。
 */

describe("DEMO 常量", () => {
  it("标记值稳定（seed / 数据层 / 测试三方共享）", () => {
    expect(DEMO_SOURCE_TYPE).toBe("DEMO_FIXTURE");
    expect(DEMO_TITLE_PREFIX).toBe("【DEMO】");
  });
});

describe("isDemoEntity", () => {
  it("sourceType === DEMO_FIXTURE 判为 demo", () => {
    expect(isDemoEntity({ sourceType: DEMO_SOURCE_TYPE })).toBe(true);
  });
  it("真实来源 / null / undefined 判为非 demo", () => {
    expect(isDemoEntity({ sourceType: "新闻" })).toBe(false);
    expect(isDemoEntity({ sourceType: null })).toBe(false);
    expect(isDemoEntity({})).toBe(false);
  });
});

describe("caseDemoVisibility", () => {
  it("includeDemo=true → 空过滤（不过滤任何行）", () => {
    expect(caseDemoVisibility(true)).toEqual({});
  });

  it("includeDemo=false → OR[null, not DEMO]，保留 null 真实案例", () => {
    const where = caseDemoVisibility(false);
    expect(where.OR).toBeDefined();
    expect(where.OR).toEqual([
      { sourceType: null },
      { sourceType: { not: DEMO_SOURCE_TYPE } },
    ]);
  });
});

describe("solutionDemoVisibility", () => {
  it("includeDemo=true → 空过滤", () => {
    expect(solutionDemoVisibility(true)).toEqual({});
  });

  it("includeDemo=false → 通过关联 case.sourceType 过滤", () => {
    const where = solutionDemoVisibility(false);
    expect(where.case).toBeDefined();
    expect((where.case as { OR: unknown[] }).OR).toEqual([
      { sourceType: null },
      { sourceType: { not: DEMO_SOURCE_TYPE } },
    ]);
  });
});
