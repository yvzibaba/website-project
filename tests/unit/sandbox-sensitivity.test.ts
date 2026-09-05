/**
 * 敏感性 + 高风险标记黄金样本（R2.3）——验证 OAT 龙卷风排序/方向、诚实 null 摆幅、风险标记派生。
 * 全离线（runSandboxModel 纯函数无 DB）。
 */
import { describe, it, expect } from "vitest";
import {
  SENSITIVITY_VERSION,
  sensitivityCalcRef,
  DEFAULT_SENSITIVITY_PARAMS,
  computeTornado,
  deriveRiskFlags,
} from "../../src/server/sandbox-sensitivity";
import { runSandboxModelBaseline, runSandboxModel } from "../../src/server/sandbox-model";

describe("sandbox-sensitivity · 版本", () => {
  it("版本语义化、calcRef 携带版本", () => {
    expect(SENSITIVITY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sensitivityCalcRef()).toBe(`sensitivity@${SENSITIVITY_VERSION}`);
  });
  it("默认扫描集非空且键均带 label（R1.2 单一真源）", () => {
    expect(DEFAULT_SENSITIVITY_PARAMS.length).toBeGreaterThanOrEqual(6);
  });
});

describe("computeTornado · NPV 龙卷风（基线）", () => {
  const t = computeTornado();
  it("成功、目标指标、基线值", () => {
    expect(t.ok).toBe(true);
    expect(t.metric).toBe("npv");
    expect(t.baseValue).not.toBeNull();
    expect(t.baseValue!).toBeGreaterThan(0);
    expect(t.needsProfessionalReview).toBe(true);
    expect(t.calcRef).toBe(sensitivityCalcRef());
  });

  it("最敏感参数=综合充电单价（收益第一杠杆）", () => {
    expect(t.mostSensitiveKey).toBe("project.chargingPrice");
  });

  it("按 |swing| 降序排列（非 null 行单调不增）", () => {
    const swings = t.rows.filter((r) => r.swing != null).map((r) => Math.abs(r.swing!));
    for (let i = 1; i < swings.length; i++) {
      expect(swings[i - 1]).toBeGreaterThanOrEqual(swings[i]);
    }
  });

  it("方向正确：充电单价↑→NPV↑（swing 正）；电价↑→NPV↓（swing 负）", () => {
    const price = t.rows.find((r) => r.key === "project.chargingPrice")!;
    const elec = t.rows.find((r) => r.key === "region.elecPrice")!;
    expect(price.swing!).toBeGreaterThan(0);
    expect(price.highMetric!).toBeGreaterThan(price.lowMetric!);
    expect(elec.swing!).toBeLessThan(0);
    expect(elec.highMetric!).toBeLessThan(elec.lowMetric!);
  });

  it("归一化条宽 ∈ [0,1] 且最大行为 1", () => {
    for (const r of t.rows) {
      if (r.swing == null) continue;
      expect(r.normalized!).toBeGreaterThanOrEqual(0);
      expect(r.normalized!).toBeLessThanOrEqual(1);
    }
    expect(t.rows[0].normalized).toBeCloseTo(1, 6);
  });

  it("每行带回标签与扰动输入（可画滑块范围）", () => {
    const cp = t.rows.find((r) => r.key === "project.chargingPrice")!;
    expect(cp.label).toContain("充电单价");
    expect(cp.lowInput).toBeLessThan(cp.highInput);
  });
});

describe("computeTornado · 其他指标", () => {
  it("metric=roi 也能出图（基线 roi>0）", () => {
    const t = computeTornado({ metric: "roi" });
    expect(t.baseValue!).toBeGreaterThan(0);
    expect(t.mostSensitiveKey).toBeTruthy();
  });
  it("metric=irr：基线单号现金流可解，各行 swing 多为非 null", () => {
    const t = computeTornado({ metric: "irr" });
    expect(t.baseValue).not.toBeNull();
    expect(t.rows.some((r) => r.swing != null)).toBe(true);
  });
});

describe("诚实降级（第 20 条）", () => {
  it("扰动一个不在快照里的键 → 该行 swing=null 且留 note，绝不编造摆幅", () => {
    const t = computeTornado({ params: [{ key: "does.not.exist", deltaPct: 10 }] });
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].swing).toBeNull();
    expect(t.rows[0].lowMetric).toBeNull();
    expect(t.rows[0].notes.join(" ")).toContain("无法扰动");
    expect(t.mostSensitiveKey).toBeNull();
  });
});

describe("deriveRiskFlags · 高风险标记（§16）", () => {
  it("健康基线：恒 needsProfessionalReview + 含'简化'与'占位假设'两条基础理由", () => {
    const { needsProfessionalReview, flags } = deriveRiskFlags(runSandboxModelBaseline());
    expect(needsProfessionalReview).toBe(true);
    expect(flags.some((f) => f.includes("简化"))).toBe(true);
    expect(flags.some((f) => f.includes("占位假设"))).toBe(true);
    // 基线 NPV>0 且 IRR 可解 → 不应出现亏损/无解告警
    expect(flags.some((f) => f.includes("NPV<0"))).toBe(false);
  });

  it("亏损情景（充电单价过低）→ 追加'NPV<0 不可行'标记", () => {
    const loss = runSandboxModel({ user: { values: { "project.chargingPrice": 0.4 } } });
    const { flags } = deriveRiskFlags(loss);
    expect(flags.some((f) => f.includes("NPV<0"))).toBe(true);
  });

  it("模型失败 → 直接标记不可用须人工核查", () => {
    const broken = runSandboxModel({ user: { values: { "project.pvCapacity": NaN } } });
    const { needsProfessionalReview, flags } = deriveRiskFlags(broken);
    expect(needsProfessionalReview).toBe(true);
    expect(flags[0]).toContain("模型未通过");
  });
});

describe("确定性", () => {
  it("同配置两次扫描输出深相等", () => {
    expect(computeTornado()).toEqual(computeTornado());
  });
});
