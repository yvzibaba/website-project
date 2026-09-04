import { describe, it, expect, vi } from "vitest";

// solution-admin 在模块级 import 了 prisma（本纯函数路径并不触库），mock 掉避免无 DATABASE_URL 时构造客户端。
vi.mock("@/lib/prisma", () => ({ prisma: {}, disconnectPrisma: async () => {} }));

import { solutionPublishBlockers } from "@/server/solution-admin";

/**
 * 单元测试：发布就绪只读预览 `solutionPublishBlockers`（Phase 13 M6）。
 *
 * 它复用真实发布守卫 `publishGuard`，审核队列据此在**不写库、不改状态**的前提下就地显示"还差什么才能发布"。
 * 关键守护：预览口径必须与真实发布**完全一致**（同一函数），否则"队列说能发、点了却被拦"就是漂移。
 * 因此这里断言的是守卫的三条规则本身，而非另立一套逻辑。
 */

const dec = (s: string) => ({ toString: () => s });

describe("solutionPublishBlockers（发布就绪只读预览）", () => {
  it("已定价 + 无高风险领域 + 未勾确认 → 就绪（空数组）", () => {
    expect(
      solutionPublishBlockers({ price: dec("1999.00"), riskDomains: [], needsProfessionalReview: false }),
    ).toEqual([]);
  });

  it("未定价 → 命中「价格」缺口", () => {
    const b = solutionPublishBlockers({ price: null, riskDomains: [], needsProfessionalReview: false });
    expect(b).toHaveLength(1);
    expect(b[0]).toContain("价格");
  });

  it("涉及高风险领域但未勾选专业确认 → 命中缺口且点名领域数量", () => {
    const b = solutionPublishBlockers({
      price: dec("99.00"),
      riskDomains: ["法律", "环保"],
      needsProfessionalReview: false,
    });
    expect(b).toHaveLength(1);
    expect(b[0]).toContain("2 个高风险领域");
    expect(b[0]).toContain("法律");
    expect(b[0]).toContain("环保");
  });

  it("高风险领域已勾选专业确认 → 就绪", () => {
    expect(
      solutionPublishBlockers({
        price: dec("99.00"),
        riskDomains: ["法律", "环保"],
        needsProfessionalReview: true,
      }),
    ).toEqual([]);
  });

  it("既未定价又涉高风险未确认 → 两条缺口都列出", () => {
    const b = solutionPublishBlockers({
      price: null,
      riskDomains: ["金融"],
      needsProfessionalReview: false,
    });
    expect(b).toHaveLength(2);
    expect(b.join("；")).toContain("价格");
    expect(b.join("；")).toContain("高风险领域");
  });
});
