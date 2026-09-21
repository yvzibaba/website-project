/**
 * R7-C · V2 决策导出方案「人工审核发布门」（`humanReviewGateForV2` + `hasV2DecisionReportExtra`）
 * 的纯函数单测。
 *
 * 锁 mandate §四 的三档：
 *   1) V2 + DRAFT → 目标 PUBLISHED 被拒（fieldErrors.status 非空、含 "UNDER_HUMAN_REVIEW" 字样）；
 *   2) V2 + 已在 UNDER_HUMAN_REVIEW → 放行（gate 返 null）；
 *   3) V1（无 extras.decisionReport）→ **任何当前态都不启用本门**（不破坏既有 V1 流程 mandate §四末段），
 *      发布判负只由既有 `publishGuard`（价 + riskDomains + review 标记）独力把关。
 * 另锁 `hasV2DecisionReportExtra` 的形态宽容度：只有 `{provenance, sections: []}` 也算 V2；
 * `provenance` 或 `sections` 缺其一即视为非 V2（避免"半截数据"误判启用本门）。
 */
import { describe, it, expect } from "vitest";
import {
  hasV2DecisionReportExtra,
  humanReviewGateForV2,
} from "@app/kernel/server/solution-admin";

/* ─────────────────────── hasV2DecisionReportExtra 形态宽容 ─────────────────────── */

describe("R7-C · hasV2DecisionReportExtra 形态识别", () => {
  it("标准 V2 body：{ decisionReport: { provenance, sections } } → true", () => {
    expect(
      hasV2DecisionReportExtra({
        decisionReport: {
          reportVersion: "report@1.0.0",
          provenance: { scenarioId: "s", scenarioLabel: "基准" },
          disclaimer: "DISC",
          sections: [],
        },
      }),
    ).toBe(true);
  });
  it("最小可用形状：{ provenance: {}, sections: [] } → true（宽容 title/reportVersion/disclaimer 缺失）", () => {
    expect(hasV2DecisionReportExtra({ decisionReport: { provenance: {}, sections: [] } })).toBe(true);
  });
  it("无 decisionReport 键（V1 手工方案典型形态）→ false", () => {
    expect(hasV2DecisionReportExtra({ name: "V1 方案", summary: "无 V2 快照" })).toBe(false);
    expect(hasV2DecisionReportExtra({})).toBe(false);
    expect(hasV2DecisionReportExtra(null)).toBe(false);
    expect(hasV2DecisionReportExtra(undefined)).toBe(false);
    expect(hasV2DecisionReportExtra("string-body")).toBe(false);
    expect(hasV2DecisionReportExtra([])).toBe(false);
  });
  it("只有 provenance 没 sections / 反之 → false（防半截数据误启用本门）", () => {
    expect(hasV2DecisionReportExtra({ decisionReport: { provenance: {} } })).toBe(false);
    expect(hasV2DecisionReportExtra({ decisionReport: { sections: [] } })).toBe(false);
    expect(hasV2DecisionReportExtra({ decisionReport: { sections: "not-array" } })).toBe(false);
  });
  it("decisionReport 非对象（数组/字符串/null）→ false", () => {
    expect(hasV2DecisionReportExtra({ decisionReport: null })).toBe(false);
    expect(hasV2DecisionReportExtra({ decisionReport: [] })).toBe(false);
    expect(hasV2DecisionReportExtra({ decisionReport: "some text" })).toBe(false);
  });
});

/* ─────────────────────── humanReviewGateForV2 三档 ─────────────────────── */

describe("R7-C · humanReviewGateForV2 状态门", () => {
  const V2_BODY = {
    decisionReport: {
      provenance: { scenarioId: "s", scenarioLabel: "基准" },
      sections: [],
    },
  };
  const V1_BODY = { summary: "手工建方案 · 无 V2 快照" };

  it("① V2 + DRAFT → 拒（fieldErrors.status 含 UNDER_HUMAN_REVIEW 字样，禁直跳）", () => {
    const errs = humanReviewGateForV2({ status: "DRAFT", body: V2_BODY });
    expect(errs).not.toBeNull();
    expect(Array.isArray(errs!.status)).toBe(true);
    expect(errs!.status[0]).toContain("UNDER_HUMAN_REVIEW");
    expect(errs!.status[0]).toContain("V2 决策导出方案");
  });

  it("② V2 + 已在 UNDER_HUMAN_REVIEW → 放行（null）", () => {
    expect(humanReviewGateForV2({ status: "UNDER_HUMAN_REVIEW", body: V2_BODY })).toBeNull();
  });

  it("③ V2 + PUBLISHED → 放行（本 gate 只管状态迁移入口，重发布由 updateSolution 外层短路）", () => {
    // updateSolution 的 `if (d.status === "PUBLISHED" && existing.status !== "PUBLISHED")` 已把这条
    // 情况挡在门外；这里显式钉 gate 自身**不因**已在 PUBLISHED 而误报。
    expect(humanReviewGateForV2({ status: "PUBLISHED", body: V2_BODY })).toBeNull();
  });

  it("④ V1 + DRAFT → 放行（不破坏既有 V1 流程 · mandate §四末段）", () => {
    expect(humanReviewGateForV2({ status: "DRAFT", body: V1_BODY })).toBeNull();
    expect(humanReviewGateForV2({ status: "DRAFT", body: null })).toBeNull();
  });

  it("⑤ 未知 status 值（脏数据）→ 放行（本门只在**明确 DRAFT**时启用，避免因脏态把 V2 卡死）", () => {
    expect(humanReviewGateForV2({ status: "LEGACY_UNKNOWN", body: V2_BODY })).toBeNull();
  });
});
