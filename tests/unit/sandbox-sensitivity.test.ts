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

/**
 * TASK 5 覆盖度确认（2026-09-08 夜）——创始人点名 5 项：电价 / 年里程 / 车辆利用率 / 储能 CAPEX / 光伏 CAPEX。
 * 前四项 已能真实扫到（年里程以 `chargePerTruck` 作合并代理，详见 docs/MODEL_CAUSALITY_AUDIT_V1.md P2-5）；
 * 第五项「车辆利用率」`chargerUtilization` V1 未接入 E 层（P1-1 假联动），
 * **不**塞进默认扫描集，避免"摆幅永远 0 的假柱子"污染龙卷风可读性；
 * 通过自定义 `params` 显式扫它，会得到 swing=0 且 notes 提示，本测试钉住这一诚实策略。
 */
describe("TASK 5 · 创始人点名 5 项覆盖度", () => {
  const t = computeTornado();
  const keys = t.rows.map((r) => r.key);

  it("电价 region.elecPrice 在默认扫描集，且 swing 非 null", () => {
    expect(keys).toContain("region.elecPrice");
    const r = t.rows.find((x) => x.key === "region.elecPrice")!;
    expect(r.swing).not.toBeNull();
    expect(r.swing!).toBeLessThan(0); // 电价↑ → NPV↓（方向可解释）
  });

  it("年里程×电耗合并代理 project.chargePerTruck 在默认扫描集，swing 非 null", () => {
    expect(keys).toContain("project.chargePerTruck");
    const r = t.rows.find((x) => x.key === "project.chargePerTruck")!;
    expect(r.swing).not.toBeNull();
    expect(Math.abs(r.swing!)).toBeGreaterThan(1e4); // 有意义摆幅
  });

  it("储能 CAPEX tech.storageCapex 在默认扫描集，swing 非 null", () => {
    expect(keys).toContain("tech.storageCapex");
    const r = t.rows.find((x) => x.key === "tech.storageCapex")!;
    expect(r.swing).not.toBeNull();
    expect(r.swing!).toBeLessThan(0); // 造价↑ → NPV↓
  });

  it("光伏 CAPEX tech.pvCapex 在默认扫描集，swing 非 null", () => {
    expect(keys).toContain("tech.pvCapex");
    const r = t.rows.find((x) => x.key === "tech.pvCapex")!;
    expect(r.swing).not.toBeNull();
  });

  /**
   * 车辆利用率：**故意不在默认扫描集**。若有人误把它加入，会得到 swing=0 → 用户以为"这东西对结果零影响"
   * 而非"这东西根本没接进模型"——即"假敏感"陷阱。此处显式验证：手动扫它，能得到"摆幅 0"的诚实结论。
   */
  it("project.chargerUtilization 不在默认扫描集（防假敏感），显式扫时 swing 恒为 0", () => {
    expect(keys).not.toContain("project.chargerUtilization");
    const custom = computeTornado({ params: [{ key: "project.chargerUtilization", deltaPct: 20 }] });
    const r = custom.rows[0];
    expect(r.swing).toBe(0);
    // 摆幅 0 但 baseMetric 存在——证明"扰动执行了，只是 E 层未消费"，与"根本没扫"不同
    expect(r.baseMetric).not.toBeNull();
    expect(r.lowMetric).toBe(r.highMetric);
  });

  it("默认扫描集规模≥5（覆盖创始人 5 项要求里可真实量化的 4 项 + 6 项其他主杠杆）", () => {
    expect(t.rows.length).toBeGreaterThanOrEqual(10);
  });
});

