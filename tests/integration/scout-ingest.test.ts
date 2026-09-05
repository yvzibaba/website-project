import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import { ingestCandidate } from "@/server/scout-ingest";

/**
 * 集成测试：Scout 落库编排 `scout-ingest.ts`（Phase 10 M2），真连 Neon、不 mock。
 *
 * 覆盖（注入确定性候选、无网络，故无论是否配令牌皆可复算）：
 *   ① 新建仓库 → 落库带最保守 NOT_REVIEWED + 三检查位 false、去重键规范化、写 CREATE 审计；
 *   ② 同仓库不同 URL 写法 → 命中同一条（repoUrl @unique 去重），更新而非重复插入；
 *   ③ **人工已 APPROVED/已实测的条目被重抓时，其 review 态与检查位不被冲掉**（第 11 条法律门在人身上，
 *      这是本里程碑最重要的治理不变式）；
 *   ④ 脏候选 → invalid 且不写库。夹具 afterAll 按 runId 前缀全清。
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const describeDb = HAS_DB ? describe : describe.skip;
if (!HAS_DB) {
  console.warn("[scout-ingest] DATABASE_URL not set — skipping. Run with: npm run test:integration");
}

const runId = `it-scout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ids: string[] = [];

async function warmup() {
  for (let i = 0; i < 4; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

beforeAll(async () => {
  await warmup();
});

afterAll(async () => {
  try {
    for (const id of ids) {
      await prisma.changeLog.deleteMany({ where: { entityType: "OpenSourceProject", entityId: id } }).catch(() => {});
      await prisma.openSourceProject.delete({ where: { id } }).catch(() => {});
    }
    // 兜底：按本次 runId 前缀清掉任何漏记的行。
    await prisma.openSourceProject
      .deleteMany({ where: { repoUrl: { contains: runId } } })
      .catch(() => {});
  } finally {
    await disconnectPrisma();
  }
});

describeDb("scout-ingest（真连 Neon）", () => {
  it("① 新建：落 NOT_REVIEWED + 三检查位 false + 去重键规范化 + CREATE 审计", async () => {
    const repoUrl = `https://github.com/${runId}/react-like`;
    const res = await ingestCandidate(
      { name: `${runId}/react-like`, repoUrl, owner: runId, stars: 100, licenseType: "MIT" },
      "scout:test",
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    ids.push(res.id);
    expect(res.created).toBe(true);
    expect(res.readyForReuse).toBe(false);
    expect(res.licenseVerdict).toBe("needs_human_review");

    const row = await prisma.openSourceProject.findUnique({ where: { id: res.id } });
    // 去重键保留 host、剥协议/www/.git/尾斜杠，整体小写（runId 本身已小写）。
    expect(row?.repoUrl).toBe(`github.com/${runId}/react-like`);
    expect(row?.licenseType).toBe("MIT");
    expect(row?.licenseReviewStatus).toBe("NOT_REVIEWED");
    expect(row?.dependencyChecked).toBe(false);
    expect(row?.securityChecked).toBe(false);
    expect(row?.tested).toBe(false);
    expect(row?.version).toBe(1);

    const log = await prisma.changeLog.findFirst({
      where: { entityType: "OpenSourceProject", entityId: res.id, action: "CREATE" },
    });
    expect(log).not.toBeNull();
    expect(log?.changedBy).toBe("scout:test");
  });

  it("② 同仓库不同 URL 写法：命中同一条更新而非重复插入，version 自增", async () => {
    const base = `https://github.com/${runId}/dup-proj`;
    const r1 = await ingestCandidate({ name: `${runId}/dup-proj`, repoUrl: base, licenseType: "APACHE_2_0" }, "scout:test");
    expect(r1.status).toBe("ok");
    if (r1.status !== "ok") return;
    ids.push(r1.id);
    const firstId = r1.id;

    // 换写法（www + .git + 尾斜杠 + 大小写）再投 → 应命中同一条。
    const r2 = await ingestCandidate(
      { name: `${runId}/dup-proj`, repoUrl: `https://WWW.GitHub.com/${runId}/dup-proj.git/`, licenseType: "APACHE_2_0", stars: 5 },
      "scout:test",
    );
    expect(r2.status).toBe("ok");
    if (r2.status !== "ok") return;
    expect(r2.created).toBe(false);
    expect(r2.id).toBe(firstId);
    expect(r2.version).toBe(2);

    const count = await prisma.openSourceProject.count({ where: { id: firstId } });
    expect(count).toBe(1); // 没有第二行
  });

  it("③ 关键不变式：人工 APPROVED + 已实测的条目被重抓，review 态与检查位不被冲掉", async () => {
    const repoUrl = `https://github.com/${runId}/human-reviewed`;
    const init = await ingestCandidate({ name: `${runId}/human-reviewed`, repoUrl, stars: 10, licenseType: "GPL" }, "scout:test");
    expect(init.status).toBe("ok");
    if (init.status !== "ok") return;
    ids.push(init.id);

    // 模拟人做关键决策：批准许可证 + 标记已实测。
    await prisma.openSourceProject.update({
      where: { id: init.id },
      data: { licenseReviewStatus: "APPROVED", tested: true, dependencyChecked: true, securityChecked: true },
    });

    // Scout 重抓（stars 变了）→ 元数据刷新，但人工态必须原样保留。
    const again = await ingestCandidate({ name: `${runId}/human-reviewed`, repoUrl, stars: 999, licenseType: "GPL" }, "scout:re-crawl");
    expect(again.status).toBe("ok");
    if (again.status !== "ok") return;
    expect(again.id).toBe(init.id);

    const row = await prisma.openSourceProject.findUnique({ where: { id: init.id } });
    expect(row?.stars).toBe(999); // 客观元数据刷新了
    expect(row?.licenseReviewStatus).toBe("APPROVED"); // 人工批准没被冲掉
    expect(row?.tested).toBe(true);
    expect(row?.dependencyChecked).toBe(true);
    expect(row?.securityChecked).toBe(true);
  });

  it("④ 脏候选（缺 name）→ invalid，绝不写库", async () => {
    const before = await prisma.openSourceProject.count();
    const res = await ingestCandidate({ repoUrl: `https://github.com/${runId}/no-name` });
    expect(res.status).toBe("invalid");
    const after = await prisma.openSourceProject.count();
    expect(after).toBe(before);
  });
});
