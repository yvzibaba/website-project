import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * R5 · V2 版本治理单测（**离线**：顶掉 prisma，绝不触库、绝不打真网络）。
 *
 * 守的是四条一旦破就极隐蔽的契约：
 *   ① 覆盖前冻结：正式情景重算时，**上一版成功结果**必须先落成一条不可变 ProjectVersion，
 *      且冻结进去的是**当时**的 engineVersion / inputHash / 输入 / 计算时刻——绝不被今天的重算改写；
 *      当前态随后写入**新**指纹，version++，并留下一条 ChangeLog（from/to + why）。
 *   ② 失败也保住旧成功：重算**算不通**时，旧的成功结果照样冻结，当前态只清状态不冒充数字。
 *   ③ 溯源诚实：历史版本的 scenarioSchemaVersion 取自**存档输入自身**，绝不拿当下常量回填；
 *      未评估的指标如实 null，绝不折成 0。
 *   ④ 单一计算真源不破：本文件所有"结果"都由真实 `runCalculation()`（经 computeDecisionSnapshot）产出，
 *      冻结只是搬运已算好的切片——黄金基线与引擎常量与此文件无关，改此处不触内核。
 */

const h = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    projectScenario: { findUnique: vi.fn(), update: vi.fn() },
    projectVersion: { aggregate: vi.fn(), create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    changeLog: { create: vi.fn() },
    region: { findUnique: vi.fn() },
  },
}));
vi.mock("@app/kernel/lib/prisma", () => ({ prisma: h.prisma }));

import {
  shouldFreezeV2BeforeOverwrite,
  summarizeScenarioPatchDiff,
  scenarioProvenanceOf,
  extractVersionSummary,
  computeDecisionSnapshot,
  recalculateDecisionScenario,
  saveDecisionScenarioAsVersion,
  listDecisionScenarioVersions,
  DECISION_STORE_VERSION,
} from "@app/kernel/server/decision-store";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import type { ScenarioInput } from "@app/kernel/engine/types";

const prisma = h.prisma;
const findScenario = prisma.projectScenario.findUnique as unknown as ReturnType<typeof vi.fn>;
const updateScenario = prisma.projectScenario.update as unknown as ReturnType<typeof vi.fn>;
const aggVersions = prisma.projectVersion.aggregate as unknown as ReturnType<typeof vi.fn>;
const createVersion = prisma.projectVersion.create as unknown as ReturnType<typeof vi.fn>;
const findVersion = prisma.projectVersion.findUnique as unknown as ReturnType<typeof vi.fn>;
const findManyVersions = prisma.projectVersion.findMany as unknown as ReturnType<typeof vi.fn>;
const createLog = prisma.changeLog.create as unknown as ReturnType<typeof vi.fn>;

// $transaction 直接以同一个 mock 客户端回调（decision-store 用的 tx 表名与 prisma 顶层一致）。
function passthroughTx() {
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(prisma));
}

/** 造一条"已成功冻结过"的 V2 情景行：真实跑一遍引擎，用其产物填当时指纹。 */
function existingV2Row(over: Record<string, unknown> = {}) {
  const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: 0.45, name: "基线情景" });
  const computed = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
  if (!computed.ok) throw new Error("前置不成立：默认情景必须算通");
  const snap = computed.snapshot;
  const m = snap.calc.economics.metrics;
  return {
    row: {
      id: "scn-1",
      projectId: "prj-1",
      version: 3,
      scenarioInput: snap.calc.inputSnapshot,
      engineVersion: snap.calc.calcRef, // "calc@2.0.0"
      benchmarkVersion: snap.calc.benchmarkVersion,
      inputHash: snap.calc.inputHash,
      decision: snap.calc.decision,
      calcStatus: "ok",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      capexNet: snap.calc.economics.capex.netYuan,
      npv: m.npvYuan,
      irrPct: m.irr.ok ? m.irr.valuePct : null,
      paybackYears: m.discountedPaybackYears,
      lcoeYuanPerKwh: m.lcoeYuanPerKwh,
      npvEquity: m.equity.npvYuan,
      irrEquityPct: m.equity.irr.ok ? m.equity.irr.valuePct : null,
      ...over,
    },
    snap,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  passthroughTx();
});

/* ─────────────── 纯函数：冻结判据 / 差分 / 溯源 / 摘要 ─────────────── */

