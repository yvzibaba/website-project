import { describe, it, expect } from "vitest";
import {
  parseSolutionBody,
  SOLUTION_SECTIONS,
  SOLUTION_SECTION_COUNT,
} from "@/server/solution-body";

/**
 * 单测：Solution.body 34 分节归一器（Phase 8 M2，纯函数，无 DB）。
 *
 * 关键契约：固定返回 34 节、canonical 顺序、命中即 filled、空/缺显式 pending、
 * 未知键进 extras 不静默丢弃、非对象入参判空。展示端只信这个视图，故逐条锁死。
 */

describe("solution-body parseSolutionBody", () => {
  it("常量表恰为 34 节且顺序稳定", () => {
    expect(SOLUTION_SECTION_COUNT).toBe(34);
    expect(SOLUTION_SECTIONS.length).toBe(34);
    expect(SOLUTION_SECTIONS[0]).toEqual({ key: "name", title: "项目/方案名称" });
    expect(SOLUTION_SECTIONS[33]).toEqual({
      key: "aiAnnotations",
      title: "AI假设/推断/预测的明确标注",
    });
    // key 唯一
    const keys = SOLUTION_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(34);
  });

  it("null / undefined / 非对象 → empty=true，全 pending", () => {
    for (const input of [null, undefined, 42, "str", ["a"]]) {
      const r = parseSolutionBody(input);
      expect(r.empty).toBe(true);
      expect(r.filledCount).toBe(0);
      expect(r.totalCount).toBe(34);
      expect(r.sections.every((s) => !s.filled)).toBe(true);
      expect(r.sections.every((s) => s.content === undefined)).toBe(true);
    }
  });

  it("空对象 {} → empty=true", () => {
    const r = parseSolutionBody({});
    expect(r.empty).toBe(true);
    expect(r.filledCount).toBe(0);
    expect(r.extras).toEqual([]);
  });

  it("按 key 命中 → 对应节 filled，其余 pending", () => {
    const r = parseSolutionBody({ coreProblem: "解决 X", costModel: { capex: "100" } });
    const problem = r.sections.find((s) => s.key === "coreProblem");
    expect(problem?.filled).toBe(true);
    expect(problem?.content).toBe("解决 X");
    const cost = r.sections.find((s) => s.key === "costModel");
    expect(cost?.filled).toBe(true);
    expect(cost?.content).toEqual({ capex: "100" });
    expect(r.filledCount).toBe(2);
    expect(r.empty).toBe(false);
  });

  it("按中文 title 命中（流水线用标题作键也认）", () => {
    const r = parseSolutionBody({ "目标行业": "新能源", "Bull Case": "乐观情形说明" });
    expect(r.sections.find((s) => s.key === "industry")?.content).toBe("新能源");
    expect(r.sections.find((s) => s.key === "bullCase")?.content).toBe("乐观情形说明");
    expect(r.filledCount).toBe(2);
  });

  it("空串 / 空数组 / 空对象 视为未填 pending", () => {
    const r = parseSolutionBody({ coreProblem: "   ", techRoadmap: [], riskAnalysis: {} });
    expect(r.sections.find((s) => s.key === "coreProblem")?.filled).toBe(false);
    expect(r.sections.find((s) => s.key === "techRoadmap")?.filled).toBe(false);
    expect(r.sections.find((s) => s.key === "riskAnalysis")?.filled).toBe(false);
    expect(r.filledCount).toBe(0);
  });

  it("数字 0 / 布尔 false 视为有内容（不当空丢掉）", () => {
    const r = parseSolutionBody({ roi: 0, sensitivity: false });
    expect(r.sections.find((s) => s.key === "roi")?.filled).toBe(true);
    expect(r.sections.find((s) => s.key === "roi")?.content).toBe(0);
    expect(r.sections.find((s) => s.key === "sensitivity")?.filled).toBe(true);
    expect(r.filledCount).toBe(2);
  });

  it("未知键收进 extras，不静默丢弃；空的未知键不入 extras", () => {
    const r = parseSolutionBody({ coreProblem: "x", 未来扩展: "备注", 空字段: "" });
    const extraKeys = r.extras.map((e) => e.key);
    expect(extraKeys).toContain("未来扩展");
    expect(extraKeys).not.toContain("空字段");
    // extras 不影响 canonical 34 节长度
    expect(r.sections.length).toBe(34);
  });

  it("key 与 title 同时存在时以 key 优先", () => {
    const r = parseSolutionBody({ industry: "由 key", 目标行业: "由 title" });
    expect(r.sections.find((s) => s.key === "industry")?.content).toBe("由 key");
    expect(r.filledCount).toBe(1);
  });

  it("sections 顺序严格等于 SOLUTION_SECTIONS", () => {
    const r = parseSolutionBody({});
    expect(r.sections.map((s) => s.key)).toEqual(SOLUTION_SECTIONS.map((s) => s.key));
  });

  it("填满全部 34 节 → filledCount=34", () => {
    const full: Record<string, unknown> = {};
    for (const s of SOLUTION_SECTIONS) full[s.key] = `内容-${s.key}`;
    const r = parseSolutionBody(full);
    expect(r.filledCount).toBe(34);
    expect(r.sections.every((s) => s.filled)).toBe(true);
  });
});
