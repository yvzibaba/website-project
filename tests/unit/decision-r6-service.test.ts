import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * R6 · M13 服务层（编排/鉴权）单测（**离线**：整层 mock decision-store，绝不触库、绝不重算）。
 *
 * 守的是四条一旦破就极隐蔽、且直接决定"这条闭环安不安全"的契约（§24/§3/§5/§16）：
 *   ① 只读已存预测，**绝不重算**：analyze/detect/landscape 全程不碰 computeDecisionSnapshot /
 *      runCalculation——黄金基线与"当前模型会不会偷偷改历史结论"的安全边界正系于此。
 *   ② 鉴权 owner-or-staff：非属主非员工一律 forbidden；跨项目情景注入（scenarioId 属他项目）被拒。
 *   ③ 审核人只从会话取：review 落库的 reviewedBy 恒为 `human:<userId>`，绝不信客户端传的审核人。
 *   ④ 跨项目聚合只看自己：landscape 的项目集合来自 listDecisionProjects(当前用户)，绝不窥他人数据。
 *
 * 偏差分析纯函数用真实实现（来自 deviation，零依赖），仅数据库与存储层被 mock。
 */

const h = vi.hoisted(() => ({
  store: {
    computeDecisionSnapshot: vi.fn(),
    readDecisionProject: vi.fn(),
    readDecisionScenario: vi.fn(),
    listDecisionScenarios: vi.fn(),
    listDecisionProjects: vi.fn(),
    listProjectActuals: vi.fn(),
    upsertProjectActual: vi.fn(),
    deleteProjectActual: vi.fn(),
    addDecisionScenario: vi.fn(),
    createDecisionProject: vi.fn(),
    deleteDecisionScenario: vi.fn(),
    recalculateDecisionScenario: vi.fn(),
    saveDecisionScenarioAsVersion: vi.fn(),
    listDecisionScenarioVersions: vi.fn(),
    upsertCalibrationCandidates: vi.fn(),
    listCalibrationCandidates: vi.fn(),
    readCalibrationCandidate: vi.fn(),
    reviewCalibrationCandidate: vi.fn(),
  },
}));
vi.mock("@app/kernel/server/decision-store", () => h.store);

import {
  analyzeProjectForecastVsActual,
  detectAndPersistCandidates,
  listProjectCalibrationCandidates,
  reviewCandidate,
  calibrationLandscape,
  DECISION_SERVICE_VERSION,
} from "@app/kernel/server/decision-service";
import type { SessionUser } from "@app/kernel/lib/roles";

import { runCalculation } from "@app/kernel/engine/engine";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import { buildForecastSnapshot } from "@app/kernel/engine/deviation";
import type { ForecastSnapshot } from "@app/kernel/engine/deviation";

const S = h.store;

const owner: SessionUser = { id: "u-owner", email: "o@x.io", name: "Owner", role: "USER" };
const other: SessionUser = { id: "u-other", email: "p@x.io", name: "Other", role: "USER" };
const staff: SessionUser = { id: "u-staff", email: "s@x.io", name: "Staff", role: "REVIEWER" };

function forecastFixture(): ForecastSnapshot {
  const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: 0.5, templateId: "pv-bess-tou", name: "svc测试" });
  const out = runCalculation(input);
  if (!out.ok) throw new Error("前置不成立：默认情景必须算通");
  return buildForecastSnapshot(out);
}

