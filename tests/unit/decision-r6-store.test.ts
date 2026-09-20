import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * R6 · M13 持久化层单测（**离线**：顶掉 prisma，绝不触库、绝不网络）。
 *
 * 守的是"偏差闭环落库"里一旦破就极隐蔽的四条契约（§16–§20/§34）：
 *   ① 冻结预测是只读投影：decisionSnapshotToColumns 里的 forecastSnapshot 来自**已算好的 calc**，
 *      不重算——同一 calc 两次投影逐字节稳定，且与黄金基线无关（黄金钉 runCalculation 输出，不钉这列）。
 *   ② 人工状态不可被机器抹平：upsertCalibrationCandidates 命中既有 dedupeKey 时，**只刷新分析字段**，
 *      status/reviewedBy/reviewNote/reviewedAt 一律不写回；新记录才给 status="CANDIDATE"。
 *   ③ 审核是状态机：reviewCalibrationCandidate 只允许既定迁移，ACCEPTED/REJECTED 为终态，
 *      把已定论记录回退成 CANDIDATE 一律拒（防止"结论"被悄悄改回"待办"）。
 *   ④ 读视图诚实降精度：Decimal→number；未评估/无值如实 null，绝不折 0。
 *
 * 本文件全程 mock prisma，不碰内核计算真源——改此处不触引擎、不动黄金。
 */

const h = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    projectScenario: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    calibrationCandidate: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock("@app/kernel/lib/prisma", () => ({ prisma: h.prisma }));

import { Prisma } from "@prisma/client";
import {
  decisionSnapshotToColumns,
  computeDecisionSnapshot,
  upsertCalibrationCandidates,
  listCalibrationCandidates,
  readCalibrationCandidate,
  reviewCalibrationCandidate,
  DECISION_STORE_VERSION,
} from "@app/kernel/server/decision-store";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import { buildForecastSnapshot } from "@app/kernel/engine/deviation";
import type { CandidateSeed } from "@app/kernel/engine/deviation";

const prisma = h.prisma;
const findUnique = prisma.calibrationCandidate.findUnique as unknown as ReturnType<typeof vi.fn>;
const findMany = prisma.calibrationCandidate.findMany as unknown as ReturnType<typeof vi.fn>;
const createRow = prisma.calibrationCandidate.create as unknown as ReturnType<typeof vi.fn>;
const updateRow = prisma.calibrationCandidate.update as unknown as ReturnType<typeof vi.fn>;

function passthroughTx() {
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma));
}

/** 造一条最小可用的 CandidateSeed（字段与 detectCalibrationCandidates 产出契约一致）。 */
function seed(over: Partial<CandidateSeed> = {}): CandidateSeed {
  return {
    dedupeKey: "pvGenerationKwh|sx|pv-ac-generation|aggregate",
    metric: "pvGenerationKwh",
    metricLabel: "光伏发电量",
    parameter: "pv.specificYieldKwhPerKwp",
    parameterLabel: "光伏年等效利用小时",
    measurementBasis: "pv-ac-generation",
    unit: "kWh",
    periodKind: "aggregate",
    regionId: "sx",
    projectId: "prj-1",
    direction: "over_forecast",
    forecastValue: 1_000_000,
    actualValue: 820_000,
    biasPct: -18,
    meanAbsPct: 18,
    sampleCount: 3,
    impactYuan: -90_000,
    impactEvidenceKind: "ASSUMPTION",
    evidence: { comparableCount: 3, positiveCount: 0, negativeCount: 3, rangePct: { min: -20, max: -15 }, note: "偏低" },
    suggestion: "建议复核该地区光伏产能基准。",
    ...over,
  };
}

/** 造一条 DB 行（Decimal 用真 Prisma.Decimal，贴近 candidateToView 的读取路径）。 */
function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: "cand-1",
    dedupeKey: "pvGenerationKwh|sx|pv-ac-generation|aggregate",
    metric: "pvGenerationKwh",
    metricLabel: "光伏发电量",
    parameter: "pv.specificYieldKwhPerKwp",
    parameterLabel: "光伏年等效利用小时",
    measurementBasis: "pv-ac-generation",
    unit: "kWh",
    periodKind: "aggregate",
    projectId: "prj-1",
    regionId: "sx",
    direction: "over_forecast",
    forecastValue: new Prisma.Decimal("1000000"),
    actualValue: new Prisma.Decimal("820000"),
    biasPct: new Prisma.Decimal("-18"),
    meanAbsPct: new Prisma.Decimal("18"),
    sampleCount: 3,
    impactYuan: new Prisma.Decimal("-90000.00"),
    impactEvidenceKind: "ASSUMPTION",
    evidence: {},
    suggestion: "建议复核。",
    status: "CANDIDATE",
    reviewedBy: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  passthroughTx();
});

