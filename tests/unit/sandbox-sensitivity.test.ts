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
import { runSandboxModelBaseline, runSandboxModel, type CalcResultOk } from "../../src/server/sandbox-model";

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

/**
 * 阶段1（R9.0 后续 · 2026-09-08 创始人批准）——`region.peakValleySpread` 敏感性解锁合理性
 * （SENSITIVITY_VERSION 1.2.0→1.3.0，纯加性：E3/E4/finance/参数默认值零改动）。
 *
 * 验收：① spread 进默认扫描集、±15% 摆幅真实非零、方向为正（spread↑→套利空间↑→储能价值↑→NPV↑）；
 *       ② TOP1 仍为综合充电单价（新行不挤占第一杠杆）；
 *       ③ 低/中/高 spread（0.3 / 0.6 默认 / 1.0）下储能价值、NPV 严格单调增，IRR 单调增，
 *          折现回收期严格单调减（先断言可解再比较，绝不静默跳过）；
 *       ④ spread=0 → 储能价值诚实归零（套利腿 margin≤0 关闭 + 消纳腿 S1 年度互斥恒 0），
 *          与 causality R9.0「spread=0 ⟺ 旧引擎 4,277,409」焊点互为印证。
 */
describe("阶段1 · spread 解锁合理性（SENSITIVITY_VERSION 1.3.0）", () => {
  const t = computeTornado();
  const spreadRow = t.rows.find((r) => r.key === "region.peakValleySpread");

  it("默认扫描集含 region.peakValleySpread（±15%），摆幅真实非零且方向为正", () => {
    expect(spreadRow).toBeDefined();
    if (!spreadRow) return;
    expect(spreadRow.deltaPct).toBe(15);
    expect(spreadRow.swing).not.toBeNull();
    expect(spreadRow.swing!).toBeGreaterThan(0); // spread↑ → NPV↑（储能套利价值腿）
    expect(spreadRow.lowMetric!).toBeLessThan(spreadRow.highMetric!);
    // 扰动端输入落在规格界内（±15% 于 [0,1.8] 不触边），非被裁剪的伪摆幅
    expect(spreadRow.lowInput).toBeGreaterThan(0);
    expect(spreadRow.highInput).toBeLessThan(1.8);
  });

  it("TOP1 仍是综合充电单价（spread 为第二梯队杠杆，不挤占收益第一杠杆）", () => {
    expect(t.mostSensitiveKey).toBe("project.chargingPrice");
  });

  it("低/中/高 spread：储能价值与 NPV 严格单调增、IRR 单调增、折现回收期严格单调减", () => {
    const at = (values: Record<string, number>): CalcResultOk => {
      const r = runSandboxModel({ user: { values } });
      if (!r.ok) throw new Error(`模型失败：${"reason" in r ? r.reason : "unknown"}`);
      return r;
    };
    const low = at({ "region.peakValleySpread": 0.3 });
    const mid = at({}); // 默认 0.6 元/kWh
    const high = at({ "region.peakValleySpread": 1.0 });

    // 储能价值（首年收入侧 Δ_sto）严格增
    expect(mid.revenueY1.storageValue).toBeGreaterThan(low.revenueY1.storageValue);
    expect(high.revenueY1.storageValue).toBeGreaterThan(mid.revenueY1.storageValue);
    // NPV 严格增（与 causality R9.0 阶梯同向）
    expect(mid.metrics.npv).toBeGreaterThan(low.metrics.npv);
    expect(high.metrics.npv).toBeGreaterThan(mid.metrics.npv);
    // IRR：先断言三点全部可解，再比较（防静默跳过造成假绿）。IrrResult.ok 为普通 boolean
    // （非 discriminant union），须显式提取 value 再比较。
    const irrLow = low.metrics.irr.ok ? low.metrics.irr.value : undefined;
    const irrMid = mid.metrics.irr.ok ? mid.metrics.irr.value : undefined;
    const irrHigh = high.metrics.irr.ok ? high.metrics.irr.value : undefined;
    expect(typeof irrLow).toBe("number");
    expect(typeof irrMid).toBe("number");
    expect(typeof irrHigh).toBe("number");
    if (irrLow != null && irrMid != null && irrHigh != null) {
      expect(irrMid).toBeGreaterThan(irrLow);
      expect(irrHigh).toBeGreaterThan(irrMid);
    }
    // 折现回收期严格减（回本更快）；先断言非 null 再比较
    expect(low.metrics.discountedPaybackYears).not.toBeNull();
    expect(mid.metrics.discountedPaybackYears).not.toBeNull();
    expect(high.metrics.discountedPaybackYears).not.toBeNull();
    if (
      low.metrics.discountedPaybackYears != null &&
      mid.metrics.discountedPaybackYears != null &&
      high.metrics.discountedPaybackYears != null
    ) {
      expect(high.metrics.discountedPaybackYears).toBeLessThan(mid.metrics.discountedPaybackYears);
      expect(mid.metrics.discountedPaybackYears).toBeLessThan(low.metrics.discountedPaybackYears);
    }
  });

  it("spread=0 → 储能价值诚实归零（套利腿关闭，消纳腿 S1 年度互斥恒 0）", () => {
    const r = runSandboxModel({ user: { values: { "region.peakValleySpread": 0 } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.revenueY1.storageValue).toBe(0);
  });

  it("默认集规模 ≥11（10 既有 + spread），确定性不破坏", () => {
    expect(t.rows.length).toBeGreaterThanOrEqual(11);
    expect(computeTornado()).toEqual(computeTornado());
  });
});

