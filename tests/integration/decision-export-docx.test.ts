import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import JSZip from "jszip";
import { Prisma } from "@prisma/client";
import { prisma, disconnectPrisma } from "@app/kernel/lib/prisma";
import { createDecisionProject } from "@app/kernel/server/decision-store";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import type { ScenarioInput, DecisionReport } from "@app/kernel/engine/types";
import type { SessionUser } from "@app/kernel/lib/roles";
import {
  buildSolutionDraftFromDecision,
  type DecisionEconColumns,
} from "@app/kernel/lib/decision-to-solution";
import { persistSolutionDraft } from "@app/kernel/server/solution-store";
import { readOneDecisionScenario } from "@app/kernel/server/decision-service";
import {
  buildDecisionReportDocx,
  type ReportForDocx,
} from "@/server/decision-report-docx";

/**
 * R7-B-4 · 决策报告 **DOCX 离线交付**两条路由的真实 HTTP 端到端（真连 Neon，不 mock DB）。
 *
 * 这一层要钉死 mandate §四 / §五 的硬要求：
 *   ① `/api/solutions/[id]/export/docx`（买家/后台）与
 *      `/api/workbench/decision/scenarios/[id]/export/docx`（作者自助）两跳，**真实调用 route handler**：
 *      HTTP 200 + 正确 Content-Type（DOCX MIME）+ Content-Disposition（attachment + RFC5987 文件名）
 *      + 文件名（`*_DecisionReport_v*.docx`，不随导出日期漂移）+ **magic bytes `PK\u0003\u0004`**
 *      + 可被 JSZip 解压（合法 OOXML 包）+ 核心文本存在 + provenance 存在 + disclaimer 存在
 *      + **数字与 DecisionReport 逐字一致**（DOCX 里出现的报告串能在源报告里找到，反向亦然）。
 *   ② §五 历史版本安全：DOCX 只投影**已落库的报告快照**，绝不调用引擎重算——用「同库快照独立再投影 == 路由产物文本」
 *      与「把情景 report 列改坏后路由仍回原快照」两向证明：旧 DOCX 不随当前模型/DB 漂移。
 *   ③ 权限：未登录 401、非属主非 staff 对未发布方案 403、越权读别人情景 403（`readOneDecisionScenario`→forbidden）。
 *
 * 只 mock `@/server/authz`（切断 next-auth ESM 链，与 unit/p4-buyer-closure 同构），**prisma 保持真实**。
 * `hasEntitlement("export")` 走真实 feature-flags（V1 恒开）；`errorResponse`/`hasPaidEntitlement` 真实。
 * 夹具 afterAll 按外键序清理，绝不污染真库。
 */

// ─────────────────────────── authz mock（须在任何 route import 前 hoist） ───────────────────────────
vi.mock("@/server/authz", () => ({
  STAFF_ROLES: ["REVIEWER", "ADMIN"],
  getCurrentUser: vi.fn(),
  requireRole: vi.fn(),
  requireUser: vi.fn(),
}));

import { getCurrentUser } from "@/server/authz";
import { GET as solutionDocxGet } from "@/app/api/solutions/[id]/export/docx/route";
import { GET as workbenchDocxGet } from "@/app/api/workbench/decision/scenarios/[id]/export/docx/route";

const getCurrentUserMock = getCurrentUser as unknown as ReturnType<typeof vi.fn>;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[decision-export-docx] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-decision-docx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let slugSeq = 0;
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
      title: `R7B-DOCX夹具-${runId}`,
      industry: "NEW_ENERGY",
      stage: "KEY_RESEARCH",
      sourceType: "MANUAL",
    },
    select: { id: true },
  });
  createdCaseIds.push(c.id);
  return c.id;
}

