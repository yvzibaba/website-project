import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { getSitemapEntries, SITEMAP_PER_TYPE } from "@/server/seo";
import { DEMO_SOURCE_TYPE } from "@/server/demo";

/**
 * 集成测试：sitemap 数据层 getSitemapEntries（真连 Neon，Phase 14 M1）。
 *
 * 验证「应进 sitemap 的公开 URL 枚举」与公开可见性/DEMO 门控一致（宪法第 20 条）：
 *   - 真实公开案例（DEEP_CASE+，非 DEMO）→ 出现 /cases/<id>；
 *   - 已发布方案（其关联案例非 DEMO）→ 出现 /solutions/<id>；
 *   - 内部阶段案例（CANDIDATE）→ 不出现；
 *   - DEMO 案例 → 不出现；
 *   - 挂在 DEMO 案例下的已发布方案 → 不出现（solutionDemoVisibility 顺 case 排除）。
 *
 * 与 cases-solutions.test.ts 同策略：一次性临时数据 + afterAll 全量清理，断言只看"我建的行"，
 * 对库里其它行（seed 的 DEMO 等）鲁棒。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  console.warn("[seo] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-seo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const ids = {
  region: "",
  publicCase: "",
  demoCase: "",
  candidateCase: "",
  pubSolution: "",
  demoSolution: "",
};

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

describeDb("seo getSitemapEntries (Neon)", () => {
  beforeAll(async () => {
    await warmup();
    const region = await prisma.region.create({ data: { name: `SEO测试地区-${runId}`, country: "CN" } });
    ids.region = region.id;

    const pubCase = await prisma.case.create({
      data: {
        title: `SEO真实公开案例-${runId}`,
        industry: "NEW_ENERGY",
        regionId: region.id,
        sourceType: "新闻",
        stage: "DEEP_CASE",
      },
    });
    ids.publicCase = pubCase.id;

    const demoCase = await prisma.case.create({
      data: {
        title: `【DEMO】SEO演示案例-${runId}`,
        industry: "NEW_ENERGY",
        regionId: region.id,
        sourceType: DEMO_SOURCE_TYPE,
        stage: "DEEP_CASE",
      },
    });
    ids.demoCase = demoCase.id;

    const candCase = await prisma.case.create({
      data: { title: `SEO候选案例-${runId}`, industry: "NEW_ENERGY", sourceType: "新闻", stage: "CANDIDATE" },
    });
    ids.candidateCase = candCase.id;

    const pubSol = await prisma.solution.create({
      data: {
        title: `SEO已发布方案-${runId}`,
        slug: `it-seo-sol-${runId}`,
        caseId: pubCase.id,
        status: "PUBLISHED",
        price: "999.00",
        currency: "CNY",
        publishedAt: new Date(),
      },
    });
    ids.pubSolution = pubSol.id;

    // 挂在 DEMO 案例下的已发布方案 → 应被 solutionDemoVisibility 顺 case 排除
    const demoSol = await prisma.solution.create({
      data: {
        title: `SEO演示方案-${runId}`,
        slug: `it-seo-demosol-${runId}`,
        caseId: demoCase.id,
        status: "PUBLISHED",
        price: "0.00",
        currency: "CNY",
        publishedAt: new Date(),
      },
    });
    ids.demoSolution = demoSol.id;
  }, 120_000);

  afterAll(async () => {
    await prisma.solution
      .deleteMany({ where: { id: { in: [ids.pubSolution, ids.demoSolution].filter(Boolean) } } })
      .catch(() => undefined);
    await prisma.case
      .deleteMany({ where: { id: { in: [ids.publicCase, ids.demoCase, ids.candidateCase].filter(Boolean) } } })
      .catch(() => undefined);
    await prisma.region.deleteMany({ where: { id: ids.region || "__none__" } }).catch(() => undefined);
    await prisma.solution.deleteMany({ where: { slug: { contains: runId } } }).catch(() => undefined);
    await prisma.case.deleteMany({ where: { title: { contains: runId } } }).catch(() => undefined);
    await disconnectPrisma();
  });

  it("包含真实公开案例与已发布方案 URL，带 lastModified", async () => {
    const entries = await getSitemapEntries();
    const paths = entries.map((e) => e.path);
    expect(paths).toContain(`/cases/${ids.publicCase}`);
    expect(paths).toContain(`/solutions/${ids.pubSolution}`);
    const caseEntry = entries.find((e) => e.path === `/cases/${ids.publicCase}`)!;
    expect(caseEntry.lastModified).toBeInstanceOf(Date);
  }, 60_000);

  it("排除内部阶段案例、DEMO 案例，以及挂在 DEMO 案例下的方案", async () => {
    const entries = await getSitemapEntries();
    const paths = new Set(entries.map((e) => e.path));
    expect(paths.has(`/cases/${ids.candidateCase}`)).toBe(false); // CANDIDATE 非公开阶段
    expect(paths.has(`/cases/${ids.demoCase}`)).toBe(false); // DEMO 排除
    expect(paths.has(`/solutions/${ids.demoSolution}`)).toBe(false); // 关联 DEMO 案例的方案排除
  }, 60_000);

  it("path 均为站内相对路径（以 /cases/ 或 /solutions/ 开头），不含绝对域名", async () => {
    const entries = await getSitemapEntries();
    for (const e of entries) {
      expect(/^\/(cases|solutions)\//.test(e.path)).toBe(true);
      expect(e.path.startsWith("http")).toBe(false);
    }
  }, 60_000);

  it("SITEMAP_PER_TYPE 为正整数上限兜底", () => {
    expect(Number.isInteger(SITEMAP_PER_TYPE)).toBe(true);
    expect(SITEMAP_PER_TYPE).toBeGreaterThan(0);
    expect(SITEMAP_PER_TYPE).toBeLessThanOrEqual(50000);
  });
});
