import { describe, it, expect } from "vitest";
import {
  OPPORTUNITY_DIMENSIONS,
  OPPORTUNITY_MAX,
  SCORING_RUBRIC_VERSION,
  EVIDENCE_TYPE_WEIGHTS,
  EVIDENCE_CONFIDENCE_PARAMS,
  computeOpportunityScore,
  computeEvidenceConfidence,
  countKeyUnknowns,
  computeCaseScores,
  CaseScoresSchema,
  type EvidenceLike,
} from "@/server/scoring";

/**
 * 单元测试：案例评分内核（纯函数 · 黄金样本）。
 *
 * 为什么是"黄金样本"（TESTING.md §4 / 宪法第 7 条：关键数字须公式可复算）：
 *   评分是下游一切（案例排序、方案优先级、后台审核）的地基，必须**逐条锁定期望值**，
 *   任何调权重/改公式都必须显式改这里的黄金值并升 SCORING_RUBRIC_VERSION，防止无声回归。
 *
 * 关键极性提醒（本模块的设计选择）：competitionIntensity / implementationDifficulty 是
 *   **inverse（反向）**维度——录入 raw=该负面强度，贡献 = max - raw。所以：
 *     · "全维度都填满分 max" ≠ 100（反向维度此时贡献 0）→ 实为 90；
 *     · 真正的最优（=100）是"正向维度填 max、反向维度填 0"；
 *     · "全维度都填 0" → 正向贡献 0、反向各贡献 max(5) → 实为 10。
 *   这三条边界都被显式锁定，避免后人误以为 all-max 就该是 100。
 */

/** 构造"最优"入参：正向=max、反向=0 → 期望 100。 */
function bestCaseInput(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const d of OPPORTUNITY_DIMENSIONS) {
    o[d.key] = d.polarity === "inverse" ? 0 : d.max;
  }
  return o;
}

/** 构造"全填 max"入参（含反向维度也填 max）→ 期望 90（反向贡献归零）。 */
function allMaxInput(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const d of OPPORTUNITY_DIMENSIONS) o[d.key] = d.max;
  return o;
}

/** 构造"全填 0"入参 → 期望 10（仅两个反向维度各贡献其 max=5）。 */
function allZeroInput(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const d of OPPORTUNITY_DIMENSIONS) o[d.key] = 0;
  return o;
}

describe("scoring — 常量与结构（单一事实源）", () => {
  it("满分恒为 100，且等于各维度 max 之和", () => {
    expect(OPPORTUNITY_MAX).toBe(100);
    expect(OPPORTUNITY_DIMENSIONS.reduce((s, d) => s + d.max, 0)).toBe(100);
  });

  it("恰有 10 个维度，权重照抄总控 §10（防误改）", () => {
    expect(OPPORTUNITY_DIMENSIONS).toHaveLength(10);
    const byKey = Object.fromEntries(OPPORTUNITY_DIMENSIONS.map((d) => [d.key, d]));
    expect(byKey.commercialValue.max).toBe(20);
    expect(byKey.marketDemand.max).toBe(15);
    expect(byKey.techMaturity.max).toBe(15);
    expect(byKey.localizationSpace.max).toBe(10);
    expect(byKey.costAdvantage.max).toBe(10);
    expect(byKey.replicability.max).toBe(10);
    expect(byKey.supplyChainMaturity.max).toBe(5);
    expect(byKey.competitionIntensity.max).toBe(5);
    expect(byKey.policyEnvironment.max).toBe(5);
    expect(byKey.implementationDifficulty.max).toBe(5);
  });

  it("恰有两个反向维度：竞争强度、实施难度", () => {
    const inverse = OPPORTUNITY_DIMENSIONS.filter((d) => d.polarity === "inverse").map(
      (d) => d.key,
    );
    expect(inverse.sort()).toEqual(["competitionIntensity", "implementationDifficulty"]);
  });

  it("证据类型权重：FACT 最强、PREDICTION 最弱且单调递减", () => {
    expect(EVIDENCE_TYPE_WEIGHTS.FACT).toBeGreaterThan(EVIDENCE_TYPE_WEIGHTS.ASSUMPTION);
    expect(EVIDENCE_TYPE_WEIGHTS.ASSUMPTION).toBeGreaterThan(EVIDENCE_TYPE_WEIGHTS.INFERENCE);
    expect(EVIDENCE_TYPE_WEIGHTS.INFERENCE).toBeGreaterThan(EVIDENCE_TYPE_WEIGHTS.PREDICTION);
    expect(EVIDENCE_CONFIDENCE_PARAMS.unsourcedFactor).toBeLessThan(1);
  });
});

