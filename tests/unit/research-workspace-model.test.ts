import { describe, it, expect } from "vitest";
import {
  buildQuery,
  pageHref,
  sortHref,
  isSortedBy,
  paginationInfo,
} from "@/server/research-workspace-model";

/**
 * R8 · Research Workspace 视图纯函数单测（Next16 无 jsdom → 把可证逻辑从组件剥出来钉死）。
 * 覆盖：查询串拼装 / 分页链接 / 排序方向翻转 / 页码窗口算术。全部零依赖、无 DOM。
 */

describe("buildQuery", () => {
  it("base 空值被跳过；override 合并进串", () => {
    const q = buildQuery({ verdict: "CANDIDATE", region: "" }, { page: 2 });
    expect(q).toBe("verdict=CANDIDATE&page=2");
  });

  it("override 给空串/undefined → 删除该键（可清空筛选）", () => {
    const q = buildQuery({ verdict: "CANDIDATE", industry: "NEW_ENERGY" }, { verdict: "" });
    expect(q).toBe("industry=NEW_ENERGY");
  });

  it("数字转字符串", () => {
    expect(buildQuery({}, { pageSize: 50 })).toBe("pageSize=50");
  });
});

describe("pageHref", () => {
  it("带筛选翻到第 3 页 → /admin/research?...&page=3", () => {
    const href = pageHref({ verdict: "CANDIDATE", pageSize: "20" }, 3);
    expect(href.startsWith("/admin/research?")).toBe(true);
    expect(href).toContain("page=3");
    expect(href).toContain("verdict=CANDIDATE");
  });

  it("无参数时回落裸路径", () => {
    expect(pageHref({}, 1)).toBe("/admin/research?page=1");
  });
});

describe("sortHref", () => {
  it("当前按 createdAt desc → 点 createdAt 翻转为 asc 且回到第 1 页", () => {
    const href = sortHref({ sortBy: "createdAt", sortDir: "desc", verdict: "CANDIDATE" }, "createdAt");
    expect(href).toContain("sortBy=createdAt");
    expect(href).toContain("sortDir=asc");
    expect(href).toContain("page=1");
    expect(href).toContain("verdict=CANDIDATE"); // 保留既有筛选
  });

  it("换到新字段 updatedAt → 以 desc 起步", () => {
    const href = sortHref({ sortBy: "createdAt", sortDir: "asc" }, "updatedAt");
    expect(href).toContain("sortBy=updatedAt");
    expect(href).toContain("sortDir=desc");
  });

  it("当前 asc 点同字段 → 回落 desc", () => {
    const href = sortHref({ sortBy: "updatedAt", sortDir: "asc" }, "updatedAt");
    expect(href).toContain("sortDir=desc");
  });
});

describe("isSortedBy", () => {
  it("未显式 sortBy 时默认列 createdAt 视为正按 desc 排", () => {
    expect(isSortedBy({}, "createdAt")).toBe("desc");
    expect(isSortedBy({}, "updatedAt")).toBeNull();
  });

  it("命中字段返回当前方向；不命中返回 null", () => {
    expect(isSortedBy({ sortBy: "updatedAt", sortDir: "asc" }, "updatedAt")).toBe("asc");
    expect(isSortedBy({ sortBy: "updatedAt" }, "createdAt")).toBeNull();
  });
});

describe("paginationInfo", () => {
  it("45 条 / 每页 10 → 5 页；第 2 页有前后", () => {
    const info = paginationInfo(45, 10, 2);
    expect(info.pageCount).toBe(5);
    expect(info.safePage).toBe(2);
    expect(info.hasPrev).toBe(true);
    expect(info.hasNext).toBe(true);
    expect(info.pages).toEqual([1, 2, 3, 4, 5]);
  });

  it("total=0 → pageCount 兜底 1，无前后", () => {
    const info = paginationInfo(0, 20, 1);
    expect(info.pageCount).toBe(1);
    expect(info.pages).toEqual([1]);
    expect(info.hasPrev).toBe(false);
    expect(info.hasNext).toBe(false);
  });

  it("页码越界被夹到 [1,pageCount]", () => {
    expect(paginationInfo(30, 10, 999).safePage).toBe(3);
    expect(paginationInfo(30, 10, -5).safePage).toBe(1);
  });

  it("窗口最多 span 个、居中当前页、贴边时平移不越界", () => {
    const mid = paginationInfo(100, 10, 5, 5); // 10 页，当前第 5
    expect(mid.pages).toEqual([3, 4, 5, 6, 7]);
    const edge = paginationInfo(100, 10, 10, 5); // 末页
    expect(edge.pages).toEqual([6, 7, 8, 9, 10]);
    const first = paginationInfo(100, 10, 1, 5); // 首页
    expect(first.pages).toEqual([1, 2, 3, 4, 5]);
  });

  it("pageSize<=0 不炸（兜底为 1）", () => {
    const info = paginationInfo(3, 0, 1);
    expect(info.pageCount).toBe(3);
  });
});
