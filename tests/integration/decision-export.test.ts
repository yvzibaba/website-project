import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, disconnectPrisma } from "@app/kernel/lib/prisma";
import { createDecisionProject, readDecisionScenario } from "@app/kernel/server/decision-store";
import { readOneDecisionScenario } from "@app/kernel/server/decision-service";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import type { ScenarioInput, DecisionReport } from "@app/kernel/engine/types";
import type { SessionUser } from "@app/kernel/lib/roles";
import {
  buildSolutionDraftFromDecision,
  DECISION_TO_SOLUTION_VERSION,
  type DecisionEconColumns,
} from "@app/kernel/lib/decision-to-solution";
import { persistSolutionDraft, SOLUTION_STORE_VERSION } from "@app/kernel/server/solution-store";

/**
 * R7-A 集成测：V2 决策报告 → DRAFT 产业方案的**端到端**闭环（真连 Neon，不 mock）。
 *
 * 这一层要守住的是「**报告数字 == 商品数字**」是**结构性事实**、导出永远 DRAFT、越权在动库前即拒。
 * 具体锁：
 *   ① owner 导出：Solution 行 status=DRAFT + creatorId=会话用户；
 *   ② 财务 Decimal 串**逐字等于**同源 Decimal 派生列（搬运非重算，与 store 里已存的 econ 列对得上）；
 *   ③ body.decisionReport.sections **逐字等于** scenario.report.sections（全文保真、零裁剪、零换算）；
 *   ④ provenance 与 report.provenance 逐字段一致（供 UI 溯源展示的唯一来源）；
 *   ⑤ 非 owner → `readOneDecisionScenario` 返回 `forbidden`，路由在**动库前**即拒；
 *   ⑥ caseId 不存在 → `persistSolutionDraft` FK 预检诚实拦下（invalid.fieldErrors.caseId），绝不 500；
 *   ⑦ 失败情景（`calcStatus !== "ok"` 或 report 缺失）→ 映射层 `ok:false` + blockers，**不落库**。
 *
 * 401（未登录）与 CSRF 由 `requireUserWrite` 承担（V1 已测）；本测覆盖业务语义，不重复 HTTP 层。
 * 夹具 afterAll 按外键序：order → solution → case；再 project/scenario/user。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[decision-export] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-decision-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdUserIds: string[] = [];
const createdProjectIds: string[] = [];
const createdCaseIds: string[] = [];
const createdSolutionIds: string[] = [];

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

async function makeCase(): Promise<string> {
  const c = await prisma.case.create({
    data: {
      title: `R7A导出夹具-${runId}`,
      industry: "NEW_ENERGY",
      stage: "KEY_RESEARCH",
      sourceType: "MANUAL",
    },
    select: { id: true },
  });
  createdCaseIds.push(c.id);
  return c.id;
}

beforeAll(async () => {
  if (HAS_DB) await warmup();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await prisma.order
    .deleteMany({ where: { solutionId: { in: createdSolutionIds } } })
    .catch(() => undefined);
  await prisma.changeLog
    .deleteMany({ where: { entityId: { in: [...createdSolutionIds, ...createdCaseIds] } } })
    .catch(() => undefined);
  await prisma.solution.deleteMany({ where: { id: { in: createdSolutionIds } } }).catch(() => undefined);
  await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
  await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
  await prisma.calibrationCandidate
    .deleteMany({ where: { projectId: { in: createdProjectIds } } })
    .catch(() => undefined);
  await prisma.projectActual
    .deleteMany({ where: { projectId: { in: createdProjectIds } } })
    .catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
  await disconnectPrisma();
});

describeDb("R7-A · V2 决策报告导出 DRAFT 产业方案（端到端 · 真连 Neon）", () => {
  it("①-④ owner 导出 → DRAFT Solution + 财务=同源 Decimal 列 + body.decisionReport.sections 逐字 = report.sections", async () => {
    const owner = await makeUser("USER");
    const caseId = await makeCase();
    const created = await createDecisionProject({
      name: `${runId} 山西重卡导出`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} 基线` }),
      generatedAtIso: "2026-09-21T00:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdProjectIds.push(created.projectId);

    // 走路由会做的完全同一串：readOneDecisionScenario → buildSolutionDraftFromDecision → persistSolutionDraft
    const read = await readOneDecisionScenario({ scenarioId: created.scenarioId, user: owner });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    const scenario = read.scenario as {
      id: string;
      name: string;
      calcStatus: string;
      version: number;
      report: DecisionReport | null;
      scenarioInput: ScenarioInput | null;
      econ: DecisionEconColumns;
    };
    expect(scenario.calcStatus).toBe("ok");
    expect(scenario.report).not.toBeNull();
    // R7-A 加性暴露的 econ 派生列必须已在（readDecisionScenario 从同源 Decimal 列直接投出）
    expect(scenario.econ).toBeDefined();
    expect(scenario.econ.capexNetYuan).not.toBeNull();

    const draft = buildSolutionDraftFromDecision({
      report: scenario.report,
      scenarioInput: scenario.scenarioInput,
      econ: scenario.econ,
      calcStatus: scenario.calcStatus,
      scenarioName: scenario.name,
      scenarioVersion: scenario.version,
      caseId,
      price: "1999.00",
      currency: "CNY",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.draftVersion).toBe(DECISION_TO_SOLUTION_VERSION);

    const result = await persistSolutionDraft(
      {
        caseId,
        title: draft.title,
        slug: draft.slug,
        summary: draft.summary,
        body: draft.body,
        riskDomains: draft.riskDomains,
        needsProfessionalReview: draft.needsProfessionalReview,
        price: draft.price,
        currency: draft.currency,
        financials: draft.financials,
        unknowns: draft.unknowns,
        publishBlockers: draft.publishBlockers,
        sandboxSource: { scenarioId: scenario.id },
      },
      owner.email,
      { creatorId: owner.id },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !result.solutionId) return;
    createdSolutionIds.push(result.solutionId);
    expect(result.financialCount).toBe(1);

    // ★ 商品行：DRAFT、creatorId=会话用户（前端不许传）、price 与草案一致
    const sol = await prisma.solution.findUnique({
      where: { id: result.solutionId },
      select: { status: true, creatorId: true, caseId: true, price: true, currency: true, body: true },
    });
    expect(sol?.status).toBe("DRAFT");
    expect(sol?.creatorId).toBe(owner.id);
    expect(sol?.caseId).toBe(caseId);
    expect(sol?.price?.toString()).toBe("1999");
    expect(sol?.currency).toBe("CNY");

    // ★ 财务 Decimal 串逐字等于同源 econ 派生列
    const fin = await prisma.solutionFinancial.findFirst({
      where: { solutionId: result.solutionId },
      select: { capex: true, roiPct: true, irrPct: true, paybackYears: true },
    });
    const report = scenario.report!;
    const stored = await readDecisionScenario(created.scenarioId);
    expect(stored).not.toBeNull();
    const storedEcon = (stored as { econ: DecisionEconColumns }).econ;
    expect(fin?.capex?.toFixed(2)).toBe(storedEcon.capexNetYuan!.toFixed(2));
    expect(fin?.irrPct?.toFixed(4)).toBe(storedEcon.irrPct!.toFixed(4));
    expect(fin?.paybackYears?.toFixed(2)).toBe(storedEcon.paybackYears!.toFixed(2));
    // roiPct 与 roiRatio 是 100×：roiRatio=1.85 → 185.00（Decimal 4 位小数字符串化后按 numeric 存）
    expect(Number(fin?.roiPct?.toString())).toBeCloseTo(storedEcon.roiRatio! * 100, 4);

    // ★ body.decisionReport.sections 与 report.sections 逐字一致（全文保真）
    const solBody = sol?.body as { decisionReport?: { sections?: unknown; provenance?: unknown; disclaimer?: string } };
    expect(solBody?.decisionReport?.sections).toEqual(report.sections);
    expect(solBody?.decisionReport?.provenance).toEqual(report.provenance);
    expect(solBody?.decisionReport?.disclaimer).toBe(report.disclaimer);

    // ★ 关键假设多属低置信度 → 恒 ASSUMPTION + 需专业人工确认（不冒充事实）
    expect(draft.evidenceGrade).toBe("ASSUMPTION");
    expect(draft.needsProfessionalReview).toBe(true);
    expect(draft.publishBlockers.length).toBeGreaterThanOrEqual(2);
    // 版本常量对得上，方便审计追溯
    expect(SOLUTION_STORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("⑤ 非 owner 越权：readOneDecisionScenario → forbidden，路由在动库前即拒（不落 Solution 行）", async () => {
    const owner = await makeUser("USER");
    const stranger = await makeUser("USER");
    const created = await createDecisionProject({
      name: `${runId} 越权`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} 越权情景` }),
      generatedAtIso: "2026-09-21T00:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdProjectIds.push(created.projectId);

    const before = await prisma.solution.count();
    const read = await readOneDecisionScenario({ scenarioId: created.scenarioId, user: stranger });
    expect(read.status).toBe("forbidden");
    const after = await prisma.solution.count();
    expect(after).toBe(before); // 未新增任何 Solution 行
  });

  it("⑥ caseId 不存在 → persistSolutionDraft FK 预检诚实拦下 invalid.fieldErrors.caseId（绝不 500）", async () => {
    const owner = await makeUser("USER");
    const created = await createDecisionProject({
      name: `${runId} 假案例`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} 假案例情景` }),
      generatedAtIso: "2026-09-21T00:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdProjectIds.push(created.projectId);

    const read = await readOneDecisionScenario({ scenarioId: created.scenarioId, user: owner });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    const scenario = read.scenario as {
      id: string;
      name: string;
      calcStatus: string;
      version: number;
      report: DecisionReport | null;
      scenarioInput: ScenarioInput | null;
      econ: DecisionEconColumns;
    };

    const draft = buildSolutionDraftFromDecision({
      report: scenario.report,
      scenarioInput: scenario.scenarioInput,
      econ: scenario.econ,
      calcStatus: scenario.calcStatus,
      scenarioName: scenario.name,
      scenarioVersion: scenario.version,
      caseId: "c" + "a".repeat(25), // 结构合法的 cuid，但库里没有这一行 → FK 预检应拦下
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const result = await persistSolutionDraft(
      {
        caseId: "c" + "a".repeat(25),
        title: draft.title,
        slug: draft.slug,
        body: draft.body,
        financials: draft.financials,
        unknowns: draft.unknowns,
      },
      owner.email,
      { creatorId: owner.id },
    );
    expect(result.status).toBe("invalid");
    expect(result.fieldErrors?.caseId).toBeTruthy();
    // 未落库任何挂到假案例的 Solution（用 caseId 精确锚定，避免撞上一测的默认标题）
    const row = await prisma.solution.findFirst({ where: { caseId: "c" + "a".repeat(25) } });
    expect(row).toBeNull();
  });

  it("⑦ 失败情景（calcStatus!=='ok'）→ 映射层 ok:false + 阻塞项，不落库", async () => {
    const owner = await makeUser("USER");
    const caseId = await makeCase();
    const created = await createDecisionProject({
      name: `${runId} 失败导出`,
      ownerId: owner.id,
      scenarioInput: baseInput({ name: `${runId} 失败情景` }),
      generatedAtIso: "2026-09-21T00:00:00.000Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdProjectIds.push(created.projectId);

    // 直接把这一情景的存档改写成「算失败」状态：清空 report + 全部 Decimal 派生列，calcStatus 置 tech_error。
    // 这样映射层必然拒导（无论用户输入合不合法），断言与引擎侧口径解耦。
    await prisma.projectScenario.update({
      where: { id: created.scenarioId },
      data: {
        calcStatus: "tech_error",
        report: Prisma.DbNull as unknown as Prisma.InputJsonValue,
        decision: Prisma.DbNull as unknown as Prisma.InputJsonValue,
        capexNet: null,
        npv: null,
        irrPct: null,
        paybackYears: null,
        roiRatio: null,
        lcoeYuanPerKwh: null,
        npvEquity: null,
        irrEquityPct: null,
      },
    });

    const stored = await readDecisionScenario(created.scenarioId);
    expect(stored).not.toBeNull();
    if (!stored) return;
    expect(stored.calcStatus).not.toBe("ok");

    const draft = buildSolutionDraftFromDecision({
      report: (stored as { report: DecisionReport | null }).report,
      scenarioInput: (stored as { scenarioInput: ScenarioInput | null }).scenarioInput,
      econ: (stored as { econ: DecisionEconColumns }).econ,
      calcStatus: stored.calcStatus,
      scenarioName: stored.name,
      scenarioVersion: (stored as { version: number }).version,
      caseId,
    });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.error.reason).toBeTruthy();
    expect(draft.publishBlockers.length).toBeGreaterThanOrEqual(2);
    // 未生成任何挂到此夹具案例的 Solution（用 caseId 精确锚定）
    const row = await prisma.solution.findFirst({ where: { caseId } });
    expect(row).toBeNull();
  });
});
