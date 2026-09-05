import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 单测 `upgradeSolutionFinancialProvenance`（R8.5 溯源升级写路径）——**只测编排：闸门裁决 → 是否落库 → 落库参数**，
 * 不触真库。
 *
 * 做法：保留 R8.4 里**真实的** `planProvenanceUpgrade`（升级判据是本模块要验证被「原样消费」的核心，
 * 断言必须走同一份闸门逻辑，故 `importOriginal` 不 mock 它），只把 `@/lib/prisma` 换成可编程的 vi.fn，
 * 并顶掉 logger 以免打日志。核心断言：
 *   - 判据不过（无链接 / 无置信度 / 越界）→ `blocked` 且 **update/changeLog 绝不被调用**（§20 拒不粉饰）；
 *   - 判据过 → 写 `sourceUrl` 列 + 叠加后的 `assumptions`（evidenceKind=FACT + 保留 solutionCalcRef/源值）
 *     + version increment + ChangeLog(UPDATE)；
 *   - 记录不存在 → `not_found`，无写。
 */

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

// vi.mock 工厂会被 hoist 到文件顶，工厂内不能引用后定义的 const——故用 vi.hoisted 造可编程 spy。
const { mockFindUnique, mockTxUpdate, mockTxChangeLogCreate } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockTxUpdate: vi.fn(),
  mockTxChangeLogCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    solutionFinancial: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        solutionFinancial: { update: (...a: unknown[]) => mockTxUpdate(...a) },
        changeLog: { create: (...a: unknown[]) => mockTxChangeLogCreate(...a) },
      }),
  },
  disconnectPrisma: async () => {},
}));

import {
  upgradeSolutionFinancialProvenance,
  SANDBOX_PROVENANCE_STORE_VERSION,
  ProvenanceUpgradeIntentSchema,
} from "@/server/sandbox-provenance-store";

const FINANCIAL_ID = "ckfin0v3n8p0000abcdef123456";
const SOLUTION_ID = "cksol1w4q9r1111zzzz9876543210";

