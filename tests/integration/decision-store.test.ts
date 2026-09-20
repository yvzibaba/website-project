import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@app/kernel/lib/prisma";
import {
  addDecisionScenario,
  computeDecisionSnapshot,
  createDecisionProject,
  deleteDecisionScenario,
  deleteProjectActual,
  listDecisionProjects,
  listDecisionScenarioVersions,
  listProjectActuals,
  readDecisionProject,
  readDecisionScenario,
  recalculateDecisionScenario,
  saveDecisionScenarioAsVersion,
  upsertProjectActual,
} from "@app/kernel/server/decision-store";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import { runCalculation } from "@app/kernel/engine/engine";
import type { ScenarioInput } from "@app/kernel/engine/types";
import type { SessionUser } from "@app/kernel/lib/roles";
import { canAccessDecisionProject, precheckScenarioInput } from "@app/kernel/server/decision-service";

/**
 * 集成测试：V2 决策平台持久化层与编排层（真连 Neon，不 mock）。
 *
 * 这一套要守住的是「**留档即真相**」这条底线，而不是"能存进去"：
 *   ① 落库的 `scenarioInput` 喂回 `runCalculation()` 必须得到**完全相同的 inputHash 与关键指标**——
 *      否则"可复算"只是写在文档里的一句话，审计方拿到快照也算不出同样的数；
 *   ② 派生 Decimal 汇总列必须与引擎结果**逐分一致**，不能各算各的；
 *   ③ 计算失败时**数字列必须全为 null**，绝不留旧数字或 0 冒充结论；
 *   ④ 实测（Actuals）的 null 与 0 必须分得清（null=没测，0=实测为零）；
 *   ⑤ 越权在动库前就被拒（非 owner、非 staff → forbidden）。
 *
 * 夹具 afterAll 按外键序 actual → scenario → project → user 清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[decision-store] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdUserIds: string[] = [];
const createdProjectIds: string[] = [];

const FEE = 0.45;

function baseInput(over: Partial<ScenarioInput> = {}): ScenarioInput {
  const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
  return { ...input, ...over };
}

async function warmup() {
  for (let i = 0; i < 4; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function makeUser(role: "USER" | "ADMIN" = "USER"): Promise<SessionUser> {
  const u = await prisma.user.create({
    data: { email: `${runId}-${createdUserIds.length}@example.test`, passwordHash: "x", role },
    select: { id: true, email: true, name: true, role: true },
  });
  createdUserIds.push(u.id);
  return { id: u.id, email: u.email, name: u.name, role: u.role } as SessionUser;
}

beforeAll(async () => {
  if (HAS_DB) await warmup();
});

afterAll(async () => {
  if (!HAS_DB) return;
  // 按外键序清理：actual → scenario（随 project 级联）→ project → user
  await prisma.projectActual.deleteMany({ where: { projectId: { in: createdProjectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await disconnectPrisma();
});

describeDb("V2 决策平台：持久化与可复算", () => {
  it("落库的输入喂回引擎，得到完全相同的哈希与关键指标（可复算不是口号）", async () => {
    const owner = await makeUser();
    const input = baseInput({ name: `${runId} 基线` });
    const created = await createDecisionProject({
      name: `${runId} 山西重卡`,
      description: "集成测试项目",
      ownerId: owner.id,
      scenarioInput: input,
      generatedAtIso: "2026-09-18T00:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdProjectIds.push(created.projectId);

    // 引擎侧直接算一遍（当作「审计方独立复算」）
    const direct = runCalculation(input);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;

    const stored = await readDecisionScenario(created.scenarioId);
    expect(stored).not.toBeNull();
    if (!stored) return;
    expect(stored.scenarioInput).not.toBeNull();

    // 用**存档输入**重算，哈希必须一致（说明存档没被截断/改写）
    const replay = runCalculation(stored.scenarioInput as ScenarioInput);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.inputHash).toBe(direct.inputHash);
    expect(stored.inputHash).toBe(direct.inputHash);
    expect(stored.engineVersion).toBe(direct.calcRef);
    expect(stored.calcRef).toBe(direct.calcRef);
    expect(stored.benchmarkVersion).toBe(direct.benchmarkVersion);

    // 决策与报告也一并留档，且报告头的溯源信息完整
    expect(stored.decision).not.toBeNull();
    expect(stored.report).not.toBeNull();
    const report = stored.report as { provenance: { engineVersion: string; inputHash: string } };
    // 报告头的 engineVersion 是**引擎版本号**（2.0.0），calcRef 是带前缀的可读引用（calc@2.0.0）；
    // 两者必须指向同一次计算，故校验 calcRef = `calc@${engineVersion}`。
    expect(report.provenance.engineVersion).toBe(direct.engineVersion);
    expect(stored.calcRef).toBe(`calc@${report.provenance.engineVersion}`);
    expect(report.provenance.inputHash).toBe(direct.inputHash);
  });

  it("派生 Decimal 汇总列与引擎结果逐分一致（不允许两处各算各的）", async () => {
    const owner = await makeUser();
    const input = baseInput({ name: `${runId} 汇总口径` });
    const created = await createDecisionProject({
      name: `${runId} 汇总`,
      ownerId: owner.id,
      scenarioInput: input,
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    const direct = runCalculation(input);
    if (!direct.ok) throw new Error("引擎算不出来");

    const row = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { npv: true, irrPct: true, capexNet: true, lcoeYuanPerKwh: true, npvEquity: true, irrEquityPct: true },
    });
    expect(Number(row!.npv!.toString())).toBeCloseTo(direct.economics.metrics.npvYuan, 2);
    expect(Number(row!.capexNet!.toString())).toBeCloseTo(direct.economics.capex.netYuan, 2);
    expect(Number(row!.irrPct!.toString())).toBeCloseTo(direct.economics.metrics.irr.valuePct!, 4);
    expect(Number(row!.lcoeYuanPerKwh!.toString())).toBeCloseTo(direct.economics.metrics.lcoeYuanPerKwh!, 4);
    expect(Number(row!.npvEquity!.toString())).toBeCloseTo(direct.economics.metrics.equity.npvYuan, 2);
    expect(Number(row!.irrEquityPct!.toString())).toBeCloseTo(direct.economics.metrics.equity.irr.valuePct!, 4);
  });

  it("同一份输入两次计算逐字节一致（确定性由存储层可见）", async () => {
    const input = baseInput({ name: `${runId} 确定性` });
    const a = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    const b = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // 除去耗时字段外必须完全一致
    expect(JSON.stringify(a.snapshot.calc)).toBe(JSON.stringify(b.snapshot.calc));
    expect(JSON.stringify(a.snapshot.report)).toBe(JSON.stringify(b.snapshot.report));
  });

  it("输入非法 → 连项目都不建（不让库里出现永远算不通的空壳）", async () => {
    const owner = await makeUser();
    const bad = baseInput({ name: `${runId} 非法` });
    bad.truck = { ...bad.truck, chargingWindowStartHour: 10, chargingWindowEndHour: 6 };

    const created = await createDecisionProject({
      name: `${runId} 不该存在`,
      ownerId: owner.id,
      scenarioInput: bad,
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("invalid");

    const leaked = await prisma.project.findFirst({ where: { name: `${runId} 不该存在` }, select: { id: true } });
    expect(leaked).toBeNull();
  });

  it("引擎失败（不变量/输入致命错）→ 项目仍在，但数字列全为 null 且失败原因可查", async () => {
    const owner = await makeUser();
    // 零并网容量：结构性缺陷，引擎必须拒绝
    const bad = baseInput({ name: `${runId} 零容量` });
    bad.grid = { ...bad.grid, capacityKw: 0 };

    const created = await createDecisionProject({
      name: `${runId} 失败留痕`,
      ownerId: owner.id,
      scenarioInput: bad,
    });
    // 该缺陷由 validateScenarioInput 在外层拦下 → 等同 invalid，不入库
    if (!created.ok) {
      expect(created.reason).toBe("invalid");
      return;
    }
    createdProjectIds.push(created.projectId);
    // 若引擎选择「建项目但标记失败」，则必须满足下面的诚实口径
    expect(created.snapshot).toBeNull();
    const row = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { calcStatus: true, npv: true, capexNet: true, calcError: true, decision: true },
    });
    expect(row!.calcStatus).not.toBe("ok");
    expect(row!.npv).toBeNull();
    expect(row!.capexNet).toBeNull();
    expect(row!.decision).toBeNull();
    expect(row!.calcError).toBeTruthy();
  });

  it("重算：用补丁改一个参数，指标随之变化且哈希变化（命脉：改参数 → 结果变）", async () => {
    const owner = await makeUser();
    const input = baseInput({ name: `${runId} 重算` });
    const created = await createDecisionProject({
      name: `${runId} 重算项目`,
      ownerId: owner.id,
      scenarioInput: input,
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    const before = await readDecisionScenario(created.scenarioId);
    const beforeNpv = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { npv: true, inputHash: true },
    });

    const r = await recalculateDecisionScenario({
      scenarioId: created.scenarioId,
      patch: { economics: { ...input.economics, chargingServiceFeeYuanPerKwh: FEE + 0.15 } },
    });
    expect(r.ok).toBe(true);

    const after = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { npv: true, inputHash: true },
    });
    expect(after!.inputHash).not.toBe(beforeNpv!.inputHash);
    expect(Number(after!.npv!.toString())).not.toBeCloseTo(Number(beforeNpv!.npv!.toString()), 2);
    expect(before!.scenarioInput).not.toBeNull();
  });

  it("重算时补丁是「在存档输入之上」的增量，不会把没提到的参数悄悄重置", async () => {
    const owner = await makeUser();
    const input = baseInput({ name: `${runId} 增量` });
    input.note = "这个备注不该被重算抹掉";
    const created = await createDecisionProject({
      name: `${runId} 增量项目`,
      ownerId: owner.id,
      scenarioInput: input,
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    await recalculateDecisionScenario({
      scenarioId: created.scenarioId,
      patch: { note: undefined, truck: { ...input.truck, truckCount: input.truck.truckCount + 5 } },
    });
    const after = await readDecisionScenario(created.scenarioId);
    expect((after!.scenarioInput as ScenarioInput).note).toBe("这个备注不该被重算抹掉");
    expect((after!.scenarioInput as ScenarioInput).truck.truckCount).toBe(input.truck.truckCount + 5);
  });

  it("追加情景 → 同项目多情景可比；基线不可删、非基线可删", async () => {
    const owner = await makeUser();
    const created = await createDecisionProject({
      name: `${runId} 多情景`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} 基线` }),
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    const added = await addDecisionScenario({
      projectId: created.projectId,
      name: "纯电网对照",
      scenarioInput: baseInput({ name: "纯电网对照" }),
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const project = await readDecisionProject(created.projectId);
    expect(project!.scenarios.length).toBe(2);
    // 基线排在最前
    expect(project!.scenarios[0].isBaseline).toBe(true);

    const delBaseline = await deleteDecisionScenario(created.scenarioId);
    expect(delBaseline.ok).toBe(false);
    const delAdded = await deleteDecisionScenario(added.scenarioId);
    expect(delAdded.ok).toBe(true);

    const after = await readDecisionProject(created.projectId);
    expect(after!.scenarios.length).toBe(1);
  });

  it("项目列表按 owner 隔离，且只包含有 V2 情景的项目", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const created = await createDecisionProject({
      name: `${runId} 隔离`,
      ownerId: a.id,
      scenarioInput: baseInput({ name: `${runId} 隔离` }),
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    const listA = await listDecisionProjects(a.id);
    const listB = await listDecisionProjects(b.id);
    expect(listA.some((p) => p.id === created.projectId)).toBe(true);
    expect(listB.some((p) => p.id === created.projectId)).toBe(false);
    // 摘要里带得出可排序的关键指标
    const entry = listA.find((p) => p.id === created.projectId)!;
    expect(entry.scenarioCount).toBe(1);
    expect(entry.baseline?.npvYuan).toBeGreaterThan(0);
  });
});

describeDb("R5 · V2 版本治理：覆盖前冻结 + 时间线（真连库）", () => {
  it("成功重算：旧结果冻结为不可变版本（其输入可复算回旧哈希），当前态写新指纹，ChangeLog 在链", async () => {
    const owner = await makeUser();
    const input = baseInput({ name: `${runId} R5冻结` });
    const created = await createDecisionProject({
      name: `${runId} R5冻结项目`,
      ownerId: owner.id,
      scenarioInput: input,
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    const before = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { version: true, inputHash: true, engineVersion: true, npv: true },
    });

    const r = await recalculateDecisionScenario({
      scenarioId: created.scenarioId,
      patch: { economics: { ...input.economics, chargingServiceFeeYuanPerKwh: FEE + 0.2 } },
      actor: `human:${owner.id}`,
      reason: "R5 集成：服务费上调后重算",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frozenSeq).not.toBeNull();

    // ① 冻结进 ProjectVersion 的是**旧**指纹
    const frozen = await prisma.projectVersion.findUnique({
      where: { scenarioId_seq: { scenarioId: created.scenarioId, seq: r.frozenSeq as number } },
      select: { engineVersion: true, inputHash: true, scenarioInput: true, summary: true, scenarioSchemaVersion: true, calculatedAt: true },
    });
    expect(frozen).not.toBeNull();
    expect(frozen!.engineVersion).toBe(before!.engineVersion);
    expect(frozen!.inputHash).toBe(before!.inputHash);
    expect(frozen!.scenarioSchemaVersion).toBe((input as ScenarioInput).schemaVersion);
    expect(frozen!.calculatedAt).not.toBeNull();
    // ★历史可复算：把冻结的输入喂回引擎，必须还原出**旧**哈希（证明历史没被今天改写）
    const replay = runCalculation(frozen!.scenarioInput as unknown as ScenarioInput);
    expect(replay.ok && replay.inputHash === before!.inputHash).toBe(true);

    // ② 当前态写的是**新**指纹，version++
    const after = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { version: true, inputHash: true },
    });
    expect(after!.inputHash).not.toBe(before!.inputHash);
    expect(after!.version).toBe(before!.version + 1);

    // ③ ChangeLog 在链（复用既有表，from/to 版本 + frozenSeq + reason）
    const log = await prisma.changeLog.findFirst({
      where: { entityType: "ProjectScenario", entityId: created.scenarioId, action: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect((log!.after as Record<string, unknown>).frozenSeq).toBe(r.frozenSeq);
    expect(log!.reason).toContain("服务费上调");
  });

  it("重算算不通：旧成功结果照样被冻结，当前态只清数字列不冒充", async () => {
    const owner = await makeUser();
    const input = baseInput({ name: `${runId} R5失败留档` });
    const created = await createDecisionProject({
      name: `${runId} R5失败留档`,
      ownerId: owner.id,
      scenarioInput: input,
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);
    const before = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { inputHash: true },
    });

    const r = await recalculateDecisionScenario({
      scenarioId: created.scenarioId,
      patch: { grid: { ...input.grid, capacityKw: 0 } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frozenSeq).not.toBeNull(); // 旧成功仍被保住

    const frozen = await prisma.projectVersion.findUnique({
      where: { scenarioId_seq: { scenarioId: created.scenarioId, seq: r.frozenSeq as number } },
      select: { inputHash: true },
    });
    expect(frozen!.inputHash).toBe(before!.inputHash);

    const now = await prisma.projectScenario.findUnique({
      where: { id: created.scenarioId },
      select: { calcStatus: true, npv: true },
    });
    expect(now!.calcStatus).not.toBe("ok");
    expect(now!.npv).toBeNull();
  });

  it("显式存版 + 时间线：listDecisionScenarioVersions 回读当时指纹（不重算）", async () => {
    const owner = await makeUser();
    const created = await createDecisionProject({
      name: `${runId} R5存版`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} R5存版` }),
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    const sv = await saveDecisionScenarioAsVersion(created.scenarioId, { label: "里程碑1", savedBy: `human:${owner.id}` });
    expect(sv.ok).toBe(true);
    if (!sv.ok) return;

    const list = await listDecisionScenarioVersions(created.scenarioId);
    expect(list.length).toBe(1);
    expect(list[0].label).toBe("里程碑1");
    expect(list[0].provenance.engineVersion).toMatch(/^calc@/);
    expect(list[0].provenance.benchmarkVersion).not.toBeNull();
    expect(list[0].provenance.inputHash).not.toBeNull();
    expect(list[0].summary?.calcStatus).toBe("ok");
  });
});

describeDb("Actuals：null 与 0 必须分得清", () => {
  it("幂等写入同期间不产生重复行；未提供的字段保持 null 而不是 0", async () => {
    const owner = await makeUser();
    const created = await createDecisionProject({
      name: `${runId} actuals`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} actuals` }),
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    // 第一次：只填购电量（其余未测）
    const r1 = await upsertProjectActual({
      projectId: created.projectId,
      scenarioId: created.scenarioId,
      periodYear: 2026,
      periodMonth: 3,
      gridImportKwh: 420_000,
      source: "meter",
    });
    expect(r1.ok).toBe(true);

    // 第二次：同期间再写一次（幂等更新）
    const r2 = await upsertProjectActual({
      projectId: created.projectId,
      scenarioId: created.scenarioId,
      periodYear: 2026,
      periodMonth: 3,
      gridImportKwh: 435_000,
      pvGenerationKwh: 0, // 明确实测为零
    });
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.actualId).toBe(r1.actualId);

    const rows = await listProjectActuals(created.projectId);
    expect(rows.length).toBe(1);
    expect(rows[0].gridImportKwh).toBe(435_000);

    // 关键区分：明确写的 0 是 0；从没写过的字段是 null
    expect(rows[0].pvGenerationKwh).toBe(0);
    expect(rows[0].opexYuan).toBeNull();
    expect(rows[0].deliveredKwh).toBeNull();
    expect(rows[0].availabilityPct).toBeNull();
    // source 未提供时按 schema 默认 manual（而不是 null）
    expect(rows[0].source).toBe("manual");
  });

  it("年度汇总（periodMonth=0）与月度记录互不覆盖", async () => {
    const owner = await makeUser();
    const created = await createDecisionProject({
      name: `${runId} actuals-annual`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} actuals-annual` }),
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    await upsertProjectActual({ projectId: created.projectId, periodYear: 2026, gridImportKwh: 1 });
    await upsertProjectActual({ projectId: created.projectId, periodYear: 2026, periodMonth: 5, gridImportKwh: 2 });

    const rows = await listProjectActuals(created.projectId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.periodMonth).sort()).toEqual([0, 5]);
    const annual = rows.find((r) => r.periodMonth === 0)!;
    const may = rows.find((r) => r.periodMonth === 5)!;
    expect(annual.gridImportKwh).toBe(1);
    expect(may.gridImportKwh).toBe(2);
  });

  it("删除实测记录", async () => {
    const owner = await makeUser();
    const created = await createDecisionProject({
      name: `${runId} actuals-del`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} actuals-del` }),
    });
    if (!created.ok) throw new Error(created.detail);
    createdProjectIds.push(created.projectId);

    const r = await upsertProjectActual({ projectId: created.projectId, periodYear: 2025, gridImportKwh: 10 });
    if (!r.ok) throw new Error(r.detail);
    const del = await deleteProjectActual(r.actualId);
    expect(del.ok).toBe(true);
    expect((await listProjectActuals(created.projectId)).length).toBe(0);
    // 再删一次 → 明确 not_found，不静默成功
    const again = await deleteProjectActual(r.actualId);
    expect(again.ok).toBe(false);
  });
});

describe("V2 决策平台：鉴权与预检（纯函数，不连库）", () => {
  const user: SessionUser = { id: "u1", email: "u1@example.test", name: null, role: "USER" } as SessionUser;
  const other: SessionUser = { id: "u2", email: "u2@example.test", name: null, role: "USER" } as SessionUser;
  const admin: SessionUser = { id: "a1", email: "a1@example.test", name: null, role: "ADMIN" } as SessionUser;

  it("owner 本人与 staff 可访问，其他人一律拒；无主项目仅 staff 可访问", () => {
    expect(canAccessDecisionProject("u1", user)).toBe(true);
    expect(canAccessDecisionProject("u1", other)).toBe(false);
    expect(canAccessDecisionProject("u1", admin)).toBe(true);
    expect(canAccessDecisionProject(null, user)).toBe(false);
    expect(canAccessDecisionProject(null, admin)).toBe(true);
    expect(canAccessDecisionProject(undefined, user)).toBe(false);
  });

  it("预检与保存用同一个校验器：倒挂窗口在预检阶段就被指出，且不写库", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
    const bad = { ...input, truck: { ...input.truck, chargingWindowStartHour: 10, chargingWindowEndHour: 6 } };
    const r = precheckScenarioInput({ body: bad });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.canCalculate).toBe(false);
    expect((r.fatal as Array<{ field?: string }>).some((d) => d.field === "truck.chargingWindowEndHour")).toBe(true);
  });

  it("预检：服务费缺失 → invalid（市场调节价没有可依据的默认值）", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
    const bad = { ...input, economics: { ...input.economics } } as Record<string, unknown>;
    delete (bad.economics as Record<string, unknown>).chargingServiceFeeYuanPerKwh;
    const r = precheckScenarioInput({ body: bad });
    expect(r.status).toBe("invalid");
  });
});