/* ───────────── ① 冻结预测：只读投影入列，确定性 ───────────── */

describe("R6 · decisionSnapshotToColumns 写入 forecastSnapshot（只投影不重算）", () => {
  it("快照带 forecastSnapshot，且等于对同一 calc 直接 buildForecastSnapshot 的结果", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: 0.45 });
    const computed = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    const cols = decisionSnapshotToColumns(computed.snapshot) as unknown as Record<string, unknown>;
    expect(cols.forecastSnapshot).toBeTruthy();
    expect(JSON.stringify(cols.forecastSnapshot)).toBe(JSON.stringify(buildForecastSnapshot(computed.snapshot.calc)));
  });

  it("同一输入两次落库列，forecastSnapshot 与 inputHash 逐字节稳定（确定性、无时钟）", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: 0.45 });
    const ca = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    const cb = computeDecisionSnapshot(input, { generatedAtIso: "2026-07-07T00:00:00.000Z" });
    expect(ca.ok && cb.ok).toBe(true);
    if (!ca.ok || !cb.ok) return;
    const a = decisionSnapshotToColumns(ca.snapshot) as unknown as Record<string, unknown>;
    const b = decisionSnapshotToColumns(cb.snapshot) as unknown as Record<string, unknown>;
    expect(JSON.stringify(a.forecastSnapshot)).toBe(JSON.stringify(b.forecastSnapshot));
    expect(a.inputHash).toBe(b.inputHash);
  });
});

/* ───────────── ② upsert：新记录给 CANDIDATE，命中保留人工态 ───────────── */

describe("R6 · upsertCalibrationCandidates（幂等 + 人工状态不被机器抹平）", () => {
  it("dedupeKey 不存在 → create，且强制 status=CANDIDATE", async () => {
    findUnique.mockResolvedValue(null);
    createRow.mockResolvedValue(dbRow());
    const res = await upsertCalibrationCandidates([seed()]);
    expect(res.ok && res.created === 1 && res.upserted === 1).toBe(true);
    expect(createRow).toHaveBeenCalledTimes(1);
    expect(updateRow).not.toHaveBeenCalled();
    const data = createRow.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("CANDIDATE");
    expect(data.dedupeKey).toBe(seed().dedupeKey);
  });

  it("dedupeKey 命中已 ACCEPTED 记录 → 只 update 分析字段，data 里绝不带 status/review* （§20/§34）", async () => {
    findUnique.mockResolvedValue({ id: "cand-1", status: "ACCEPTED" });
    updateRow.mockResolvedValue(dbRow({ status: "ACCEPTED" }));
    const res = await upsertCalibrationCandidates([seed({ biasPct: -22 })]);
    expect(res.ok && res.created === 0 && res.upserted === 1).toBe(true);
    expect(createRow).not.toHaveBeenCalled();
    expect(updateRow).toHaveBeenCalledTimes(1);
    const call = updateRow.mock.calls[0][0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: "cand-1" });
    // 关键防漂移：人工态字段不得出现在 update data 里
    expect("status" in call.data).toBe(false);
    expect("reviewedBy" in call.data).toBe(false);
    expect("reviewNote" in call.data).toBe(false);
    expect("reviewedAt" in call.data).toBe(false);
    // 但分析字段照刷新
    expect(call.data.biasPct).toBe("-22.0000");
  });

  it("空 seeds → 零写库，返回 0/0", async () => {
    const res = await upsertCalibrationCandidates([]);
    expect(res.ok && res.created === 0 && res.upserted === 0).toBe(true);
    expect(createRow).not.toHaveBeenCalled();
    expect(updateRow).not.toHaveBeenCalled();
  });
});

/* ───────────── 读视图：过滤 + Decimal→number + null 诚实 ───────────── */