/** 一条被"算通"的 V2 情景（带存档预测快照）。 */
function scenarioRow(over: Record<string, unknown> = {}) {
  return {
    id: "scn-1",
    projectId: "prj-1",
    name: "基线",
    isBaseline: true,
    calcStatus: "ok",
    forecastSnapshot: forecastFixture(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ───────────── ① 只读预测、不重算 + ② 鉴权 ───────────── */

describe("R6 · analyzeProjectForecastVsActual（只读、不重算、鉴权）", () => {
  it("owner 读自己的项目：返回 analysis + impacts，且**从不调用** computeDecisionSnapshot（不重算）", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.listDecisionScenarios.mockResolvedValue([{ id: "scn-1", isBaseline: true, calcStatus: "ok" }]);
    S.readDecisionScenario.mockResolvedValue(scenarioRow());
    S.listProjectActuals.mockResolvedValue([
      { scenarioId: null, periodYear: 2026, periodMonth: 1, pvGenerationKwh: 1 },
    ]);

    const res = await analyzeProjectForecastVsActual({ projectId: "prj-1", user: owner });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.hasForecastSnapshot).toBe(true);
    expect(res.analysis).toBeTruthy();
    expect(Array.isArray(res.impacts)).toBe(true);
    // 关键：分析走已存快照，一次都不重算
    expect(S.computeDecisionSnapshot).not.toHaveBeenCalled();
  });

  it("非属主非员工 → forbidden，且不动任何数据", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    const res = await analyzeProjectForecastVsActual({ projectId: "prj-1", user: other });
    expect(res.status).toBe("forbidden");
    expect(S.listProjectActuals).not.toHaveBeenCalled();
    expect(S.computeDecisionSnapshot).not.toHaveBeenCalled();
  });

  it("STAFF 放行（可跨项目复核）", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.listDecisionScenarios.mockResolvedValue([{ id: "scn-1", isBaseline: true, calcStatus: "ok" }]);
    S.readDecisionScenario.mockResolvedValue(scenarioRow());
    S.listProjectActuals.mockResolvedValue([]);
    const res = await analyzeProjectForecastVsActual({ projectId: "prj-1", user: staff });
    expect(res.status).toBe("ok");
  });

  it("项目不存在 → not_found", async () => {
    S.readDecisionProject.mockResolvedValue(null);
    const res = await analyzeProjectForecastVsActual({ projectId: "ghost", user: owner });
    expect(res.status).toBe("not_found");
  });

  it("越权注入他项目情景：scenarioId 的 projectId 不匹配 → invalid（绝不拿别人的情景来对照）", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.readDecisionScenario.mockResolvedValue({ ...scenarioRow(), projectId: "prj-VICTIM" });
    const res = await analyzeProjectForecastVsActual({ projectId: "prj-1", scenarioId: "scn-theirs", user: owner });
    expect(res.status).toBe("invalid");
    expect(S.listProjectActuals).not.toHaveBeenCalled();
  });

  it("无预测快照：hasForecastSnapshot=false、forecastAvailable=false（诚实而非假装有数）", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.listDecisionScenarios.mockResolvedValue([{ id: "scn-1", isBaseline: true, calcStatus: "ok" }]);
    S.readDecisionScenario.mockResolvedValue(scenarioRow({ forecastSnapshot: null }));
    S.listProjectActuals.mockResolvedValue([]);
    const res = await analyzeProjectForecastVsActual({ projectId: "prj-1", user: owner });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.hasForecastSnapshot).toBe(false);
    expect((res.analysis as { forecastAvailable: boolean }).forecastAvailable).toBe(false);
  });
});

/* ───────────── detect：落库候选 + config 校验 ───────────── */

