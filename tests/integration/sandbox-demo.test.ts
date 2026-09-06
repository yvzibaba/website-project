import { describe, it, expect, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  createProject,
  getProjectWithScenarios,
  toEngineLayers,
  type StoredParamLayers,
} from "@/server/sandbox-store";
import { runSandboxModel } from "@/server/sandbox-model";
import {
  computeDemoScenario,
  defaultDemoState,
  serializeDemoLayers,
  deserializeDemoState,
  type DemoHeadlineState,
} from "@/server/sandbox-demo";

/**
 * 集成测试（真连 Neon，R8.8a）：证「示范项目参数模型」这条**简化入口 → 既有引擎 → 落库 → 重开**的整链
 * 在持久层真实成立、且**改任一核心参数即整链重算**（验收 #4/#5/#6/#9）。
 *
 * 关键点（不 mock DB）：
 *   1) 车队口径（重卡数量）经映射层折算成既有网关 trucksPerDay/chargePerTruck，服务端重算结果 ==
 *      客户端 `computeDemoScenario` 的 `CalcResult`（**重开一致 / §9 可复算**：同输入必得同结果）。
 *   2) 落库 Decimal 汇总列（净 CAPEX / NPV / IRR / 折现回收 / ROI）随核心参数即时变，且对齐客户端 metrics。
 *   3) `serializeDemoLayers` 塞进不透明 `paramLayers` 的 `demo` 块**穿越 JSON 往返保真**——重开时
 *      `deserializeDemoState` 精确还原 10 参数滑杆位 + touched（**零 schema 迁移**，对齐 R8.6 指针打法）。
 *   4) 示范默认态（无改动）存版 → 汇总列 == R1.2 既有黄金基线（**零 churn**，端到端不碰旧口径 / 不 bump MODEL_VERSION）。
 *
 * 隔离：项目 name 带唯一 runId 前缀，afterAll 按前缀 + 已捕获 projectId 双兜底级联删（含 ChangeLog）。
 *   无 DATABASE_URL 自动 skip（对齐 sandbox-store 集成测）。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) console.warn("[sandbox-demo] DATABASE_URL not set — integration tests will be skipped.");

const num = (d: unknown): number | null => (d == null ? null : Number(d));
const NOW = new Date("2026-01-01T00:00:00.000Z"); // 固定时钟：政策窗口判定确定化（§9）

describeDb("R8.8a 示范项目模型 · 存版→重开一致（Neon Postgres）", () => {
  const runId = `sbxdemo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projectIds: string[] = [];
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
    await disconnectPrisma();
  });

  it("改车队规模存版 → 服务端重算==客户端整链、demo 块往返保真、汇总列对齐（验收 #4/#5/#6/#9）", async () => {
    const state: DemoHeadlineState = { ...defaultDemoState(), truckCount: 120, regionId: "shanxi" };
    const touched: { truckCount: true } = { truckCount: true };
    const scn = computeDemoScenario(state, touched, NOW);

    // 映射层前置校验：车队口径折算回既有网关键。
    expect(scn.userValues["project.trucksPerDay"]).toBe(120);
    // 里程 / 百公里电耗未动 → chargePerTruck 仍 250 → 日充电量 = 120×250 = 30000。
    expect(scn.resolved.numeric["derived.dailyChargeEnergy"]).toBe(120 * 250);
    expect(scn.calc.ok).toBe(true);
    if (!scn.calc.ok) return;

    const layers = serializeDemoLayers(scn) as unknown as StoredParamLayers;
    const res = await createProject({
      name: `${runId}-save`,
      description: "R8.8a 示范存版重开一致",
      regionId: "shanxi",
      initialLayers: layers,
      actor,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    projectIds.push(res.projectId);

    const proj = await getProjectWithScenarios(res.projectId);
    expect(proj).not.toBeNull();
    const sc = proj!.scenarios[0];
    expect(sc.isBaseline).toBe(true);
    expect(sc.calcStatus).toBe("ok");
    expect(sc.calcRef).toBe("model@1.0.0");

    // (1) 重开一致：用**落库的 paramLayers** 回放喂引擎 → CalcResult 深等于客户端当初算的那份（§9 可复算）。
    const replayLayers = toEngineLayers(sc.paramLayers as StoredParamLayers);
    const replayCalc = runSandboxModel(replayLayers);
    expect(replayCalc).toEqual(scn.calc);

    // (2) 落库 Decimal 汇总列对齐客户端指标（NPV / ROI / IRR 真变、非 null）。
    const m = scn.calc.metrics;
    expect(num(sc.npv)).not.toBeNull();
    expect(num(sc.npv)!).toBeCloseTo(m.npv, 0);
    expect(num(sc.capexNet)!).toBeCloseTo(scn.calc.capex.net, 0);
    if (m.roi.ok && typeof m.roi.value === "number") expect(num(sc.roiRatio)!).toBeCloseTo(m.roi.value, 3);
    if (m.irr.ok && typeof m.irr.value === "number") expect(num(sc.irrPct)!).toBeCloseTo(m.irr.value * 100, 3);

    // (3) demo 块穿越不透明 JSON 往返保真 → 重开精确还原 10 参数滑杆位 + touched（零 schema 迁移）。
    const round = deserializeDemoState(sc.paramLayers);
    expect(round).not.toBeNull();
    expect(round!.state).toEqual(state);
    expect(round!.touched).toEqual({ truckCount: true });
  });

  it("改任一其它核心参数（光伏装机）→ 汇总列相对车队态再变（证「改核心即整链重算」非巧合）", async () => {
    const a = computeDemoScenario({ ...defaultDemoState(), truckCount: 120 }, { truckCount: true }, NOW);
    const b = computeDemoScenario(
      { ...defaultDemoState(), truckCount: 120, pvCapacity: 3000 },
      { truckCount: true, pvCapacity: true },
      NOW,
    );
    expect(b.userValues["project.pvCapacity"]).toBe(3000);
    // 光伏装机抬升 → CAPEX 变大（总投资作为输出随之变）。
    const aGross = a.calc.ok ? a.calc.capex.gross : NaN;
    const bGross = b.calc.ok ? b.calc.capex.gross : NaN;
    expect(bGross).toBeGreaterThan(aGross);

    const res = await createProject({
      name: `${runId}-pv`,
      initialLayers: serializeDemoLayers(b) as unknown as StoredParamLayers,
      actor,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    projectIds.push(res.projectId);
    const sc = (await getProjectWithScenarios(res.projectId))!.scenarios[0];
    expect(sc.calcStatus).toBe("ok");
    // 服务端净 CAPEX 与客户端 b 一致（再次坐实重开一致）。
    expect(num(sc.capexNet)!).toBeCloseTo(b.calc.ok ? b.calc.capex.net : NaN, 0);
  });

  it("示范默认态（无改动）存版 → 汇总列 == R1.2 既有黄金基线（端到端零 churn）", async () => {
    const scn = computeDemoScenario(defaultDemoState(), {}, NOW);
    const res = await createProject({
      name: `${runId}-default`,
      initialLayers: serializeDemoLayers(scn) as unknown as StoredParamLayers,
      actor,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    projectIds.push(res.projectId);
    const sc = (await getProjectWithScenarios(res.projectId))!.scenarios[0];
    // 数字焊自 sandbox-store 集成基线（全国通用、无覆写）：证明打开示范模型、什么都不改 == 既有基线。
    expect(num(sc.capexNet)!).toBeCloseTo(3524500, 0);
    expect(num(sc.npv)!).toBeCloseTo(4277409, 0);
    expect(num(sc.irrPct)!).toBeCloseTo(23.7553, 3);
    expect(num(sc.paybackYears)!).toBeCloseTo(5.28, 2);
    expect(num(sc.roiRatio)!).toBeCloseTo(4.0035, 3);
    const snap = sc.calcResult as { needsProfessionalReview?: boolean };
    expect(snap.needsProfessionalReview).toBe(true);
  });
});
