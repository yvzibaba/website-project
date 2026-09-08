import { describe, it, expect, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  createProject,
  updateScenarioLayers,
  saveScenarioAsVersion,
  restoreScenarioFromVersion,
  getProjectWithScenarios,
  listScenarioVersions,
  type StoredParamLayers,
} from "@/server/sandbox-store";

/**
 * 集成测试（真连 Neon，中途重构 R3）：证 §14 #2「项目模型」持久层**真的落库、真的按 §4 命脉重算**。
 *
 * 关键：不 mock DB。断言「改参数 → 重跑引擎 → 落库的 calcResult + Decimal 汇总列随之变」这条链在
 *   持久层成立（而非只搬页面数字）；并证情景版本冻结 + 回滚（回滚走重算）。
 * 隔离：项目 name 带唯一 runId 前缀，afterAll 按前缀 + 已捕获 projectId 双兜底级联删（含 ChangeLog）。
 *   无 DATABASE_URL 自动 skip。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) console.warn("[sandbox-store] DATABASE_URL not set — integration tests will be skipped.");

const num = (d: unknown): number | null => (d == null ? null : Number(d));

describeDb("sandbox-store 项目/情景/版本持久层（Neon Postgres）", () => {
  const runId = `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projectIds: string[] = [];
  const regionIds: string[] = [];
  const actor = `human:${runId}`;

  afterAll(async () => {
    if (projectIds.length > 0) {
      await prisma.project
        .deleteMany({ where: { id: { in: projectIds } } })
        .catch(() => undefined);
      await prisma.changeLog
        .deleteMany({ where: { entityType: "Project", entityId: { in: projectIds } } })
        .catch(() => undefined);
    }
    await prisma.project
      .deleteMany({ where: { name: { startsWith: runId } } })
      .catch(() => undefined);
    if (regionIds.length > 0) {
      await prisma.region.deleteMany({ where: { id: { in: regionIds } } }).catch(() => undefined);
    }
    await disconnectPrisma();
  });

  it("createProject：建项目 + 基线情景，现算落库 calcStatus ok + Decimal 汇总列对齐 R2 golden", async () => {
    const res = await createProject({
      name: `${runId}-base`,
      description: "基线光储充重卡沙盘",
      actor,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    projectIds.push(res.projectId);

    const project = await getProjectWithScenarios(res.projectId);
    expect(project).not.toBeNull();
    expect(project!.scenarios).toHaveLength(1);
    const sc = project!.scenarios[0];
    expect(sc.isBaseline).toBe(true);
    expect(sc.calcStatus).toBe("ok");
    expect(sc.calcRef).toBe("model@1.1.0");
    // Decimal 汇总列（净 CAPEX / NPV / IRR% / 折现回收 / ROI）逐项对齐引擎（R9.0：含 Δ_sto=27,491）
    expect(num(sc.capexNet)).toBeCloseTo(3524500, 0);
    expect(num(sc.npv)).toBeCloseTo(4448573, 0);
    expect(num(sc.irrPct)).toBeCloseTo(24.3497, 3);
    expect(num(sc.paybackYears)).toBeCloseTo(5.14, 2);
    expect(num(sc.roiRatio)).toBeCloseTo(4.0880, 3);
    // calcResult JSON 快照也真落库且带 needsProfessionalReview（§16）
    const snap = sc.calcResult as { needsProfessionalReview?: boolean; metrics?: { npv?: number } };
    expect(snap.needsProfessionalReview).toBe(true);
    expect(num(snap.metrics?.npv)).toBeCloseTo(4448573, 0);

    // 一条 CREATE 审计
    const logs = await prisma.changeLog.findMany({
      where: { entityType: "Project", entityId: res.projectId, action: "CREATE" },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].changedBy).toBe(actor);
  });

  it("createProject：initialLayers 改参数 → 落库汇总列即变（§4 命脉持久化）+ 空名 invalid", async () => {
    const base = await createProject({ name: `${runId}-cmp-base`, actor });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    projectIds.push(base.projectId);
    const baseSc = (await getProjectWithScenarios(base.projectId))!.scenarios[0];
    const baseNpv = num(baseSc.npv)!;

    const hi = await createProject({
      name: `${runId}-cmp-hi`,
      initialLayers: { user: { values: { "project.chargingPrice": 1.2 } } },
      actor,
    });
    expect(hi.ok).toBe(true);
    if (!hi.ok) return;
    projectIds.push(hi.projectId);
    const hiSc = (await getProjectWithScenarios(hi.projectId))!.scenarios[0];
    // 单价从 0.9 抬到 1.2 → 收入增 → NPV 明显更高（同一引擎、只改参数）
    expect(num(hiSc.npv)!).toBeGreaterThan(baseNpv);

    // 空名拒绝、不写库
    const bad = await createProject({ name: "   ", actor });
    expect(bad).toEqual({ ok: false, reason: "invalid", detail: "项目名称不能为空" });
  });

  it("updateScenarioLayers：改参数重跑 → NPV 升 + version 递增 + UPDATE 审计", async () => {
    const created = await createProject({ name: `${runId}-upd`, actor });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    projectIds.push(created.projectId);
    const scenarioId = created.scenarioId;
    const before = (await getProjectWithScenarios(created.projectId))!.scenarios[0];
    const beforeNpv = num(before.npv)!;
    expect(before.version).toBe(1);

    const upd = await updateScenarioLayers(
      scenarioId,
      { user: { values: { "project.chargingPrice": 1.3 } } },
      { actor },
    );
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.calcStatus).toBe("ok");
    expect(upd.version).toBe(2);

    const after = (await getProjectWithScenarios(created.projectId))!.scenarios[0];
    expect(num(after.npv)!).toBeGreaterThan(beforeNpv);
    expect(after.version).toBe(2);

    const logs = await prisma.changeLog.findMany({
      where: { entityType: "Project", entityId: created.projectId, action: "UPDATE" },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("updateScenarioLayers：越界单价被裁剪到边界仍算得出（clamp 不致失败，非缺参）", async () => {
    const created = await createProject({ name: `${runId}-clamp`, actor });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    projectIds.push(created.projectId);
    // chargingPrice 远超 max 3.0 → 参数引擎裁到 3.0，经济层仍可完整计算（calcStatus 仍 ok、汇总列非 null）。
    // （缺经济键的失败路径无法经 resolveSandbox 造出——R1.2 模板全键皆有占位默认，故此处验裁剪而非缺键。）
    const upd = await updateScenarioLayers(
      created.scenarioId,
      { user: { values: { "project.chargingPrice": 999 } } },
      { actor },
    );
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.calcStatus).toBe("ok");
    const sc = (await getProjectWithScenarios(created.projectId))!.scenarios[0];
    expect(num(sc.npv)).not.toBeNull();
  });

  it("版本冻结 + 回滚：saveAsVersion seq 递增，restore 重算回旧参数态；跨情景回滚 forbidden", async () => {
    const created = await createProject({
      name: `${runId}-ver`,
      initialLayers: { user: { values: { "project.chargingPrice": 1.2 } } },
      actor,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    projectIds.push(created.projectId);
    const scenarioId = created.scenarioId;
    const npv12 = num((await getProjectWithScenarios(created.projectId))!.scenarios[0].npv)!;

    // v1 = chargingPrice 1.2
    const v1 = await saveScenarioAsVersion(scenarioId, { label: "单价1.2", savedBy: actor });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.seq).toBe(1);

    // 改到 1.5 → v2
    await updateScenarioLayers(scenarioId, { user: { values: { "project.chargingPrice": 1.5 } } }, { actor });
    const v2 = await saveScenarioAsVersion(scenarioId, { label: "单价1.5", savedBy: actor });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.seq).toBe(2);
    const npv15 = num((await getProjectWithScenarios(created.projectId))!.scenarios[0].npv)!;
    expect(npv15).toBeGreaterThan(npv12);

    const timeline = await listScenarioVersions(scenarioId);
    expect(timeline.map((t) => t.seq)).toEqual([2, 1]);

    // 回滚到 v1（1.2）→ 重算 → NPV 回到 npv12；version 递增（建=1 → 改1.5=2 → 回滚=3）
    const restored = await restoreScenarioFromVersion(scenarioId, v1.versionId, { actor });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.calcStatus).toBe("ok");
    const after = (await getProjectWithScenarios(created.projectId))!.scenarios[0];
    expect(num(after.npv)!).toBeCloseTo(npv12, 0);
    expect(after.version).toBe(3);

    // 跨情景回滚：另建一个项目，拿它的 scenarioId 去 restore 本项目版本 → forbidden
    const other = await createProject({ name: `${runId}-ver-other`, actor });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    projectIds.push(other.projectId);
    const forb = await restoreScenarioFromVersion(other.scenarioId, v1.versionId, { actor });
    expect(forb.ok).toBe(false);
    if (!forb.ok) expect(forb.reason).toBe("forbidden");
  });

  it("getProjectWithScenarios：不存在 → null；listScenarioVersions：无版本 → []", async () => {
    expect(await getProjectWithScenarios("cuid-does-not-exist-000000")).toBeNull();
    const created = await createProject({ name: `${runId}-noversion`, actor });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    projectIds.push(created.projectId);
    expect(await listScenarioVersions(created.scenarioId)).toEqual([]);
  });

  it("createProject：regionId 非规范 Region 行（沙盘地区包代码）→ 不报 P2003、诚实置空（§17 E2E 回归）", async () => {
    // "shanxi" 是 sandbox-regions 的内存包代码，不是 Region 表行——旧实现塞进外键会 500。
    const res = await createProject({
      name: `${runId}-badregion`,
      regionId: "shanxi",
      actor,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    projectIds.push(res.projectId);
    const proj = await prisma.project.findUnique({ where: { id: res.projectId }, select: { regionId: true } });
    expect(proj?.regionId).toBeNull();
    // 地区真值仍完整存于情景分层（paramSnapshot 里含 region 层），未因置空外键而丢失。
    const sc = (await getProjectWithScenarios(res.projectId))!.scenarios[0];
    expect(sc.calcStatus).toBe("ok");
  });

  it("createProject：regionId 确有其 Region 行 → 外键正常落地（护栏不误伤合法链接）", async () => {
    const region = await prisma.region.create({
      data: { name: `沙盘E2E地区-${runId}`, code: `SBX-${runId}`.slice(0, 24) },
      select: { id: true },
    });
    regionIds.push(region.id);
    const res = await createProject({
      name: `${runId}-realregion`,
      regionId: region.id,
      actor,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    projectIds.push(res.projectId);
    const proj = await prisma.project.findUnique({ where: { id: res.projectId }, select: { regionId: true } });
    expect(proj?.regionId).toBe(region.id);
  });
});

// 保证 StoredParamLayers 类型被使用（避免未用告警的同时锁定导出契约）。
const _typeCheck: StoredParamLayers = {};
void _typeCheck;

/* ─────────── 冻结策略集成测试（创始人裁决 2026-09-08，STORE_VERSION 1.0.3，零 schema 变更） ───────────
 * 覆盖验收 6 条：旧版本可查看（冻结数字原样提取）；新模型运行生成新版本（同事务自动冻结旧成功结果）；
 * 旧版本数字不变（ProjectVersion 绝不就地改写）；新旧版本各自 model/storage 版本可辨（缺键=none）；
 * 历史版本不被静默覆盖；重新打开项目可恢复旧版本（回滚重算语义不变）。
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */
describeDb("sandbox-store 内核升级冻结策略（真连 Neon）", () => {
  const runId = `sbxfz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projectIds: string[] = [];
  const actor = `human:${runId}`;

  afterAll(async () => {
    if (projectIds.length > 0) {
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => undefined);
      await prisma.changeLog
        .deleteMany({ where: { entityType: "Project", entityId: { in: projectIds } } })
        .catch(() => undefined);
    }
    await prisma.project.deleteMany({ where: { name: { startsWith: runId } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  async function baselineScenarioOf(projectId: string) {
    return prisma.projectScenario.findFirstOrThrow({ where: { projectId, isBaseline: true } });
  }

  it("同内核普通参数编辑 → 不自动冻结（version++ 就地覆盖仍是 §4 日常路径，不产生冗余版本）", async () => {
    const created = await createProject({ name: `${runId}-same`, actor });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    projectIds.push(created.projectId);
    const sc = await baselineScenarioOf(created.projectId);

    const res = await updateScenarioLayers(sc.id, {}, { actor });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.frozenSeq).toBeUndefined();

    const versions = await listScenarioVersions(sc.id);
    expect(versions).toHaveLength(0);
  });

  it("模型升级后重存（calcRef model@1.0.0 → 1.1.0）→ 旧 ok 结果自动冻结，数字逐字段不变、storage=none、可恢复", async () => {
    const created = await createProject({ name: `${runId}-up`, actor });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    projectIds.push(created.projectId);
    const sc = await baselineScenarioOf(created.projectId);

    // 把当前态改写成「1.0.0 旧模型产物」（模拟升级前的历史行：engineVersions 无 storage 键）。
    const legacyResult = {
      ok: true,
      calcRef: "model@1.0.0",
      engineVersions: { model: "1.0.0", tech: "1.0.0", finance: "1.0.0", params: "1.1.0" },
      capex: { net: 111.11 },
      opexY1: { gross: 22.22 },
      metrics: {
        npv: 333.33,
        irr: { ok: true, value: 0.05 },
        discountedPaybackYears: 4.5,
        roi: { ok: true, value: 0.25 },
      },
      needsProfessionalReview: true,
    };
    await prisma.projectScenario.update({
      where: { id: sc.id },
      data: { calcRef: "model@1.0.0", calcResult: legacyResult },
    });

    // 新引擎（model@1.1.0）重算 → 必须先冻结旧结果再覆写。
    const res = await updateScenarioLayers(sc.id, {}, { actor });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.frozenSeq).toBe(1);

    // 版本时间线：冻结行可查看，摘要为原样提取（不重算）。
    const versions = await listScenarioVersions(sc.id);
    expect(versions).toHaveLength(1);
    const v0 = versions[0];
    expect(v0.seq).toBe(1);
    expect(v0.calcRef).toBe("model@1.0.0");
    expect(v0.note).toContain("自动冻结");
    expect(v0.frozen.calcStatus).toBe("ok");
    expect(v0.frozen.engineVersions.model).toBe("1.0.0");
    expect(v0.frozen.engineVersions.storage).toBeNull(); // 旧模型行无 SVE 版本键 → API 层映射 "none"
    expect(v0.frozen.capexNet).toBe("111.11");
    expect(v0.frozen.opexY1Gross).toBe("22.22");
    expect(v0.frozen.npv).toBe("333.33");
    expect(v0.frozen.irrPct).toBe("5.0000");
    expect(v0.frozen.paybackYears).toBe("4.50");
    expect(v0.frozen.roiRatio).toBe("0.2500");

    // 当前态已落新引擎结果（version++）。
    const after = await prisma.projectScenario.findUniqueOrThrow({ where: { id: sc.id } });
    expect(after.calcRef).toBe("model@1.1.0");
    expect(after.version).toBe(sc.version + 1);

    // 冻结行是独立快照，绝不因后续写入被就地改写。
    const frozenRow = await prisma.projectVersion.findUniqueOrThrow({
      where: { scenarioId_seq: { scenarioId: sc.id, seq: 1 } },
    });
    expect(frozenRow.calcRef).toBe("model@1.0.0");
    expect((frozenRow.calcResult as { capex: { net: number } }).capex.net).toBe(111.11);

    // 回滚仍可用（R6.3 重算语义）：恢复旧版本参数 → 当前态重算；同内核重存不产生新冻结。
    const restored = await restoreScenarioFromVersion(sc.id, frozenRow.id, { actor });
    expect(restored.ok).toBe(true);
    const versionsAfterRestore = await listScenarioVersions(sc.id);
    expect(versionsAfterRestore).toHaveLength(1);
  });

  it("同 calcRef 但 engineVersions 指纹变化（历史行缺 storage 键）→ 同样触发冻结（旧行受保护）", async () => {
    const created = await createProject({ name: `${runId}-ev`, actor });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    projectIds.push(created.projectId);
    const sc = await baselineScenarioOf(created.projectId);

    // 模拟「1.1.0 首日行」：calcRef 不变，但 engineVersions 没有 storage 键（本批部署前落库）。
    const cur = await prisma.projectScenario.findUniqueOrThrow({ where: { id: sc.id } });
    const stripped = JSON.parse(JSON.stringify(cur.calcResult ?? {})); // 深拷贝成可写 JSON（any，直喂 Prisma Json 列）
    delete (stripped.engineVersions as Record<string, unknown> | undefined)?.storage;
    await prisma.projectScenario.update({ where: { id: sc.id }, data: { calcResult: stripped } });

    const res = await updateScenarioLayers(sc.id, {}, { actor });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.frozenSeq).toBe(1);

    const versions = await listScenarioVersions(sc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].frozen.engineVersions.model).toBe("1.1.0");
    expect(versions[0].frozen.engineVersions.storage).toBeNull();
  });
});