describe("R6 · detectAndPersistCandidates", () => {
  function detectMocks() {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.listDecisionScenarios.mockResolvedValue([{ id: "scn-1", isBaseline: true, calcStatus: "ok" }]);
    const f = forecastFixture();
    S.readDecisionScenario.mockResolvedValue(scenarioRow({ forecastSnapshot: f }));
    // 光伏连续偏低（拿月度预测 ×0.8，同月同口径），足以触发候选
    const pv = f.monthly.pvGenerationKwh;
    S.listProjectActuals.mockResolvedValue([
      { scenarioId: "scn-1", periodYear: 2026, periodMonth: 1, pvGenerationKwh: Math.round((pv[0] ?? 0) * 0.8) },
      { scenarioId: "scn-1", periodYear: 2026, periodMonth: 2, pvGenerationKwh: Math.round((pv[1] ?? 0) * 0.8) },
      { scenarioId: "scn-1", periodYear: 2026, periodMonth: 3, pvGenerationKwh: Math.round((pv[2] ?? 0) * 0.8) },
    ]);
    S.upsertCalibrationCandidates.mockResolvedValue({ ok: true, created: 1, upserted: 1 });
    S.listCalibrationCandidates.mockResolvedValue([{ id: "cand-1", metric: "pvGenerationKwh" }]);
  }

  it("检测→落库→回列表：写的是候选表（upsert），不重算、不改基准/引擎", async () => {
    detectMocks();
    const res = await detectAndPersistCandidates({ projectId: "prj-1", user: owner });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.detected).toBeGreaterThanOrEqual(1);
    expect(res.created).toBe(1);
    expect(Array.isArray(res.candidates)).toBe(true);
    expect(S.upsertCalibrationCandidates).toHaveBeenCalledTimes(1);
    expect(S.computeDecisionSnapshot).not.toHaveBeenCalled();
  });

  it("非属主 → forbidden，绝不落库", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    const res = await detectAndPersistCandidates({ projectId: "prj-1", user: other });
    expect(res.status).toBe("forbidden");
    expect(S.upsertCalibrationCandidates).not.toHaveBeenCalled();
  });

  it("config 结构非法（biasThresholdPct 越界 500）→ invalid，不落库", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    const res = await detectAndPersistCandidates({ projectId: "prj-1", user: owner, config: { biasThresholdPct: 500 } });
    expect(res.status).toBe("invalid");
    expect(S.upsertCalibrationCandidates).not.toHaveBeenCalled();
  });

  it("upsert 失败 → error 透传", async () => {
    detectMocks();
    S.upsertCalibrationCandidates.mockResolvedValue({ ok: false, reason: "error", detail: "库挂了" });
    const res = await detectAndPersistCandidates({ projectId: "prj-1", user: owner });
    expect(res.status).toBe("error");
  });
});

/* ───────────── listProjectCalibrationCandidates ───────────── */

describe("R6 · listProjectCalibrationCandidates", () => {
  it("owner 列候选（透传 status 过滤）", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.listCalibrationCandidates.mockResolvedValue([{ id: "c" }]);
    const res = await listProjectCalibrationCandidates({ projectId: "prj-1", user: owner, status: "CANDIDATE" });
    expect(res.status).toBe("ok");
    expect(S.listCalibrationCandidates).toHaveBeenCalledWith({ projectId: "prj-1", status: "CANDIDATE" });
  });
  it("非属主 → forbidden", async () => {
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    const res = await listProjectCalibrationCandidates({ projectId: "prj-1", user: other });
    expect(res.status).toBe("forbidden");
  });
});

/* ───────────── ③ review：审核人只从会话取 + 归属鉴权 ───────────── */

