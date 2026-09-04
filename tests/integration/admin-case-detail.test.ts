import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { getAdminCaseDetail } from "@/server/admin-cases";
import { DEMO_SOURCE_TYPE } from "@/server/demo";

/**
 * 集成测试：案例「后台详情」读层 getAdminCaseDetail（Phase 13 M5），真连 Neon，不 mock。
 *
 * 覆盖 M5 编辑台所依赖、而公开 getPublicCaseById 刻意不给的读能力：
 *   ① 任意阶段（含 CANDIDATE / KEY_RESEARCH 内部中间态）都可读到，不受公开橱窗 DEEP_CASE+ 门控；
 *   ② evidences 明细逐条透传（type / grade / statement / sourceUrl / sourceType / confidence），
 *      null 字段保留 null（宪法第 7 条：可信度/来源可追溯，缺省就是缺省、不伪造 0）；
 *   ③ evidenceCount = evidences.length（实时，可计算事实），solutionCount 取全量、
 *      publishedSolutionCount **只数 PUBLISHED**（删除守卫的判定依据）；
 *   ④ isDemo 由案例自身 sourceType=DEMO_FIXTURE 判定；行业 enum→中文名映射；
 *   ⑤ 评分标量快照（opportunityScore / evidenceConfidence）与 hasScoreBreakdown 一并透传（只读，录入留 M5b）；
 *   ⑥ notFound 与「读失败」可区分：合法形状但库无行 → notFound；非法形状 id → notFound、不抛裸异常。
 * 夹具 afterAll 按外键序 solution→evidence→case + entityId 清理。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[admin-case-detail] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-admnncasedetail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdCaseIds: string[] = [];
function track(id?: string) {
  if (id) createdCaseIds.push(id);
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

describeDb("admin case detail read-layer (Neon)", () => {
  let realCaseId = "";
  let demoCaseId = "";

  beforeAll(async () => {
    await warmup();

    // 真实候选案例（CANDIDATE——公开橱窗不可见，正是后台读层存在的理由）：
    // 3 条证据，覆盖「全字段」「缺 grade/confidence/来源」「缺 sourceUrl」三种形态。
    const realCase = await prisma.case.create({
      data: {
        title: `详情-候选案例-${runId}`,
        titleEn: `Detail Candidate ${runId}`,
        summary: "一段中文摘要",
        sourceUrl: "https://example.com/src",
        sourceType: "MANUAL",
        industry: "NEW_ENERGY",
        stage: "CANDIDATE",
        opportunityScore: 73,
        evidenceConfidence: 55,
        scoreBreakdown: { total: 73, dims: {} } as object,
        evidences: {
          create: [
            { type: "FACT", grade: "A", statement: "实测度电成本 0.42 元", sourceUrl: "https://example.com/annual-report", sourceType: "年报", confidence: 90 },
            { type: "ASSUMPTION", statement: "假设补贴延续三年", confidence: 40 }, // 无 grade / sourceUrl / sourceType
            { type: "PREDICTION", grade: "D", statement: "预测 2027 年IRR 12%", sourceType: "AI 推断" }, // 无 confidence → null
          ],
        },
      },
      select: { id: true },
    });
    realCaseId = realCase.id;
    track(realCase.id);

    // 关联 2 个方案：一个已发布（计入 publishedSolutionCount，触发删除守卫），一个草稿。
    await prisma.solution.create({
      data: { title: `详情-已发布方案-${runId}`, slug: `it-admnncasedetail-pub-${runId}`, caseId: realCase.id, status: "PUBLISHED", price: "1999.00", currency: "CNY" },
    });
    await prisma.solution.create({
      data: { title: `详情-草稿方案-${runId}`, slug: `it-admnncasedetail-dft-${runId}`, caseId: realCase.id, status: "DRAFT" },
    });

    // DEMO 夹具案例（应在后台可见并标 isDemo=true）
    const demoCase = await prisma.case.create({
      data: { title: `【DEMO】详情-夹具-${runId}`, industry: "OTHER", stage: "KEY_RESEARCH", sourceType: DEMO_SOURCE_TYPE },
      select: { id: true },
    });
    demoCaseId = demoCase.id;
    track(demoCase.id);
  });

  afterAll(async () => {
    await prisma.solution.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.evidence.deleteMany({ where: { caseId: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { id: { in: createdCaseIds } } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { slug: { contains: runId } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await prisma.changeLog.deleteMany({ where: { entityId: { in: createdCaseIds } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("内部阶段（CANDIDATE）可全量读到 + 行业映射中文名 + 版本/评分标量透传", async () => {
    const res = await getAdminCaseDetail(realCaseId);
    expect(res.ok).toBe(true);
    const c = res.data;
    expect(c).not.toBeNull();
    expect(c!.stage).toBe("CANDIDATE"); // 后台不受公开 DEEP_CASE+ 门控
    expect(c!.title).toContain(`候选案例-${runId}`);
    expect(c!.titleEn).toContain(`Detail Candidate ${runId}`);
    expect(c!.summary).toBe("一段中文摘要");
    expect(c!.sourceUrl).toBe("https://example.com/src");
    expect(c!.industry).toBe("NEW_ENERGY");
    expect(c!.industryName).toBeTruthy();
    expect(c!.industryName).not.toBe("NEW_ENERGY"); // 中文名而非枚举字面量
    expect(c!.industrySlug).toBeTruthy();
    expect(c!.isDemo).toBe(false);
    expect(c!.opportunityScore).toBe(73);
    expect(c!.evidenceConfidence).toBe(55);
    expect(c!.hasScoreBreakdown).toBe(true);
    expect(c!.version).toBeGreaterThanOrEqual(1);
  });

  it("evidences 逐条透传、null 字段诚实保留；evidenceCount = 实时条数", async () => {
    const res = await getAdminCaseDetail(realCaseId);
    const evs = res.data!.evidences;
    expect(evs.length).toBe(3);
    expect(res.data!.evidenceCount).toBe(3);

    const fact = evs.find((e) => e.statement.includes("度电成本"));
    expect(fact?.type).toBe("FACT");
    expect(fact?.grade).toBe("A");
    expect(fact?.confidence).toBe(90);
    expect(fact?.sourceUrl).toBe("https://example.com/annual-report");
    expect(fact?.sourceType).toBe("年报");

    const assumption = evs.find((e) => e.type === "ASSUMPTION");
    expect(assumption?.grade).toBeNull(); // 缺省就是 null，不伪造
    expect(assumption?.sourceUrl).toBeNull();
    expect(assumption?.sourceType).toBeNull();
    expect(assumption?.confidence).toBe(40);

    const prediction = evs.find((e) => e.type === "PREDICTION");
    expect(prediction?.confidence).toBeNull(); // 未填置信度 → null（非 0）
    expect(prediction?.grade).toBe("D");
    expect(prediction?.sourceUrl).toBeNull();
  });

  it("solutionCount 取全量、publishedSolutionCount 只数 PUBLISHED（删除守卫依据）", async () => {
    const res = await getAdminCaseDetail(realCaseId);
    expect(res.data!.solutionCount).toBe(2);
    expect(res.data!.publishedSolutionCount).toBe(1);
  });

  it("isDemo 由案例自身 sourceType 判定：DEMO_FIXTURE → true；无评分明细 → hasScoreBreakdown=false", async () => {
    const res = await getAdminCaseDetail(demoCaseId);
    expect(res.ok).toBe(true);
    expect(res.data!.isDemo).toBe(true);
    expect(res.data!.evidences).toHaveLength(0);
    expect(res.data!.evidenceCount).toBe(0);
    expect(res.data!.opportunityScore).toBeNull();
    expect(res.data!.hasScoreBreakdown).toBe(false);
  });

  it("notFound 与读失败可区分：库无行 / 非法形状 id 均 notFound、不抛", async () => {
    const missing = await getAdminCaseDetail("c" + "a".repeat(24)); // 合法长度但库无行
    expect(missing.notFound).toBe(true);
    expect(missing.ok).toBe(false);
    expect(missing.data).toBeNull();
    const badShape = await getAdminCaseDetail("nope"); // 太短/非法形状
    expect(badShape.notFound).toBe(true);
    expect(badShape.error).toBeUndefined();
  });
});