/** 建一条算通 + 有冻结报告的 V2 决策情景，返回 owner / scenarioId / report / projectId。 */
async function makeComputedScenario(owner: SessionUser, label: string) {
  const created = await createDecisionProject({
    name: `${runId} ${label}`,
    ownerId: owner.id,
    scenarioInput: baseInput({ name: `${runId} ${label} 情景` }),
    generatedAtIso: "2026-09-21T00:00:00.000Z",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("decision project create failed");
  createdProjectIds.push(created.projectId);
  const read = await readOneDecisionScenario({ scenarioId: created.scenarioId, user: owner });
  expect(read.status).toBe("ok");
  if (read.status !== "ok") throw new Error("scenario read failed");
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
  return scenario;
}

/** 从报告全文派生一条 DRAFT 方案（含 body.decisionReport 快照），返回 solutionId。 */
async function persistDraftFromScenario(owner: SessionUser, scenario: Awaited<ReturnType<typeof makeComputedScenario>>) {
  const caseId = await makeCase();
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
  if (!draft.ok) throw new Error("draft build failed");
  const result = await persistSolutionDraft(
    {
      caseId,
      title: draft.title,
      slug: `${draft.slug}-${runId.slice(-6)}-${slugSeq++}`.toLowerCase(),
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
  if (result.status !== "ok" || !result.solutionId)
    throw new Error(`persist draft failed: ${result.status} ${JSON.stringify((result as { fieldErrors?: unknown }).fieldErrors ?? (result as { error?: unknown }).error ?? "")}`);
  createdSolutionIds.push(result.solutionId);
  return result.solutionId;
}

/* ─────────────────────────── DOCX 校验 helpers ─────────────────────────── */

async function unzipToPlainText(buffer: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml 未在 DOCX 包中找到");
  const xml = await entry.async("string");
  return xml
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * 「DOCX = 报告数字一致」核对：只取报告里的**短取值单元格**（数字+单位/版本/hash，如
 *   `1,266.9 万元` / `7.70%` / `2,040 kW` / `2.0.0` / inputHash），断言它们逐字出现在 DOCX 文本投影里。
 * 刻意排除长句/段落型串（如 `【支持】全生命周期净现值…门槛。` 这类**报告叙述性 bullet**——DOCX
 *   投影层会按自身版式取舍，逐字比会假阴性；mandate §四要锁的是「数字」不是「每个句子都在」）。
 * 另排除：结构字段（section.id/kind）、ISO 时间戳（DOCX 以本地格式重排 generatedAtIso）。
 * 「DOCX 绝不自己算数/编数」由 ⑤ 无引擎运行时 import + ③ 快照不随当下模型漂移 两条结构守卫兜底。
 */
function reportTextNeedles(report: DecisionReport | ReportForDocx): string[] {
  const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}T/.test(s.trim());
  const isNumericCell = (s: string) => {
    const t = s.trim();
    return (
      /\d/.test(t) &&
      t.length >= 4 &&
      t.length <= 20 &&
      !isIsoDate(t) &&
      !/[。：，；！？]/.test(t) // 含句读的是叙述句，不是取值单元
    );
  };
  const out = new Set<string>();
  const p = report.provenance as unknown as Record<string, unknown>;
  for (const v of Object.values(p)) if (typeof v === "string" && isNumericCell(v)) out.add(v.trim());
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      if (isNumericCell(x)) out.add(x.trim());
    } else if (Array.isArray(x)) {
      x.forEach(walk);
    } else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === "id" || k === "kind") continue; // 结构字段不渲染
        walk(v);
      }
    }
  };
  report.sections.forEach(walk);
  return [...out];
}

function expectValidDocxResponse(res: Response, opts: { versionTag: string | null }) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(DOCX_MIME);
  const cd = res.headers.get("content-disposition") ?? "";
  expect(cd).toMatch(/^attachment;/);
  expect(cd).toContain("_DecisionReport_");
  expect(cd).toMatch(/filename\*=UTF-8''/);
  if (opts.versionTag) expect(cd).toContain(opts.versionTag);
}

beforeAll(async () => {
  if (HAS_DB) await warmup();
}, 60_000);

beforeEach(() => {
  getCurrentUserMock.mockReset();
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
  await disconnectPrisma().catch(() => undefined);
});