/** 沙盘来源财务的存量行（含引擎搬运来的源值与溯源戳，全部 Decimal 列以补零串读回）。 */
function sandboxRow(over: Record<string, unknown> = {}) {
  return {
    id: FINANCIAL_ID,
    solutionId: SOLUTION_ID,
    sourceUrl: null,
    version: 1,
    roiPct: "400.3500",
    irrPct: "23.7553",
    paybackYears: "5.28",
    assumptions: {
      npv: 4277400,
      roiRatio: 4.0035,
      irrFraction: 0.237553,
      discountedPaybackYears: 5.28,
      simplePaybackYears: 3.1,
      breakEvenChargingPriceY1: 0.62,
      evidenceKind: "ASSUMPTION",
      methodology: "engine-v1",
      regionName: "山西",
      profileName: null,
      solutionCalcRef: "sandbox-solution@1.0.0",
      engineVersions: { params: "1.1.0", model: "1.0.0" },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue(sandboxRow());
  mockTxUpdate.mockResolvedValue({ id: FINANCIAL_ID });
  mockTxChangeLogCreate.mockResolvedValue({ id: "cl1" });
});

describe("sandbox-provenance-store · upgradeSolutionFinancialProvenance（R8.5 受门禁升级写路径，mock prisma + 真闸门）", () => {
  it("STORE_VERSION 是语义化版本串", () => {
    expect(SANDBOX_PROVENANCE_STORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("意图 schema 接受合法 {sourceUrl,confidence,note}（前置）", () => {
    expect(
      ProvenanceUpgradeIntentSchema.safeParse({ sourceUrl: "https://x.gov.cn/a", confidence: 82, note: "n" }).success,
    ).toBe(true);
  });

  it("financialId 非 cuid → not_found，且 findUnique 都不必查、无写", async () => {
    const res = await upgradeSolutionFinancialProvenance("not-a-cuid", {
      sourceUrl: "https://x.gov.cn/a",
      confidence: 82,
    });
    expect(res.status).toBe("not_found");
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockTxChangeLogCreate).not.toHaveBeenCalled();
  });

  it("记录不存在 → not_found，无写", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const res = await upgradeSolutionFinancialProvenance(FINANCIAL_ID, {
      sourceUrl: "https://x.gov.cn/a",
      confidence: 82,
    });
    expect(res.status).toBe("not_found");
    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockTxChangeLogCreate).not.toHaveBeenCalled();
  });

  it("缺来源链接 → blocked（透传闸门原因），update/changeLog 绝不被调用（§20 拒不粉饰）", async () => {
    const res = await upgradeSolutionFinancialProvenance(FINANCIAL_ID, { confidence: 82 });
    expect(res.status).toBe("blocked");
    expect(res.reason).toContain("来源链接");
    expect(res.solutionId).toBe(SOLUTION_ID);
    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockTxChangeLogCreate).not.toHaveBeenCalled();
  });

  it("非法/相对 URL 来源 → 仍被闸门拒（blocked），无写", async () => {
    const res = await upgradeSolutionFinancialProvenance(FINANCIAL_ID, {
      sourceUrl: "ftp://not-http/x",
      confidence: 82,
    });
    expect(res.status).toBe("blocked");
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it("缺置信度 → blocked（须数值型 0–100），无写", async () => {
    const res = await upgradeSolutionFinancialProvenance(FINANCIAL_ID, {
      sourceUrl: "https://x.gov.cn/a",
    });
    expect(res.status).toBe("blocked");
    expect(res.reason).toContain("置信度");
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it("置信度越界(>100) → blocked，无写", async () => {
    const res = await upgradeSolutionFinancialProvenance(FINANCIAL_ID, {
      sourceUrl: "https://x.gov.cn/a",
      confidence: 140,
    });
    expect(res.status).toBe("blocked");
    expect(res.reason).toContain("越界");
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it("合法来源 + 置信度 → ok：写 sourceUrl 列 + evidenceKind=FACT + version increment + ChangeLog(UPDATE)", async () => {
    const res = await upgradeSolutionFinancialProvenance(
      FINANCIAL_ID,
      { sourceUrl: "  https://nx.gov.cn/tariff  ", confidence: 82, note: "电网公示电价" },
      "human:reviewer",
    );
    expect(res.status).toBe("ok");
    expect(res.solutionId).toBe(SOLUTION_ID);
    expect(res.financialId).toBe(FINANCIAL_ID);
    expect(res.version).toBe(2);
    expect(res.evidenceKind).toBe("FACT");
    expect(res.upgradeRef).toContain("sandbox-solution-provenance@");

    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mockTxUpdate.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: FINANCIAL_ID });
    // 规范化：trim 后的来源写入列。
    expect(updateArg.data.sourceUrl).toBe("https://nx.gov.cn/tariff");
    expect(updateArg.data.version).toEqual({ increment: 1 });

    const written = updateArg.data.assumptions as Record<string, unknown>;
    expect(written.evidenceKind).toBe("FACT");
    expect(written.sourceUrl).toBe("https://nx.gov.cn/tariff");
    expect(written.confidence).toBe(82);
    // ★不破坏既有脊柱：沙盘来源戳与引擎源值必须原样保留（否则 R8.3 识别 / R8.4 复算会失效）。
    expect(written.solutionCalcRef).toBe("sandbox-solution@1.0.0");
    expect(written.roiRatio).toBe(4.0035);
    expect(written.irrFraction).toBe(0.237553);
    expect(written.discountedPaybackYears).toBe(5.28);
    // 升维戳自带痕迹。
    const stamp = written.provenanceUpgrade as Record<string, unknown>;
    expect(stamp.from).toBe("ASSUMPTION");
    expect(stamp.to).toBe("FACT");
    expect(stamp.upgradedBy).toBe("human:reviewer");
    expect(stamp.note).toBe("电网公示电价");

    // ChangeLog：entityType=Solution、entityId=solutionId、action=UPDATE、含 before/after。
    expect(mockTxChangeLogCreate).toHaveBeenCalledTimes(1);
    const cl = mockTxChangeLogCreate.mock.calls[0][0].data;
    expect(cl.entityType).toBe("Solution");
    expect(cl.entityId).toBe(SOLUTION_ID);
    expect(cl.action).toBe("UPDATE");
    expect(cl.changedBy).toBe("human:reviewer");
    expect(cl.before.financial.version).toBe(1);
    expect(cl.after.financial.evidenceKind).toBe("FACT");
  });

  it("落库抛 P2025 → not_found（并发删除的诚实回落）", async () => {
    const { Prisma } = await import("@prisma/client");
    mockTxUpdate.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "6" }));
    const res = await upgradeSolutionFinancialProvenance(FINANCIAL_ID, {
      sourceUrl: "https://x.gov.cn/a",
      confidence: 82,
    });
    expect(res.status).toBe("not_found");
  });

  it("落库抛未知错 → error（不裸抛，透传 message）", async () => {
    mockTxUpdate.mockRejectedValueOnce(new Error("boom"));
    const res = await upgradeSolutionFinancialProvenance(FINANCIAL_ID, {
      sourceUrl: "https://x.gov.cn/a",
      confidence: 82,
    });
    expect(res.status).toBe("error");
    expect(res.error).toContain("boom");
  });
});
