import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * search.ts 单元测试（mock 掉案例/方案列表层，不连库）。
 *
 * 关注点：searchPublic 是否正确把 q/industry/includeDemo/limit 透传给两个列表函数、
 * 默认预览条数、ok 与 hits 的聚合逻辑，以及列表层抛错时的兜底降级。
 */

vi.mock("@/server/cases", () => ({ listPublicCases: vi.fn() }));
vi.mock("@/server/solutions", () => ({ listPublishedSolutions: vi.fn() }));

import { listPublicCases } from "@/server/cases";
import { listPublishedSolutions } from "@/server/solutions";
import { searchPublic, SEARCH_PREVIEW_LIMIT } from "@/server/search";

const mockCases = listPublicCases as unknown as ReturnType<typeof vi.fn>;
const mockSolutions = listPublishedSolutions as unknown as ReturnType<typeof vi.fn>;

function fakeListResult(n: number, ok = true) {
  return {
    ok,
    items: Array.from({ length: n }, (_, i) => ({ id: `x${i}` })),
    total: n,
    page: 1,
    pageSize: SEARCH_PREVIEW_LIMIT,
    hasPrev: false,
    hasNext: false,
    ...(ok ? {} : { error: "db down" }),
  };
}

beforeEach(() => {
  mockCases.mockReset();
  mockSolutions.mockReset();
});

describe("searchPublic", () => {
  it("默认用 SEARCH_PREVIEW_LIMIT 作为两类结果的 limit/pageSize", async () => {
    mockCases.mockResolvedValue(fakeListResult(0));
    mockSolutions.mockResolvedValue(fakeListResult(0));

    await searchPublic({ q: "沼气", includeDemo: false });

    expect(mockCases).toHaveBeenCalledTimes(1);
    expect(mockSolutions).toHaveBeenCalledTimes(1);
    const caseArg = mockCases.mock.calls[0][0];
    expect(caseArg.limit).toBe(SEARCH_PREVIEW_LIMIT);
    expect(caseArg.pageSize).toBe(SEARCH_PREVIEW_LIMIT);
    expect(caseArg.offset).toBe(0);
    expect(caseArg.page).toBe(1);
  });

  it("把 q / industry / includeDemo 透传给两个列表函数", async () => {
    mockCases.mockResolvedValue(fakeListResult(0));
    mockSolutions.mockResolvedValue(fakeListResult(0));

    await searchPublic({ q: "储能", industry: "NEW_ENERGY", includeDemo: true, limit: 5 });

    const caseArg = mockCases.mock.calls[0][0];
    const solArg = mockSolutions.mock.calls[0][0];
    expect(caseArg.q).toBe("储能");
    expect(caseArg.industry).toBe("NEW_ENERGY");
    expect(caseArg.includeDemo).toBe(true);
    expect(caseArg.limit).toBe(5);
    expect(solArg.q).toBe("储能");
    expect(solArg.industry).toBe("NEW_ENERGY");
    expect(solArg.includeDemo).toBe(true);
    expect(solArg.limit).toBe(5);
  });

  it("聚合 ok（两者皆 ok 才 true）与 hits（两类条数之和）并回显 q", async () => {
    mockCases.mockResolvedValue(fakeListResult(3));
    mockSolutions.mockResolvedValue(fakeListResult(2));

    const res = await searchPublic({ q: "视觉质检", includeDemo: false });
    expect(res.ok).toBe(true);
    expect(res.hits).toBe(5);
    expect(res.q).toBe("视觉质检");
    expect(res.cases.items).toHaveLength(3);
    expect(res.solutions.items).toHaveLength(2);
  });

  it("任一列表 ok:false 时整体 ok:false", async () => {
    mockCases.mockResolvedValue(fakeListResult(0, false));
    mockSolutions.mockResolvedValue(fakeListResult(1));

    const res = await searchPublic({ q: "x", includeDemo: false });
    expect(res.ok).toBe(false);
  });

  it("列表层抛错时兜底降级为 ok:false、hits:0，不抛出", async () => {
    mockCases.mockRejectedValue(new Error("boom"));
    mockSolutions.mockResolvedValue(fakeListResult(1));

    const res = await searchPublic({ q: "x", includeDemo: false });
    expect(res.ok).toBe(false);
    expect(res.hits).toBe(0);
    expect(res.cases.items).toHaveLength(0);
    expect(res.solutions.items).toHaveLength(0);
  });
});