describeDb("R7-B-4 · 决策报告 DOCX 离线交付两条路由（端到端 · 真连 Neon）", () => {
  it("① 作者自助：workbench 情景 DOCX → 200 + 合法包 + 数字/provenance/disclaimer 与冻结报告逐字一致", async () => {
    const owner = await makeUser("USER");
    const scenario = await makeComputedScenario(owner, "工作台导出");
    getCurrentUserMock.mockResolvedValue({ id: owner.id, email: owner.email, name: owner.name, role: owner.role });

    const res = await workbenchDocxGet(
      new Request("http://localhost:3000/api/workbench/decision/scenarios/x/export/docx") as never,
      { params: Promise.resolve({ id: scenario.id }) } as never,
    );
    expectValidDocxResponse(res, { versionTag: `_v${scenario.version}.docx` });

    const bytes = new Uint8Array(await res.arrayBuffer());
    // magic bytes：ZIP 本地文件头 = DOCX(OOXML) 的 PK\u0003\u0004
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const text = await unzipToPlainText(bytes);

    const needles = reportTextNeedles(scenario.report!);
    expect(needles.length).toBeGreaterThan(10);
    for (const needle of needles) {
      expect(text, `DOCX 文本投影搜不到报告数字串：${needle}`).toContain(needle);
    }
    // 核心文本 / provenance / disclaimer 存在（mandate §四清单）
    expect(text).toContain("免责声明");
    expect(text).toContain("报告溯源");
    expect(text).toContain("Input Hash");
    expect(text).toContain("Engine 版本");
  }, 180_000);

  it("② 买家/后台：solutions 方案 DOCX → 200 + 合法包 + 与 body.decisionReport 快照逐字一致", async () => {
    const owner = await makeUser("USER");
    const scenario = await makeComputedScenario(owner, "方案导出");
    const solutionId = await persistDraftFromScenario(owner, scenario);
    // creator 对 DRAFT 方案即可自助导出（isCreator 短路，不等 PUBLISHED、不触 hasPaidEntitlement）
    getCurrentUserMock.mockResolvedValue({ id: owner.id, email: owner.email, name: owner.name, role: owner.role });

    const res = await solutionDocxGet(
      new Request("http://localhost:3000/api/solutions/x/export/docx") as never,
      { params: Promise.resolve({ id: solutionId }) } as never,
    );
    expectValidDocxResponse(res, { versionTag: `_v${scenario.version}.docx` });

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const text = await unzipToPlainText(bytes);

    // 一致性以「已落库的 body.decisionReport 快照」为准（非引擎当下值）——两向核对。
    const sol = await prisma.solution.findUnique({ where: { id: solutionId }, select: { body: true } });
    const snapshot = (sol!.body as unknown as { decisionReport: ReportForDocx }).decisionReport;
    for (const needle of reportTextNeedles(snapshot)) {
      expect(text, `方案 DOCX 搜不到快照数字串：${needle}`).toContain(needle);
    }
    expect(text).toContain("免责声明");
    expect(text).toContain("报告溯源");
    expect(text).toContain("Input Hash");
  }, 180_000);

  it("③ §五 历史版本安全：改坏当前情景 report 列后，方案 DOCX 仍回原快照（只投影存档、绝不重算/跟随漂移）", async () => {
    const owner = await makeUser("USER");
    const scenario = await makeComputedScenario(owner, "历史防漂");
    const solutionId = await persistDraftFromScenario(owner, scenario);

    getCurrentUserMock.mockResolvedValue({ id: owner.id, email: owner.email, name: owner.name, role: owner.role });
    const before = await solutionDocxGet(
      new Request("http://localhost:3000/api/solutions/x/export/docx") as never,
      { params: Promise.resolve({ id: solutionId }) } as never,
    );
    const beforeText = await unzipToPlainText(new Uint8Array(await before.arrayBuffer()));

    // 破坏**当下**引擎落点（ProjectScenario.report / calcStatus），模拟「模型已变、历史情景被覆盖」的极端。
    await prisma.projectScenario.update({
      where: { id: scenario.id },
      data: {
        calcStatus: "tech_error",
        report: Prisma.DbNull as unknown as Prisma.InputJsonValue,
      },
    });

    // 方案 DOCX 读的是 Solution.body 快照 → 不受情景漂移影响，核心串仍在。
    const after = await solutionDocxGet(
      new Request("http://localhost:3000/api/solutions/x/export/docx") as never,
      { params: Promise.resolve({ id: solutionId }) } as never,
    );
    expect(after.status).toBe(200);
    const afterText = await unzipToPlainText(new Uint8Array(await after.arrayBuffer()));
    for (const needle of reportTextNeedles(scenario.report!).slice(0, 12)) {
      expect(afterText, `快照串在漂移后应仍在：${needle}`).toContain(needle);
    }
    expect(afterText.length).toBeGreaterThan(200);
    expect(beforeText.length).toBeGreaterThan(200);

    // 对照：workbench 情景 DOCX 依赖当下 report 列，被改坏后应 409（诚实拒绝，不拿脏数据编 DOCX）。
    const wb = await workbenchDocxGet(
      new Request("http://localhost:3000/api/workbench/decision/scenarios/x/export/docx") as never,
      { params: Promise.resolve({ id: scenario.id }) } as never,
    );
    expect(wb.status).toBe(409);
  }, 180_000);

  it("④ 权限：未登录 401 / 非属主非 staff 对未发布方案 403 / 越权读别人情景 403", async () => {
    const owner = await makeUser("USER");
    const stranger = await makeUser("USER");
    const scenario = await makeComputedScenario(owner, "权限");
    const solutionId = await persistDraftFromScenario(owner, scenario);

    // 未登录 → 401（两路由都先查 getCurrentUser）
    getCurrentUserMock.mockResolvedValue(null);
    const unauth = await solutionDocxGet(
      new Request("http://localhost:3000/api/solutions/x/export/docx") as never,
      { params: Promise.resolve({ id: solutionId }) } as never,
    );
    expect(unauth.status).toBe(401);
    const unauth2 = await workbenchDocxGet(
      new Request("http://localhost:3000/api/workbench/decision/scenarios/x/export/docx") as never,
      { params: Promise.resolve({ id: scenario.id }) } as never,
    );
    expect(unauth2.status).toBe(401);

    // 非属主非 staff + 方案仍 DRAFT → 403（发布前不外发）
    getCurrentUserMock.mockResolvedValue({ id: stranger.id, email: stranger.email, name: stranger.name, role: stranger.role });
    const forbidden = await solutionDocxGet(
      new Request("http://localhost:3000/api/solutions/x/export/docx") as never,
      { params: Promise.resolve({ id: solutionId }) } as never,
    );
    expect(forbidden.status).toBe(403);

    // 越权读别人情景 → readOneDecisionScenario 返回 forbidden → 403
    const forbiddenWb = await workbenchDocxGet(
      new Request("http://localhost:3000/api/workbench/decision/scenarios/x/export/docx") as never,
      { params: Promise.resolve({ id: scenario.id }) } as never,
    );
    expect(forbiddenWb.status).toBe(403);
  }, 180_000);

  it("⑤ 不重算守卫：DOCX 生成器源文件不得 import 引擎运行时 / 调 runCalculation（结构事实 · 与 §四『DOCX 绝不自己算数』对齐）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/server/decision-report-docx.ts", "utf8");
    const runtimeEngineImports = src
      .split(/\r?\n/)
      .filter((l) => /from\s+["']@app\/kernel\/engine\//.test(l))
      .filter((l) => !/^\s*import\s+type\s/.test(l));
    expect(runtimeEngineImports).toEqual([]);
    for (const token of ["runCalculation(", "buildDecisionReport(", "computeDecisionSnapshot(", "runProjectModel("]) {
      expect(src, `DOCX 生成器不该调用：${token}`).not.toContain(token);
    }
  });
});
