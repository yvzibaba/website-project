import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 单测 `persistSandboxSolutionDraft`（R8.2 落库编排）——**只测编排的分派与失败诚实**，不触库。
 *
 * 做法：`importOriginal` 保留 solution-admin 里**真实的 Zod schema**（编排层的入参 schema 直接复用它，
 * 断言必须用同一份校验），只把三个副作用函数 `createSolution`/`addSolutionFinancial`/`addSolutionUnknown`
 * 换成可编排断言的 vi.fn。顶掉 prisma/logger 以免实例化客户端 / 打日志。
 */

vi.mock("@/lib/prisma", () => ({ prisma: {}, disconnectPrisma: async () => {} }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

vi.mock("@/server/solution-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/solution-admin")>();
  return {
    ...actual,
    createSolution: vi.fn(),
    addSolutionFinancial: vi.fn(),
    addSolutionUnknown: vi.fn(),
  };
});

import {
  createSolution,
  addSolutionFinancial,
  addSolutionUnknown,
} from "@/server/solution-admin";
import {
  persistSandboxSolutionDraft,
  SandboxSolutionPersistSchema,
  SANDBOX_SOLUTION_STORE_VERSION,
} from "@/server/sandbox-solution-store";

const mockCreate = vi.mocked(createSolution);
const mockFin = vi.mocked(addSolutionFinancial);
const mockUnk = vi.mocked(addSolutionUnknown);

// 合法 cuid（匹配 CuidSchema ^c[a-z0-9]{19,31}$）与 slug（^[a-z0-9]+(-[a-z0-9]+)*$）。
const CASE_ID = "ckx0v3n8p0000abcdef1234567";
const SOLUTION_ID = "cky1w4q9r1111zzzz9876543210";

function baseInput(over: Record<string, unknown> = {}) {
  return {
    caseId: CASE_ID,
    title: "大同港电重卡补能场站｜基准情景（山西）",
    slug: "sandbox-solution-a1b2",
    summary: "示例摘要：净 CAPEX 352.45 万、NPV 427.74 万。",
    body: { name: "t", roi: "ROI：400.35%", costModel: "净 CAPEX 352.45 万元" },
    riskDomains: ["投资", "能源", "政策"],
    needsProfessionalReview: true,
    price: "18000.00",
    currency: "CNY",
    financials: [{ capex: "3524500.00", revenueAnnual: "6400000.00", roiPct: "400.35", currency: "CNY" }],
    unknowns: [{ name: "全部技术与经济入参", impact: "占位假设", howToResolve: "接真实数据", severity: 90 }],
    publishBlockers: ["入参均为占位假设须核实", "尚未设定对外价格"],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ status: "ok", solutionId: SOLUTION_ID });
  mockFin.mockResolvedValue({ status: "ok", solutionId: SOLUTION_ID, financialId: "f1" });
  mockUnk.mockResolvedValue({ status: "ok", solutionId: SOLUTION_ID, unknownId: "u1" });
});