describe("R6 · reviewCandidate（审核门 + 会话可信）", () => {
  it("owner 采纳候选：reviewedBy 恒为 human:<会话用户>，忽略客户端伪造", async () => {
    S.readCalibrationCandidate.mockResolvedValue({ id: "cand-1", projectId: "prj-1" });
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.reviewCalibrationCandidate.mockResolvedValue({ ok: true, id: "cand-1", status: "ACCEPTED" });

    const res = await reviewCandidate({
      candidateId: "cand-1",
      user: owner,
      body: { to: "ACCEPTED", note: "同意下调产能基准", reviewedBy: "hacker:999" } as never,
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.calibrationStatus).toBe("ACCEPTED");
    const arg = S.reviewCalibrationCandidate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.reviewedBy).toBe("human:u-owner"); // ★来自会话，非客户端
    expect(arg.reviewNote).toBe("同意下调产能基准");
  });

  it("body.to 非法 → invalid，不查候选", async () => {
    const res = await reviewCandidate({ candidateId: "cand-1", user: owner, body: { to: "MAYBE" } });
    expect(res.status).toBe("invalid");
    expect(S.readCalibrationCandidate).not.toHaveBeenCalled();
  });

  it("候选不存在 → not_found", async () => {
    S.readCalibrationCandidate.mockResolvedValue(null);
    const res = await reviewCandidate({ candidateId: "ghost", user: owner, body: { to: "ACCEPTED" } });
    expect(res.status).toBe("not_found");
  });

  it("非属主非员工 → forbidden，绝不调 store 迁移", async () => {
    S.readCalibrationCandidate.mockResolvedValue({ id: "cand-1", projectId: "prj-1" });
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    const res = await reviewCandidate({ candidateId: "cand-1", user: other, body: { to: "ACCEPTED" } });
    expect(res.status).toBe("forbidden");
    expect(S.reviewCalibrationCandidate).not.toHaveBeenCalled();
  });

  it("无 projectId 的区域聚合候选：任意登录用户拒，STAFF 放行", async () => {
    S.readCalibrationCandidate.mockResolvedValue({ id: "cand-2", projectId: null });
    S.reviewCalibrationCandidate.mockResolvedValue({ ok: true, id: "cand-2", status: "UNDER_REVIEW" });
    const denied = await reviewCandidate({ candidateId: "cand-2", user: owner, body: { to: "UNDER_REVIEW" } });
    expect(denied.status).toBe("forbidden");
    const allowed = await reviewCandidate({ candidateId: "cand-2", user: staff, body: { to: "UNDER_REVIEW" } });
    expect(allowed.status).toBe("ok");
  });

  it("store 判定非法迁移（已 ACCEPTED 回退）→ invalid 透传", async () => {
    S.readCalibrationCandidate.mockResolvedValue({ id: "cand-1", projectId: "prj-1" });
    S.readDecisionProject.mockResolvedValue({ id: "prj-1", ownerId: "u-owner" });
    S.reviewCalibrationCandidate.mockResolvedValue({ ok: false, reason: "invalid", detail: "不允许的状态迁移" });
    const res = await reviewCandidate({ candidateId: "cand-1", user: owner, body: { to: "CANDIDATE" } });
    expect(res.status).toBe("invalid");
  });
});

/* ───────────── ④ landscape：只聚合自己可访问的项目 ───────────── */

describe("R6 · calibrationLandscape（只扫可访问项目，绝不窥他人）", () => {
  it("项目集合取自 listDecisionProjects(当前用户)，同向偏差聚合成 systemic 桶", async () => {
    const f = forecastFixture();
    S.listDecisionProjects.mockResolvedValue([
      { id: "prj-1", baseline: { id: "scn-1" } },
      { id: "prj-2", baseline: { id: "scn-2" } },
    ]);
    S.readDecisionScenario.mockImplementation(async (id: string) =>
      scenarioRow({ id, projectId: id === "scn-1" ? "prj-1" : "prj-2", forecastSnapshot: f }),
    );
    const pv = f.monthly.pvGenerationKwh;
    S.listProjectActuals.mockImplementation(async () => [
      { scenarioId: null, periodYear: 2026, periodMonth: 1, pvGenerationKwh: Math.round((pv[0] ?? 0) * 0.75) },
      { scenarioId: null, periodYear: 2026, periodMonth: 2, pvGenerationKwh: Math.round((pv[1] ?? 0) * 0.75) },
    ]);

    const res = await calibrationLandscape({ user: owner });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    // 只按"当前用户可访问项目"取数
    expect(S.listDecisionProjects.mock.calls[0][0]).toBe(owner.id);
    expect((res.aggregates as Array<{ metric: string }>).some((a) => a.metric === "pvGenerationKwh")).toBe(true);
    expect(S.computeDecisionSnapshot).not.toHaveBeenCalled();
  });

  it("无可访问项目 → projectsScanned=0、aggregates 空", async () => {
    S.listDecisionProjects.mockResolvedValue([]);
    const res = await calibrationLandscape({ user: other });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.projectsScanned).toBe(0);
    expect(res.aggregates).toEqual([]);
  });
});

/* ───────────── 反证：版本常量 ───────────── */

describe("R6 · 反证：编排层版本升级、鉴权口径不变", () => {
  it("DECISION_SERVICE_VERSION = 1.2.0", () => {
    expect(DECISION_SERVICE_VERSION).toBe("1.2.0");
  });
});
