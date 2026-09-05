import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 单元测试：Scout 落库编排 `scout-ingest.ts`（Phase 10 M2）。
 * mock 掉 prisma（无 DB），注入假 fetchRepo（无网络），把「治理判定复用 + 按去重键 upsert + 审计 +
 * 保留人工复核态」的编排契约离线测死。核心守护：新建落最保守 NOT_REVIEWED + 三检查位 false；
 * 更新**绝不把 licenseReviewStatus / 三检查位写进 data**（防冲掉人工裁决，第 11 条法律门在人身上）。
 */

const mockTx = vi.hoisted(() => ({
  openSourceProject: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  changeLog: { create: vi.fn() },
}));

// vi.mock 工厂被提升到文件顶，故用 vi.hoisted 造 mock 句柄供工厂与测试体共享引用。
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
    openSourceProject: mockTx.openSourceProject,
    changeLog: mockTx.changeLog,
  },
  disconnectPrisma: async () => {},
}));

import { ingestCandidate, ingestGitHubRepo } from "@/server/scout-ingest";
import { ScoutFetchError } from "@/server/scout-github";

const mitCandidate = {
  name: "facebook/react",
  repoUrl: "https://github.com/facebook/react",
  owner: "facebook",
  stars: 220000,
  licenseType: "MIT",
};

function row(over: Partial<{ id: string; version: number; licenseReviewStatus: string }> = {}) {
  return {
    id: over.id ?? "osp_1",
    name: "facebook/react",
    repoUrl: "github.com/facebook/react",
    owner: "facebook",
    stars: 220000,
    licenseType: "MIT",
    licenseReviewStatus: over.licenseReviewStatus ?? "NOT_REVIEWED",
    licenseNote: null,
    dependencyChecked: false,
    securityChecked: false,
    tested: false,
    lastCheckedAt: new Date(),
    version: over.version ?? 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ingestCandidate（不经网络，直接评估 + 落库）", () => {
  it("新仓库 → create 落 NOT_REVIEWED + 三检查位 false，写 CREATE 审计，created:true", async () => {
    mockTx.openSourceProject.findUnique.mockResolvedValue(null);
    mockTx.openSourceProject.create.mockResolvedValue(row());

    const res = await ingestCandidate(mitCandidate, "scout:test");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.created).toBe(true);
    expect(res.licenseVerdict).toBe("needs_human_review"); // 未复核永不自动放行（第 11 条）
    expect(res.readyForReuse).toBe(false);
    expect(res.blockers.length).toBeGreaterThan(0);

    const createArg = mockTx.openSourceProject.create.mock.calls[0][0].data;
    expect(createArg.repoUrl).toBe("github.com/facebook/react"); // 去重键规范化
    expect(createArg.licenseType).toBe("MIT");
    expect(createArg.licenseReviewStatus).toBe("NOT_REVIEWED");
    expect(createArg.dependencyChecked).toBe(false);
    expect(createArg.securityChecked).toBe(false);
    expect(createArg.tested).toBe(false);
    expect(mockTx.changeLog.create).toHaveBeenCalledTimes(1);
    expect(mockTx.changeLog.create.mock.calls[0][0].data.entityType).toBe("OpenSourceProject");
    expect(mockTx.changeLog.create.mock.calls[0][0].data.action).toBe("CREATE");
    expect(mockTx.changeLog.create.mock.calls[0][0].data.changedBy).toBe("scout:test");
  });

  it("已存在 → update 只刷新元数据，**绝不带 licenseReviewStatus / 三检查位**，version 自增", async () => {
    mockTx.openSourceProject.findUnique.mockResolvedValue(row({ licenseReviewStatus: "APPROVED", version: 3 }));
    mockTx.openSourceProject.update.mockResolvedValue(row({ licenseReviewStatus: "APPROVED", version: 4 }));

    const res = await ingestCandidate({ ...mitCandidate, stars: 221000 }, "scout:test");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.created).toBe(false);
    expect(res.version).toBe(4);

    const updArg = mockTx.openSourceProject.update.mock.calls[0][0].data;
    // 人工已 APPROVED —— 重抓绝不能把它改回或动检查位。
    expect("licenseReviewStatus" in updArg).toBe(false);
    expect("dependencyChecked" in updArg).toBe(false);
    expect("securityChecked" in updArg).toBe(false);
    expect("tested" in updArg).toBe(false);
    expect(updArg.version).toEqual({ increment: 1 });
    expect(updArg.stars).toBe(221000);
    expect(mockTx.changeLog.create.mock.calls[0][0].data.action).toBe("UPDATE");
  });

  it("脏候选（缺 name）→ invalid，绝不写库（第 20 条）", async () => {
    const res = await ingestCandidate({ repoUrl: "https://github.com/a/b" });
    expect(res.status).toBe("invalid");
    expect(mockTx.openSourceProject.create).not.toHaveBeenCalled();
    expect(mockTx.openSourceProject.update).not.toHaveBeenCalled();
    expect(mockTx.changeLog.create).not.toHaveBeenCalled();
  });

  it("同仓库不同 URL 写法 → 去重键一致（github.com/owner/repo）", async () => {
    mockTx.openSourceProject.findUnique.mockResolvedValue(null);
    mockTx.openSourceProject.create.mockResolvedValue(row());
    const res = await ingestCandidate({ ...mitCandidate, repoUrl: "https://WWW.GitHub.com/facebook/react.git/" });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.dedupKey).toBe("github.com/facebook/react");
  });
});

describe("ingestGitHubRepo（抓取 → 判定 → 落库，注假 fetchRepo）", () => {
  it("成功：抓 MIT 仓库 → 落库 NOT_REVIEWED、licenseType=MIT、三检查位 false", async () => {
    mockTx.openSourceProject.findUnique.mockResolvedValue(null);
    mockTx.openSourceProject.create.mockResolvedValue(row());
    const fetchRepo = vi.fn(async () => ({
      full_name: "facebook/react",
      name: "react",
      html_url: "https://github.com/facebook/react",
      stargazers_count: 220000,
      license: { spdx_id: "MIT", name: "MIT License" },
      owner: { login: "facebook" },
    }));

    const res = await ingestGitHubRepo("facebook/react", "scout:test", { fetchRepo });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.candidate.licenseType).toBe("MIT");
    const createArg = mockTx.openSourceProject.create.mock.calls[0][0].data;
    expect(createArg.dependencyChecked).toBe(false);
    expect(createArg.licenseNote).toContain("MIT");
  });

  it("抓取失败（ScoutFetchError）→ fetch_error，绝不写库", async () => {
    const fetchRepo = vi.fn(async () => {
      throw new ScoutFetchError("GitHub 抓取失败：HTTP 404", 404);
    });
    const res = await ingestGitHubRepo("nope/nope", "scout:test", { fetchRepo });
    expect(res.status).toBe("fetch_error");
    if (res.status === "fetch_error") expect(res.httpStatus).toBe(404);
    expect(mockTx.openSourceProject.create).not.toHaveBeenCalled();
  });

  it("抓取通用异常 → error，绝不写库、不外溢", async () => {
    const fetchRepo = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = await ingestGitHubRepo("a/b", "scout:test", { fetchRepo });
    expect(res.status).toBe("error");
    expect(mockTx.openSourceProject.create).not.toHaveBeenCalled();
  });
});