describe("R5 · shouldFreezeV2BeforeOverwrite（三条件缺一不可）", () => {
  it("成功 V2 结果（有 engineVersion + ok + 有输入）→ 冻结", () => {
    expect(shouldFreezeV2BeforeOverwrite({ engineVersion: "calc@2.0.0", calcStatus: "ok", scenarioInput: {} })).toBe(true);
  });
  it("非 V2（engineVersion 为空）→ 不冻结", () => {
    expect(shouldFreezeV2BeforeOverwrite({ engineVersion: null, calcStatus: "ok", scenarioInput: {} })).toBe(false);
  });
  it("算不通（calcStatus≠ok）→ 不冻结（没价值可保）", () => {
    expect(shouldFreezeV2BeforeOverwrite({ engineVersion: "calc@2.0.0", calcStatus: "error", scenarioInput: {} })).toBe(false);
  });
  it("无输入快照 → 不冻结（复放不了）", () => {
    expect(shouldFreezeV2BeforeOverwrite({ engineVersion: "calc@2.0.0", calcStatus: "ok", scenarioInput: null })).toBe(false);
  });
});

describe("R5 · summarizeScenarioPatchDiff（改了哪几组，人读）", () => {
  it("完全相同 → 无差异", () => {
    const { row } = existingV2Row();
    const input = row.scenarioInput as ScenarioInput;
    expect(summarizeScenarioPatchDiff(input, input)).toEqual([]);
  });
  it("只改经济参数 → 命中 economics（带中文组名）", () => {
    const { row } = existingV2Row();
    const a = row.scenarioInput as ScenarioInput;
    const b = structuredClone(a) as ScenarioInput;
    b.economics.chargingServiceFeeYuanPerKwh = a.economics.chargingServiceFeeYuanPerKwh + 0.1;
    const diff = summarizeScenarioPatchDiff(a, b);
    expect(diff.map((d) => d.key)).toEqual(["economics"]);
    expect(diff[0].label).toBe("经济参数");
  });
  it("改展示名（不参与计算）也算一次可视变更，但输入哈希不变（见哈希稳定性用例）", () => {
    const { row } = existingV2Row();
    const a = row.scenarioInput as ScenarioInput;
    const b = structuredClone(a) as ScenarioInput;
    b.name = "改了个名字";
    expect(summarizeScenarioPatchDiff(a, b).map((d) => d.key)).toEqual(["name"]);
  });
  it("任一侧为 null → 空摘要（不猜）", () => {
    const { row } = existingV2Row();
    expect(summarizeScenarioPatchDiff(null, row.scenarioInput as ScenarioInput)).toEqual([]);
  });
});

describe("R5 · scenarioProvenanceOf（历史 schema 取存档输入，不读当下常量）", () => {
  it("五字段齐备，且 scenarioSchemaVersion 来自输入自身", () => {
    const p = scenarioProvenanceOf({
      engineVersion: "calc@2.0.0",
      benchmarkVersion: "1.0.0",
      scenarioInput: { schemaVersion: "0.9.0-历史" },
      inputHash: "abc123",
      updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    });
    expect(p).toEqual({
      engineVersion: "calc@2.0.0",
      benchmarkVersion: "1.0.0",
      scenarioSchemaVersion: "0.9.0-历史", // ★不是当下的 SCENARIO_SCHEMA_VERSION
      inputHash: "abc123",
      calculatedAt: "2026-05-05T00:00:00.000Z",
    });
  });
  it("输入缺 schemaVersion / 非法时刻 → 相应字段 null，绝不编造", () => {
    const p = scenarioProvenanceOf({
      engineVersion: null,
      benchmarkVersion: null,
      scenarioInput: { noSchemaHere: 1 },
      inputHash: null,
      updatedAt: "not-a-date",
    });
    expect(p.scenarioSchemaVersion).toBeNull();
    expect(p.calculatedAt).toBeNull();
    expect(p.engineVersion).toBeNull();
  });
});

describe("R5 · extractVersionSummary（未评估如实 null，绝不折 0）", () => {
  it("空值行：feasible/recommended/各指标全 null", () => {
    const { row } = existingV2Row({
      decision: null,
      capexNet: null,
      npv: null,
      irrPct: null,
      paybackYears: null,
      lcoeYuanPerKwh: null,
      npvEquity: null,
      irrEquityPct: null,
    });
    const s = extractVersionSummary(row as never);
    expect(s.feasible).toBeNull();
    expect(s.recommended).toBeNull();
    expect(s.npvYuan).toBeNull();
    expect(s.capexNetYuan).toBeNull();
    expect(s.calcStatus).toBe("ok");
  });
  it("成功行：feasible/recommended 从 decision 原样提取、指标为有限数", () => {
    const { row, snap } = existingV2Row();
    const s = extractVersionSummary(row as never);
    expect(s.feasible).toBe(snap.calc.decision.feasibility.feasible);
    expect(s.recommended).toBe(snap.calc.decision.recommendation.recommended);
    expect(Number.isFinite(s.npvYuan as number)).toBe(true);
  });
});