describe("scoring — computeOpportunityScore 黄金样本", () => {
  it("最优（正向=max、反向=0）→ 100", () => {
    const r = computeOpportunityScore(bestCaseInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(100);
    expect(r.max).toBe(100);
  });

  it("全维度都填 max → 90（反向维度贡献归零，非 100）", () => {
    const r = computeOpportunityScore(allMaxInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(90);
  });

  it("全维度都填 0 → 10（仅两个反向维度各贡献 5）", () => {
    const r = computeOpportunityScore(allZeroInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(10);
  });

  it("工作样例 → 88（逐维度贡献锁定）", () => {
    const r = computeOpportunityScore({
      commercialValue: 19,
      marketDemand: 14,
      techMaturity: 13,
      localizationSpace: 9,
      costAdvantage: 9,
      replicability: 9,
      supplyChainMaturity: 4,
      competitionIntensity: 1, // inverse → 贡献 4
      policyEnvironment: 3,
      implementationDifficulty: 1, // inverse → 贡献 4
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(88);
    const contrib = Object.fromEntries(r.breakdown.map((b) => [b.key, b.contribution]));
    expect(contrib.commercialValue).toBe(19);
    expect(contrib.competitionIntensity).toBe(4);
    expect(contrib.implementationDifficulty).toBe(4);
    // 各维度贡献之和恰等于总分（可复算：breakdown 不是装饰，是审计线索）
    expect(r.breakdown.reduce((s, b) => s + b.contribution, 0)).toBe(r.total);
  });

  it("反向维度：raw 越大贡献越小（极性正确）", () => {
    const base = { ...bestCaseInput() };
    const low = computeOpportunityScore({ ...base, competitionIntensity: 0 });
    const high = computeOpportunityScore({ ...base, competitionIntensity: 5 });
    expect(low.ok && high.ok).toBe(true);
    if (!low.ok || !high.ok) return;
    expect(low.total).toBe(100); // 反向填 0 = 无竞争 = 满贡献
    expect(high.total).toBe(95); // 反向填 5 = 白热化 = 贡献 0
  });

  it("越界入参 → ok:false 且 issues 指名维度（不静默截断）", () => {
    const bad = { ...bestCaseInput(), commercialValue: 21 }; // max 20
    const r = computeOpportunityScore(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.join(" ")).toContain("commercialValue");
  });

  it("缺维度 / 非整数 / 负数 → ok:false", () => {
    const missing = bestCaseInput();
    delete missing.marketDemand;
    expect(computeOpportunityScore(missing).ok).toBe(false);

    const nonInt = { ...bestCaseInput(), techMaturity: 12.5 };
    expect(computeOpportunityScore(nonInt).ok).toBe(false);

    const negative = { ...bestCaseInput(), costAdvantage: -1 };
    expect(computeOpportunityScore(negative).ok).toBe(false);
  });

  it("确定性：同入参多次调用结果完全一致（可复算）", () => {
    const input = bestCaseInput();
    const a = computeOpportunityScore(input);
    const b = computeOpportunityScore(input);
    expect(a).toEqual(b);
  });
});

describe("scoring — computeEvidenceConfidence 黄金样本", () => {
  it("混合证据集 → 69（Σnum=1.94 / Σw=2.8 精确锁定）", () => {
    const evs: EvidenceLike[] = [
      { type: "FACT", confidence: 90, sourceUrl: "https://a" },
      { type: "FACT", confidence: 70, sourceUrl: "https://b" },
      { type: "ASSUMPTION", confidence: 50, sourceUrl: "https://c" },
      { type: "PREDICTION", confidence: 50, sourceUrl: null }, // 无来源打 0.6 折
    ];
    const r = computeEvidenceConfidence(evs);
    expect(r.evidenceCount).toBe(4);
    expect(r.weightTotal).toBeCloseTo(2.8, 10);
    expect(r.weightedNumerator).toBeCloseTo(1.94, 10);
    expect(r.value).toBe(69); // round(100 * 1.94 / 2.8) = round(69.2857)
    expect(r.byType).toEqual({ FACT: 2, ASSUMPTION: 1, INFERENCE: 0, PREDICTION: 1 });
  });

  it("空证据集 → 0（没有证据就没有可信度）", () => {
    const r = computeEvidenceConfidence([]);
    expect(r.value).toBe(0);
    expect(r.evidenceCount).toBe(0);
    expect(r.weightTotal).toBe(0);
  });

  it("单条 FACT conf=100 有来源 → 100", () => {
    const r = computeEvidenceConfidence([{ type: "FACT", confidence: 100, sourceUrl: "x" }]);
    expect(r.value).toBe(100);
  });

  it("单条证据时类型权重在比值中约掉 → 只由 q·sf 决定", () => {
    // FACT conf100 无来源：w 约掉，value = round(100 * 1 * 0.6) = 60
    const fact = computeEvidenceConfidence([{ type: "FACT", confidence: 100, sourceUrl: null }]);
    // PREDICTION conf100 无来源：同样 = 60（权重被分母约掉，证明单条时类型不影响结果）
    const pred = computeEvidenceConfidence([
      { type: "PREDICTION", confidence: 100, sourceUrl: null },
    ]);
    expect(fact.value).toBe(60);
    expect(pred.value).toBe(60);
  });

  it("未填 confidence → 用缺省值（defaultConfidence）", () => {
    const withDefault = computeEvidenceConfidence([{ type: "FACT", sourceUrl: "x" }]);
    const withExplicit = computeEvidenceConfidence([
      { type: "FACT", confidence: EVIDENCE_CONFIDENCE_PARAMS.defaultConfidence, sourceUrl: "x" },
    ]);
    expect(withDefault.value).toBe(withExplicit.value);
    expect(withDefault.value).toBe(EVIDENCE_CONFIDENCE_PARAMS.defaultConfidence);
  });

  it("越界 confidence 被 clamp 到 0..100（不产出非法值）", () => {
    const high = computeEvidenceConfidence([{ type: "FACT", confidence: 999, sourceUrl: "x" }]);
    const low = computeEvidenceConfidence([{ type: "FACT", confidence: -50, sourceUrl: "x" }]);
    expect(high.value).toBe(100);
    expect(low.value).toBe(0);
  });

  it("未知证据类型被跳过（防御脏数据，不静默当 FACT）", () => {
    const r = computeEvidenceConfidence([
      { type: "FACT", confidence: 100, sourceUrl: "x" },
      { type: "RUMOR" as unknown as EvidenceLike["type"], confidence: 100, sourceUrl: "x" },
    ]);
    expect(r.evidenceCount).toBe(2); // count 反映传入总数
    expect(r.byType.FACT).toBe(1); // 但只有合法类型进入加权
    expect(r.value).toBe(100); // 脏数据未拉低/拉高结果
  });

  it("确定性：同证据集多次调用结果一致", () => {
    const evs: EvidenceLike[] = [{ type: "INFERENCE", confidence: 80, sourceUrl: "y" }];
    expect(computeEvidenceConfidence(evs)).toEqual(computeEvidenceConfidence(evs));
  });
});

describe("scoring — countKeyUnknowns", () => {
  it("= 非 FACT 证据条数", () => {
    const evs: EvidenceLike[] = [
      { type: "FACT" },
      { type: "ASSUMPTION" },
      { type: "INFERENCE" },
      { type: "PREDICTION" },
      { type: "FACT" },
    ];
    expect(countKeyUnknowns(evs)).toBe(3);
  });

  it("全 FACT / 空集 → 0", () => {
    expect(countKeyUnknowns([{ type: "FACT" }, { type: "FACT" }])).toBe(0);
    expect(countKeyUnknowns([])).toBe(0);
  });

  it("未知类型不计入（既非 FACT 也非合法不确定类型）", () => {
    expect(countKeyUnknowns([{ type: "RUMOR" as unknown as EvidenceLike["type"] }])).toBe(0);
  });
});

describe("scoring — computeCaseScores 组合契约", () => {
  it("一次算出三件套且与 CaseScoresSchema 一致", () => {
    const r = computeCaseScores({
      opportunity: bestCaseInput(),
      evidences: [
        { type: "FACT", confidence: 90, sourceUrl: "a" },
        { type: "ASSUMPTION", confidence: 50, sourceUrl: null },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.rubricVersion).toBe(SCORING_RUBRIC_VERSION);
    expect(r.opportunityScore).toBe(100);
    expect(r.opportunityMax).toBe(100);
    expect(r.evidenceCount).toBe(2);
    expect(r.unknownVariableCount).toBe(1); // 仅 ASSUMPTION
    expect(r.issues).toEqual([]);
    // 入库前用 Zod 复核结构（宪法第 7 条：可追溯）
    expect(CaseScoresSchema.safeParse(r).success).toBe(true);
  });

  it("机会评分非法时：三件套仍算证据两项，ok=false + issues", () => {
    const bad = bestCaseInput();
    delete bad.replicability;
    const r = computeCaseScores({
      opportunity: bad,
      evidences: [{ type: "FACT", confidence: 100, sourceUrl: "z" }],
    });
    expect(r.ok).toBe(false);
    expect(r.opportunityScore).toBeNull();
    expect(r.opportunityBreakdown).toBeNull();
    expect(r.issues.length).toBeGreaterThan(0);
    // 证据两项独立计算，不受机会评分非法影响
    expect(r.evidenceConfidence).toBe(100);
    expect(r.unknownVariableCount).toBe(0);
  });

  it("无证据时：evidenceConfidence=0、unknownVariableCount=0", () => {
    const r = computeCaseScores({ opportunity: bestCaseInput() });
    expect(r.evidenceConfidence).toBe(0);
    expect(r.unknownVariableCount).toBe(0);
    expect(r.evidenceCount).toBe(0);
  });
});