describe("sandbox-solution-store · persistSandboxSolutionDraft（R8.2 落库编排，mock solution-admin）", () => {
  it("STORE_VERSION 是语义化版本串", () => {
    expect(SANDBOX_SOLUTION_STORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("入参 schema 与 fixture 对齐（前置：fixture 必须能过自己的校验）", () => {
    expect(SandboxSolutionPersistSchema.safeParse(baseInput()).success).toBe(true);
  });

  it("成功：createSolution ok → 逐条转发 financials/unknowns，回 solutionId + 计数 + 原样 publishBlockers", async () => {
    const res = await persistSandboxSolutionDraft(baseInput(), "human:tester");
    expect(res.status).toBe("ok");
    expect(res.solutionId).toBe(SOLUTION_ID);
    expect(res.financialCount).toBe(1);
    expect(res.unknownCount).toBe(1);
    expect(res.warnings).toBeUndefined();
    expect(res.publishBlockers).toEqual(["入参均为占位假设须核实", "尚未设定对外价格"]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // 断言只搬运不重算：title/slug/caseId/price/needsProfessionalReview 原样透传给 createSolution。
    const [createArg, actorArg] = mockCreate.mock.calls[0];
    expect(actorArg).toBe("human:tester");
    expect(createArg).toMatchObject({
      title: baseInput().title,
      slug: "sandbox-solution-a1b2",
      caseId: CASE_ID,
      price: "18000.00",
      needsProfessionalReview: true,
    });
    expect(mockFin).toHaveBeenCalledTimes(1);
    expect(mockUnk).toHaveBeenCalledTimes(1);
    // financial/unknown 挂在**新建方案 id**上、actor 透传。
    expect(mockFin.mock.calls[0][0]).toBe(SOLUTION_ID);
    expect(mockUnk.mock.calls[0][0]).toBe(SOLUTION_ID);
  });

  it("needsProfessionalReview 缺省时编排层兜底为 true（§21 高风险须人工确认，宁保守）", async () => {
    const { needsProfessionalReview: _drop, ...rest } = baseInput();
    void _drop;
    await persistSandboxSolutionDraft(rest, "human:tester");
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ needsProfessionalReview: true });
  });

  it("入参非法（caseId 非 cuid）→ status invalid + fieldErrors.caseId，createSolution 绝不被调用", async () => {
    const res = await persistSandboxSolutionDraft(baseInput({ caseId: "not-a-cuid" }), "human:tester");
    expect(res.status).toBe("invalid");
    expect(res.fieldErrors?.caseId?.length).toBeGreaterThan(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFin).not.toHaveBeenCalled();
  });

  it("负价格被编排层 schema 拒（Decimal 禁负号）→ invalid.price，且不落 createSolution", async () => {
    const res = await persistSandboxSolutionDraft(baseInput({ price: "-1.00" }), "human:tester");
    expect(res.status).toBe("invalid");
    expect(res.fieldErrors?.price?.length).toBeGreaterThan(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("createSolution 回 invalid（如案例不存在）→ 整笔中止透传，financial/unknown 绝不被调用", async () => {
    mockCreate.mockResolvedValue({ status: "invalid", fieldErrors: { caseId: ["引用的案例不存在"] } });
    const res = await persistSandboxSolutionDraft(baseInput(), "human:tester");
    expect(res.status).toBe("invalid");
    expect(res.fieldErrors).toEqual({ caseId: ["引用的案例不存在"] });
    expect(res.solutionId).toBeUndefined();
    expect(mockFin).not.toHaveBeenCalled();
    expect(mockUnk).not.toHaveBeenCalled();
    // 阻塞清单在建方案失败时仍透传（让 UI 知道「还差什么」）。
    expect(res.publishBlockers?.length).toBeGreaterThan(0);
  });

  it("financial 个别失败 → 方案仍 ok，失败进 warnings、不计入 financialCount（不伪报整笔失败）", async () => {
    mockFin
      .mockResolvedValueOnce({ status: "ok", solutionId: SOLUTION_ID, financialId: "f1" })
      .mockResolvedValueOnce({ status: "error", error: "boom" });
    const res = await persistSandboxSolutionDraft(
      baseInput({ financials: [{ capex: "1.00" }, { capex: "2.00" }] }),
      "human:tester",
    );
    expect(res.status).toBe("ok");
    expect(res.financialCount).toBe(1);
    expect(res.warnings?.some((w) => w.includes("财务条目"))).toBe(true);
    expect(mockFin).toHaveBeenCalledTimes(2);
  });

  it("unknown 个别失败 → 同样记 warnings、unknownCount 只数成功；financials/unknowns 皆空则不建条目", async () => {
    mockUnk.mockResolvedValueOnce({ status: "ok", solutionId: SOLUTION_ID, unknownId: "u1" }).mockResolvedValueOnce({ status: "not_found" });
    const resA = await persistSandboxSolutionDraft(
      baseInput({ unknowns: [{ name: "a" }, { name: "b" }] }),
      "human:tester",
    );
    expect(resA.unknownCount).toBe(1);
    expect(resA.warnings?.some((w) => w.includes("关键未知"))).toBe(true);

    mockFin.mockClear();
    mockUnk.mockClear();
    const resB = await persistSandboxSolutionDraft(baseInput({ financials: [], unknowns: [] }), "human:tester");
    expect(resB.status).toBe("ok");
    expect(resB.financialCount).toBe(0);
    expect(resB.unknownCount).toBe(0);
    expect(mockFin).not.toHaveBeenCalled();
    expect(mockUnk).not.toHaveBeenCalled();
  });
});
