import { describe, it, expect } from "vitest";
import {
  SCOUT_VERSION,
  LICENSE_CATEGORIES,
  LICENSE_CATEGORY_BY_TYPE,
  licenseCategory,
  decideLicense,
  projectReadiness,
  normalizeRepoUrl,
  ScoutCandidateSchema,
  evaluateCandidate,
  type ReadinessInput,
} from "@/server/scout";
import { LicenseTypeSchema, type LicenseType } from "@/lib/validation";

/* ─────────────── 常量守护（第 13 条版本化 + 第 16 条单一真源） ─────────────── */

describe("scout 常量与许可证分类", () => {
  it("SCOUT_VERSION 是语义化版本字符串", () => {
    expect(SCOUT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("恰好 5 个风险分档、顺序稳定", () => {
    expect([...LICENSE_CATEGORIES]).toEqual([
      "permissive",
      "weak_copyleft",
      "strong_copyleft",
      "proprietary",
      "unknown",
    ]);
  });

  it("分类映射逐字覆盖 LicenseTypeSchema 全部 11 成员（无遗漏）", () => {
    const enumMembers = LicenseTypeSchema.options;
    const mappedKeys = Object.keys(LICENSE_CATEGORY_BY_TYPE);
    expect(new Set(mappedKeys)).toEqual(new Set(enumMembers));
    expect(mappedKeys.length).toBe(11);
  });

  it("分类黄金值：宽松 / 弱传染 / 强传染 / 专有 / 未知", () => {
    expect(licenseCategory("MIT")).toBe("permissive");
    expect(licenseCategory("APACHE_2_0")).toBe("permissive");
    expect(licenseCategory("BSD_3_CLAUSE")).toBe("permissive");
    expect(licenseCategory("MPL_2_0")).toBe("weak_copyleft");
    expect(licenseCategory("LGPL")).toBe("weak_copyleft");
    expect(licenseCategory("GPL")).toBe("strong_copyleft");
    expect(licenseCategory("AGPL")).toBe("strong_copyleft");
    expect(licenseCategory("PROPRIETARY")).toBe("proprietary");
    expect(licenseCategory("UNKNOWN")).toBe("unknown");
    expect(licenseCategory("OTHER")).toBe("unknown");
  });
});

/* ─────────────── 许可证准入判定矩阵（第 11 条法务门） ─────────────── */

describe("decideLicense 判定矩阵", () => {
  it("人工已批准 → approved（尊重人的许可，哪怕强传染 GPL）", () => {
    const r = decideLicense({ licenseType: "GPL", licenseReviewStatus: "APPROVED" });
    expect(r.verdict).toBe("approved");
    expect(r.category).toBe("strong_copyleft");
    expect(r.reasons.some((s) => s.includes("人工复核批准"))).toBe(true);
  });

  it("人工已拒绝 → rejected（即使是宽松 MIT，也尊重人的否决）", () => {
    const r = decideLicense({ licenseType: "MIT", licenseReviewStatus: "REJECTED" });
    expect(r.verdict).toBe("rejected");
    expect(r.reasons.some((s) => s.includes("不可用"))).toBe(true);
  });

  it("人工标记需复核 → needs_human_review", () => {
    const r = decideLicense({ licenseType: "AGPL", licenseReviewStatus: "NEEDS_HUMAN_REVIEW" });
    expect(r.verdict).toBe("needs_human_review");
  });

  it("NOT_REVIEWED 一律不自动放行（法律门须人工），按分档补强理由", () => {
    const cases: Array<[LicenseType, string, string]> = [
      ["MIT", "permissive", "宽松许可证"],
      ["LGPL", "weak_copyleft", "弱传染许可证"],
      ["GPL", "strong_copyleft", "强传染许可证"],
      ["PROPRIETARY", "proprietary", "专有 / 含商业限制"],
      ["UNKNOWN", "unknown", "许可证未知或为 OTHER"],
    ];
    for (const [type, category, hint] of cases) {
      const r = decideLicense({ licenseType: type, licenseReviewStatus: "NOT_REVIEWED" });
      expect(r.verdict, type).toBe("needs_human_review");
      expect(r.category, type).toBe(category);
      expect(r.reasons.some((s) => s.includes("不越权批准")), type).toBe(true);
      expect(r.reasons.some((s) => s.includes(hint)), type).toBe(true);
    }
  });
});

/* ─────────────── 复用就绪度聚合（第 11 条完整准入门） ─────────────── */

const ALL_CHECKS_DONE = { dependencyChecked: true, securityChecked: true, tested: true };

function readiness(
  over: Partial<ReadinessInput> & { licenseType: LicenseType },
): ReturnType<typeof projectReadiness> {
  return projectReadiness({
    licenseReviewStatus: "APPROVED",
    ...ALL_CHECKS_DONE,
    ...over,
  });
}

describe("projectReadiness 就绪聚合", () => {
  it("已批准 + 三检查全 true → 无阻断、可复用", () => {
    const r = readiness({ licenseType: "MIT" });
    expect(r.blockers).toEqual([]);
    expect(r.readyForReuse).toBe(true);
  });

  it("关键守护：未复核（NOT_REVIEWED）+ 三检查全 true 仍不就绪（法律门优先）", () => {
    const r = projectReadiness({
      licenseType: "GPL",
      licenseReviewStatus: "NOT_REVIEWED",
      ...ALL_CHECKS_DONE,
    });
    expect(r.readyForReuse).toBe(false);
    expect(r.blockers.some((s) => s.includes("许可证待人工复核"))).toBe(true);
    expect(r.blockers.length).toBe(1); // 只剩法律门这一条
  });

  it("缺任一检查位即计入对应阻断项", () => {
    expect(
      readiness({ licenseType: "MIT", dependencyChecked: false }).blockers.some((s) =>
        s.includes("依赖检查"),
      ),
    ).toBe(true);
    expect(
      readiness({ licenseType: "MIT", securityChecked: false }).blockers.some((s) =>
        s.includes("安全检查"),
      ),
    ).toBe(true);
    expect(
      readiness({ licenseType: "MIT", tested: false }).blockers.some((s) => s.includes("实测")),
    ).toBe(true);
  });

  it("被拒许可证 → 计入「许可证被拒」阻断", () => {
    const r = projectReadiness({
      licenseType: "MIT",
      licenseReviewStatus: "REJECTED",
      ...ALL_CHECKS_DONE,
    });
    expect(r.readyForReuse).toBe(false);
    expect(r.blockers.some((s) => s.includes("许可证被拒"))).toBe(true);
  });

  it("多缺口时阻断计数自洽（未复核 + 全检查未做 = 4 条）", () => {
    const r = projectReadiness({
      licenseType: "UNKNOWN",
      licenseReviewStatus: "NOT_REVIEWED",
      dependencyChecked: false,
      securityChecked: false,
      tested: false,
    });
    expect(r.blockers.length).toBe(4);
    expect(r.readyForReuse).toBe(false);
  });
});

/* ─────────────── 仓库 URL 去重键（确定性） ─────────────── */

describe("normalizeRepoUrl 去重键", () => {
  it("大小写 / 协议 / www / .git / 尾斜杠 归一到同一键", () => {
    const key = "github.com/owner/repo";
    for (const v of [
      "https://GitHub.com/Owner/Repo.git/",
      "http://www.github.com/owner/repo",
      "git://github.com/Owner/Repo",
      "  github.com/owner/repo/  ",
      "https://github.com/owner/repo?ref=main#readme",
    ]) {
      expect(normalizeRepoUrl(v), v).toBe(key);
    }
  });

  it("保留 host（不同代码托管站不塌陷）且区分不同仓库", () => {
    expect(normalizeRepoUrl("gitlab.com/a/b")).not.toBe(normalizeRepoUrl("github.com/a/b"));
    expect(normalizeRepoUrl("github.com/a/b")).not.toBe(normalizeRepoUrl("github.com/a/c"));
  });

  it("空输入归一空串；幂等（二次归一不变）", () => {
    expect(normalizeRepoUrl("   ")).toBe("");
    const once = normalizeRepoUrl("https://github.com/A/B.git");
    expect(normalizeRepoUrl(once)).toBe(once);
  });
});

/* ─────────────── 入参 Schema 默认值（缺省即最保守） ─────────────── */

describe("ScoutCandidateSchema 默认与归一", () => {
  it("仅 name+repoUrl 时回落最保守默认（UNKNOWN + NOT_REVIEWED + 三 false）", () => {
    const c = ScoutCandidateSchema.parse({ name: "x", repoUrl: "github.com/a/b" });
    expect(c.licenseType).toBe("UNKNOWN");
    expect(c.licenseReviewStatus).toBe("NOT_REVIEWED");
    expect(c.dependencyChecked).toBe(false);
    expect(c.securityChecked).toBe(false);
    expect(c.tested).toBe(false);
  });

  it("owner 空串归一为 undefined", () => {
    const c = ScoutCandidateSchema.parse({ name: "x", repoUrl: "y", owner: "   " });
    expect(c.owner).toBeUndefined();
  });

  it("非法许可证类型被拒", () => {
    expect(() =>
      ScoutCandidateSchema.parse({ name: "x", repoUrl: "y", licenseType: "NOPE" }),
    ).toThrow();
  });
});

/* ─────────────── 一站式评估（判别联合，永不裸抛） ─────────────── */

describe("evaluateCandidate", () => {
  it("缺 name → status invalid 且 issues 指名 name", () => {
    const r = evaluateCandidate({ repoUrl: "github.com/a/b" });
    expect(r.status).toBe("invalid");
    if (r.status === "invalid") {
      expect(r.issues.some((i) => i.path.includes("name"))).toBe(true);
    }
  });

  it("脏输入（null / 字符串 / 数组）一律 invalid 不裸抛", () => {
    for (const bad of [null, undefined, "x", 42, [], {}]) {
      expect(() => evaluateCandidate(bad)).not.toThrow();
      expect(evaluateCandidate(bad).status).toBe("invalid");
    }
  });

  it("已批准 + 全检查 → evaluated 且 readyForReuse true、带 dedupKey", () => {
    const r = evaluateCandidate({
      name: "vue",
      repoUrl: "https://GitHub.com/vuejs/core.git",
      licenseType: "MIT",
      licenseReviewStatus: "APPROVED",
      dependencyChecked: true,
      securityChecked: true,
      tested: true,
    });
    expect(r.status).toBe("evaluated");
    if (r.status === "evaluated") {
      expect(r.dedupKey).toBe("github.com/vuejs/core");
      expect(r.readiness.readyForReuse).toBe(true);
    }
  });

  it("GPL 未复核 + 全检查 → evaluated 但不就绪", () => {
    const r = evaluateCandidate({
      name: "g",
      repoUrl: "github.com/o/r",
      licenseType: "GPL",
      licenseReviewStatus: "NOT_REVIEWED",
      dependencyChecked: true,
      securityChecked: true,
      tested: true,
    });
    expect(r.status).toBe("evaluated");
    if (r.status === "evaluated") {
      expect(r.readiness.readyForReuse).toBe(false);
      expect(r.readiness.license.category).toBe("strong_copyleft");
    }
  });

  it("同一仓库不同写法归一到同一 dedupKey", () => {
    const a = evaluateCandidate({ name: "x", repoUrl: "https://GitHub.com/Owner/Repo.git/" });
    const b = evaluateCandidate({ name: "x", repoUrl: "http://www.github.com/owner/repo" });
    expect(a.status).toBe("evaluated");
    expect(b.status).toBe("evaluated");
    if (a.status === "evaluated" && b.status === "evaluated") {
      expect(a.dedupKey).toBe(b.dedupKey);
    }
  });
});