describe("R6 · listCalibrationCandidates / readCalibrationCandidate", () => {
  it("按 projectId+status 过滤，且 Decimal 折成 number", async () => {
    findMany.mockResolvedValue([dbRow()]);
    const list = await listCalibrationCandidates({ projectId: "prj-1", status: "CANDIDATE" });
    expect(list).toHaveLength(1);
    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.projectId).toBe("prj-1");
    expect(where.status).toBe("CANDIDATE");
    expect(list[0].biasPct).toBe(-18); // Decimal → number
    expect(list[0].impactYuan).toBe(-90000);
    expect(typeof list[0].createdAt).toBe("string"); // Date → ISO
  });

  it("Decimal 为 null → 视图字段 null，绝不折 0", async () => {
    findMany.mockResolvedValue([dbRow({ biasPct: null, impactYuan: null, forecastValue: null })]);
    const [c] = await listCalibrationCandidates({ projectId: "prj-1" });
    expect(c.biasPct).toBeNull();
    expect(c.impactYuan).toBeNull();
    expect(c.forecastValue).toBeNull();
  });

  it("readCalibrationCandidate：命中→视图，未命中→null", async () => {
    findUnique.mockResolvedValue(dbRow());
    const hit = await readCalibrationCandidate("cand-1");
    expect(hit?.id).toBe("cand-1");
    findUnique.mockResolvedValue(null);
    expect(await readCalibrationCandidate("nope")).toBeNull();
  });
});

/* ───────────── ③ 审核状态机 ───────────── */

describe("R6 · reviewCalibrationCandidate（状态机 + 终态不可回退）", () => {
  it("合法：CANDIDATE → UNDER_REVIEW（写审核人/时刻）", async () => {
    findUnique.mockResolvedValue({ id: "cand-1", status: "CANDIDATE" });
    updateRow.mockResolvedValue({ id: "cand-1", status: "UNDER_REVIEW" });
    const res = await reviewCalibrationCandidate({
      id: "cand-1",
      to: "UNDER_REVIEW",
      reviewedBy: "human:u1",
      reviewNote: "复核中",
      reviewedAtIso: "2026-09-20T00:00:00.000Z",
    });
    expect(res.ok && res.status === "UNDER_REVIEW").toBe(true);
    const data = updateRow.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("UNDER_REVIEW");
    expect(data.reviewedBy).toBe("human:u1");
  });

  it("合法：UNDER_REVIEW → ACCEPTED（人工采纳，但仍不改引擎/基准）", async () => {
    findUnique.mockResolvedValue({ id: "cand-1", status: "UNDER_REVIEW" });
    updateRow.mockResolvedValue({ id: "cand-1", status: "ACCEPTED" });
    const res = await reviewCalibrationCandidate({ id: "cand-1", to: "ACCEPTED", reviewedBy: "human:u1" });
    expect(res.ok && res.status === "ACCEPTED").toBe(true);
  });

  it("非法：ACCEPTED → CANDIDATE 被拒（终态不回退为待办）", async () => {
    findUnique.mockResolvedValue({ id: "cand-1", status: "ACCEPTED" });
    const res = await reviewCalibrationCandidate({ id: "cand-1", to: "CANDIDATE" });
    expect(res.ok === false && res.reason === "invalid").toBe(true);
    expect(updateRow).not.toHaveBeenCalled();
  });

  it("非法：REJECTED → UNDER_REVIEW 被拒", async () => {
    findUnique.mockResolvedValue({ id: "cand-1", status: "REJECTED" });
    const res = await reviewCalibrationCandidate({ id: "cand-1", to: "UNDER_REVIEW" });
    expect(res.ok === false && res.reason === "invalid").toBe(true);
    expect(updateRow).not.toHaveBeenCalled();
  });

  it("候选不存在 → not_found", async () => {
    findUnique.mockResolvedValue(null);
    const res = await reviewCalibrationCandidate({ id: "ghost", to: "ACCEPTED" });
    expect(res.ok === false && res.reason === "not_found").toBe(true);
  });

  it("非法目标态字符串 → invalid，且不查库迁移", async () => {
    const res = await reviewCalibrationCandidate({ id: "cand-1", to: "WRONG" as never });
    expect(res.ok === false && res.reason === "invalid").toBe(true);
    expect(updateRow).not.toHaveBeenCalled();
  });
});

/* ───────────── ④ 版本常量反证：R6 未惊动计算口径 ───────────── */

describe("R6 · 反证：存储层语义化版本 + 计算真源未动", () => {
  it("DECISION_STORE_VERSION 升到 1.2.0", () => {
    expect(DECISION_STORE_VERSION).toBe("1.2.0");
  });
});
