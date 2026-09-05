import { describe, it, expect, vi } from "vitest";

import {
  parseSpdxLicense,
  mapGitHubRepoToCandidate,
  parseRepoRef,
  fetchGitHubRepo,
  ScoutFetchError,
  SPDX_TO_LICENSE_TYPE,
  SCOUT_GITHUB_VERSION,
  type GithubFetch,
  type GitHubRepoLite,
} from "@/server/scout-github";

/**
 * 单元测试：GitHub Scout 输入管道 `scout-github.ts`（Phase 10 M2）。
 * 注入假 fetch → 无网络、无令牌也把 SPDX 归一 / 候选映射 / ref 解析 / 请求构造 / 错误归一整套契约离线测死。
 * 关键守护（第 20 条诚实 + 第 11 条法律门在人身上）：元数据缺失/无法判定时**保守回落**、
 * 映射产物**绝不假称已做依赖/安全/实测检查**。
 */

function okFetch(body: unknown): GithubFetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

describe("parseSpdxLicense（SPDX → LicenseType 保守归一）", () => {
  it("常量守护：SCOUT_GITHUB_VERSION 为语义化版本串", () => {
    expect(SCOUT_GITHUB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("映射表逐字覆盖已知枚举成员键（防漏）", () => {
    expect(SPDX_TO_LICENSE_TYPE["mit"]).toBe("MIT");
    expect(SPDX_TO_LICENSE_TYPE["apache-2.0"]).toBe("APACHE_2_0");
    expect(SPDX_TO_LICENSE_TYPE["agpl-3.0"]).toBe("AGPL");
    expect(SPDX_TO_LICENSE_TYPE["gpl-3.0"]).toBe("GPL");
  });

  it("无 license 对象 → UNKNOWN 且 licenseNote 说明未检测到", () => {
    const r = parseSpdxLicense(null);
    expect(r.licenseType).toBe("UNKNOWN");
    expect(r.licenseNote).toContain("未检测到");
  });

  it("NOASSERTION（GitHub 无法判定）→ OTHER（须人工），非猜测宽松", () => {
    const r = parseSpdxLicense({ spdx_id: "NOASSERTION", name: "Other" });
    expect(r.licenseType).toBe("OTHER");
    expect(r.licenseNote).toContain("NOASSERTION");
  });

  it("大小写/空格无关地命中已知 SPDX", () => {
    expect(parseSpdxLicense({ spdx_id: "  Apache-2.0 " }).licenseType).toBe("APACHE_2_0");
    expect(parseSpdxLicense({ spdx_id: "MIT" }).licenseType).toBe("MIT");
    expect(parseSpdxLicense({ spdx_id: "LGPL-2.1" }).licenseType).toBe("LGPL");
  });

  it("未识别 SPDX → OTHER 且 licenseNote 保留原始标识供人对照", () => {
    const r = parseSpdxLicense({ spdx_id: "weird-license-9000", name: "Weird" });
    expect(r.licenseType).toBe("OTHER");
    expect(r.licenseNote).toContain("weird-license-9000");
  });
});

describe("mapGitHubRepoToCandidate（元数据 → Scout 候选，不判能否用）", () => {
  it("完整仓库：映射 name/repoUrl/owner/stars/license，且刻意省略三检查位", () => {
    const repo: GitHubRepoLite = {
      full_name: "facebook/react",
      name: "react",
      html_url: "https://github.com/facebook/react",
      stargazers_count: 220000,
      license: { spdx_id: "MIT", name: "MIT License" },
      owner: { login: "facebook" },
    };
    const { candidate, licenseNote } = mapGitHubRepoToCandidate(repo);
    expect(candidate.name).toBe("facebook/react");
    expect(candidate.repoUrl).toBe("https://github.com/facebook/react");
    expect(candidate.owner).toBe("facebook");
    expect(candidate.stars).toBe(220000);
    expect(candidate.licenseType).toBe("MIT");
    expect(licenseNote).toContain("MIT");
    // 第 20 条：元数据不能证明扫描已完成 → 绝不在候选里出现三检查位（交 schema 落最保守 false）。
    expect("dependencyChecked" in candidate).toBe(false);
    expect("securityChecked" in candidate).toBe(false);
    expect("tested" in candidate).toBe(false);
    expect("licenseReviewStatus" in candidate).toBe(false);
  });

  it("无 owner.login 时从 full_name 推 owner/名，无 license 落 UNKNOWN", () => {
    const { candidate } = mapGitHubRepoToCandidate({ full_name: "torvalds/linux" });
    expect(candidate.owner).toBe("torvalds");
    expect(candidate.licenseType).toBe("UNKNOWN");
    // 无 html_url 时用 owner/repo 拼规范 URL。
    expect(candidate.repoUrl).toBe("https://github.com/torvalds/linux");
  });

  it("脏 stars（负数 / NaN）省略，不硬塞", () => {
    expect(mapGitHubRepoToCandidate({ full_name: "a/b", stargazers_count: -5 }).candidate.stars).toBeUndefined();
    expect(mapGitHubRepoToCandidate({ full_name: "a/b", stargazers_count: NaN }).candidate.stars).toBeUndefined();
    // 小数 stars 归一为整数（trunc）。
    expect(mapGitHubRepoToCandidate({ full_name: "a/b", stargazers_count: 10.7 }).candidate.stars).toBe(10);
  });
});

describe("parseRepoRef（owner/repo 或 URL → 结构化标识）", () => {
  it("接受 owner/repo 与完整 GitHub URL，忽略大小写、剥 .git/尾斜杠", () => {
    expect(parseRepoRef("facebook/react")).toEqual({ owner: "facebook", repo: "react" });
    expect(parseRepoRef("https://github.com/Owner/Repo.git")).toEqual({ owner: "Owner", repo: "Repo" });
    expect(parseRepoRef("  https://www.github.com/a/b/  ")).toEqual({ owner: "a", repo: "b" });
  });

  it("无斜杠 / 空串 / 非法字符 → null", () => {
    expect(parseRepoRef("justone")).toBeNull();
    expect(parseRepoRef("")).toBeNull();
    expect(parseRepoRef("  ")).toBeNull();
    expect(parseRepoRef("o/r/../x")).toBeNull();
  });
});

describe("fetchGitHubRepo（注入假 fetch，无网络）", () => {
  it("200：GET api.github.com/repos/{owner}/{repo}，带 Accept/UA，无令牌时不带 Authorization", async () => {
    const fetchImpl = okFetch({ full_name: "facebook/react", html_url: "https://github.com/facebook/react" });
    const data = await fetchGitHubRepo("facebook/react", { fetchImpl });
    expect(data.full_name).toBe("facebook/react");
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/facebook/react");
    expect(init.method).toBe("GET");
    expect(init.headers.Accept).toContain("github");
    expect(init.headers["User-Agent"]).toBeTruthy();
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("有令牌：注入 Bearer 头（但只在发出的请求里，不外泄）", async () => {
    const fetchImpl = okFetch({ full_name: "a/b" });
    await fetchGitHubRepo("a/b", { fetchImpl, token: "  secret123  " });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer secret123");
  });

  it("非 2xx → ScoutFetchError 带状态码，消息不含令牌/响应体", async () => {
    const fetchImpl: GithubFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "rate limited secret" }),
      text: async () => "rate limited secret",
    }));
    await expect(fetchGitHubRepo("a/b", { fetchImpl, token: "topsecret" })).rejects.toMatchObject({
      name: "ScoutFetchError",
      status: 403,
    });
    await fetchGitHubRepo("a/b", { fetchImpl, token: "topsecret" }).catch((e: unknown) => {
      expect(e).toBeInstanceOf(ScoutFetchError);
      expect((e as Error).message).not.toContain("topsecret");
      expect((e as Error).message).not.toContain("secret");
    });
  });

  it("非法 ref：根本不发起 fetch", async () => {
    const fetchImpl = okFetch({});
    await expect(fetchGitHubRepo("nonsense", { fetchImpl })).rejects.toBeInstanceOf(ScoutFetchError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("网络抛错 → 归一为 ScoutFetchError（不回显原始 error 细节）", async () => {
    const fetchImpl: GithubFetch = vi.fn(async () => {
      throw new Error("ENOTFOUND api.github.com token=abc");
    });
    await fetchGitHubRepo("a/b", { fetchImpl, token: "abc" }).catch((e: unknown) => {
      expect(e).toBeInstanceOf(ScoutFetchError);
      expect((e as Error).message).toContain("网络错误");
      expect((e as Error).message).not.toContain("ENOTFOUND");
      expect((e as Error).message).not.toContain("abc");
    });
  });
});