/* ─────────────── 冻结主流程：recalculate（成功 / 失败 / 不冻结） ─────────────── */

describe("R5 · recalculateDecisionScenario（覆盖前冻结旧成功版）", () => {
  it("成功重算：旧 engineVersion/inputHash 冻结进新版本，当前态写新指纹，version++，记 ChangeLog", async () => {
    const { row } = existingV2Row();
    findScenario.mockResolvedValue(row);
    aggVersions.mockResolvedValue({ _max: { seq: 0 } });
    createVersion.mockResolvedValue({ id: "pv-1" });
    updateScenario.mockResolvedValue({ version: row.version + 1 });
    createLog.mockResolvedValue({ id: "cl-1" });

    const res = await recalculateDecisionScenario({
      scenarioId: "scn-1",
      patch: { economics: { chargingServiceFeeYuanPerKwh: 0.6 } } as never,
      actor: "human:u1",
      reason: "服务费上调后重算",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(4);
    expect(res.frozenSeq).toBe(1);

    // ① 冻结进版本的是**旧**指纹
    expect(createVersion).toHaveBeenCalledTimes(1);
    const vdata = createVersion.mock.calls[0][0].data;
    expect(vdata.engineVersion).toBe(row.engineVersion);
    expect(vdata.inputHash).toBe(row.inputHash);
    expect(JSON.stringify(vdata.scenarioInput)).toBe(JSON.stringify(row.scenarioInput));
    expect(vdata.calculatedAt).toBe(row.updatedAt);
    expect(vdata.scenarioSchemaVersion).toBe((row.scenarioInput as ScenarioInput).schemaVersion);
    expect(vdata.summary.calcStatus).toBe("ok");

    // ② 当前态写入的是**新**指纹（与旧的必然不同）
    expect(updateScenario).toHaveBeenCalledTimes(1);
    const udata = updateScenario.mock.calls[0][0].data;
    expect(udata.inputHash).not.toBe(row.inputHash);
    expect(udata.calcStatus).toBe("ok");

    // ③ ChangeLog：entityType=ProjectScenario，from/to 版本 + frozenSeq + whatChanged + reason
    expect(createLog).toHaveBeenCalledTimes(1);
    const cdata = createLog.mock.calls[0][0].data;
    expect(cdata.entityType).toBe("ProjectScenario");
    expect(cdata.action).toBe("UPDATE");
    expect(cdata.reason).toBe("服务费上调后重算");
    expect(cdata.before.scenarioVersion).toBe(3);
    expect(cdata.after.frozenSeq).toBe(1);
    expect(cdata.after.whatChanged.map((c: { key: string }) => c.key)).toContain("economics");
  });

  it("重算算不通：旧成功结果照样冻结，当前态只清状态、npv=null、不冒充数字", async () => {
    const { row } = existingV2Row();
    findScenario.mockResolvedValue(row);
    aggVersions.mockResolvedValue({ _max: { seq: 4 } }); // 下一 seq=5
    createVersion.mockResolvedValue({ id: "pv-5" });
    updateScenario.mockResolvedValue({ version: row.version + 1 });
    createLog.mockResolvedValue({ id: "cl-2" });

    // grid.capacityKw=0 触发 validateScenarioInput 的 fatal → 引擎 ok:false
    const res = await recalculateDecisionScenario({
      scenarioId: "scn-1",
      patch: { grid: { capacityKw: 0 } } as never,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.frozenSeq).toBe(5); // 旧成功仍被冻结
    expect(createVersion).toHaveBeenCalledTimes(1);
    expect(createVersion.mock.calls[0][0].data.inputHash).toBe(row.inputHash);

    const udata = updateScenario.mock.calls[0][0].data;
    expect(udata.calcStatus).not.toBe("ok");
    expect(udata.npv).toBeNull();
    // 失败也要留住用户改坏的那份输入，下次接着改
    expect(udata.scenarioInput).toBeTruthy();
    const cdata = createLog.mock.calls[0][0].data;
    expect(cdata.after.calcStatus).toBe("engine_failed");
  });

  it("当前非成功结果（engineVersion=null）：不制造空版本、frozenSeq=null", async () => {
    const { row } = existingV2Row({ engineVersion: null, calcStatus: "error" });
    findScenario.mockResolvedValue(row);
    updateScenario.mockResolvedValue({ version: row.version + 1 });
    createLog.mockResolvedValue({ id: "cl-3" });

    const res = await recalculateDecisionScenario({ scenarioId: "scn-1", patch: { economics: { chargingServiceFeeYuanPerKwh: 0.7 } } as never });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.frozenSeq).toBeNull();
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("情景不存在 / 非 V2（无 scenarioInput）→ not_found，且不动库", async () => {
    findScenario.mockResolvedValue(null);
    const missing = await recalculateDecisionScenario({ scenarioId: "nope" });
    expect(missing.ok === false && missing.reason === "not_found").toBe(true);

    findScenario.mockResolvedValue({ ...existingV2Row().row, scenarioInput: null });
    const notV2 = await recalculateDecisionScenario({ scenarioId: "scn-1" });
    expect(notV2.ok === false && notV2.reason === "not_found").toBe(true);
    expect(updateScenario).not.toHaveBeenCalled();
  });
});

/* ─────────────── 显式存版 / 时间线 ─────────────── */

describe("R5 · saveDecisionScenarioAsVersion", () => {
  it("当前为成功结果 → 冻结一条新版本并记 ChangeLog（不改当前态）", async () => {
    const { row } = existingV2Row();
    findScenario.mockResolvedValue(row);
    aggVersions.mockResolvedValue({ _max: { seq: 2 } }); // 下一 seq=3
    createVersion.mockResolvedValue({ id: "pv-3" });
    findVersion.mockResolvedValue({ id: "pv-3", seq: 3 });
    createLog.mockResolvedValue({ id: "cl-v" });

    const res = await saveDecisionScenarioAsVersion("scn-1", { label: "定稿", savedBy: "human:u1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.seq).toBe(3);
    expect(res.versionId).toBe("pv-3");
    expect(updateScenario).not.toHaveBeenCalled(); // 只存版，绝不动当前态
    expect(createVersion.mock.calls[0][0].data.label).toBe("定稿");
    expect(createLog.mock.calls[0][0].data.reason).toBe("存为版本 v3");
  });

  it("当前没有可冻结的成功结果 → invalid，绝不写空版本", async () => {
    const { row } = existingV2Row({ calcStatus: "error", engineVersion: null });
    findScenario.mockResolvedValue(row);
    const res = await saveDecisionScenarioAsVersion("scn-1");
    expect(res.ok === false && res.reason === "invalid").toBe(true);
    expect(createVersion).not.toHaveBeenCalled();
  });
});

describe("R5 · listDecisionScenarioVersions", () => {
  it("映射冻结切片：createdAt→frozenAt、calculatedAt 可空、summary 原样", async () => {
    findManyVersions.mockResolvedValue([
      {
        id: "pv-2", seq: 2, label: "v2", note: "电价上调", savedBy: "human:u1",
        createdAt: new Date("2026-02-02T00:00:00.000Z"),
        engineVersion: "calc@2.0.0", benchmarkVersion: "1.0.0", scenarioSchemaVersion: "1.0.0",
        inputHash: "hash2", calculatedAt: new Date("2026-02-01T00:00:00.000Z"),
        scenarioInput: {}, summary: { calcStatus: "ok", npvYuan: 123 },
      },
      {
        id: "pv-1", seq: 1, label: null, note: null, savedBy: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        engineVersion: "calc@2.0.0", benchmarkVersion: "1.0.0", scenarioSchemaVersion: null,
        inputHash: "hash1", calculatedAt: null, scenarioInput: {}, summary: null,
      },
    ]);
    const list = await listDecisionScenarioVersions("scn-1");
    expect(list).toHaveLength(2);
    expect(list[0].frozenAt).toBe("2026-02-02T00:00:00.000Z");
    expect(list[0].provenance.calculatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(list[0].summary?.npvYuan).toBe(123);
    expect(list[1].provenance.calculatedAt).toBeNull();
    expect(list[1].summary).toBeNull();
    // 只取带 engineVersion 的 V2 切片（过滤条件在 where 里）
    expect(findManyVersions.mock.calls[0][0].where.engineVersion).toEqual({ not: null });
  });
});

/* ─────────────── 单一真源反证 ─────────────── */

describe("R5 · 反证：计算真源未动 + 存储层版本语义化", () => {
  it("同一输入两次 computeDecisionSnapshot 得到逐字节相同的 inputHash（确定性）", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: 0.45 });
    const a = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    const b = computeDecisionSnapshot(input, { generatedAtIso: "2026-07-07T00:00:00.000Z" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.snapshot.calc.inputHash).toBe(b.snapshot.calc.inputHash);
  });

  it("DECISION_STORE_VERSION 升到语义化的 1.1.0", () => {
    expect(DECISION_STORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DECISION_STORE_VERSION).toBe("1.1.0");
  });
});
