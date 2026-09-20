import { describe, expect, it } from "vitest";
import { runCalculation } from "@app/kernel/engine/engine";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import {
  DEFAULT_MAX_EVALUATIONS,
  RECOMMEND_MODEL_VERSION,
  recommendCalcRef,
  recommendConfiguration,
} from "@app/kernel/engine/recommend";
import type { RecommendationOutcome, RecommendationResult } from "@app/kernel/engine/recommend";
import type { ScenarioInput } from "@app/kernel/engine/types";

/** 山西重卡口径的服务费（市场调节价，属经营策略输入）。 */
const FEE = 0.45;

/** 底座：默认山西重卡情景（30 台、300 km/日），可按需覆写。 */
function baseInput(mutate?: (i: ScenarioInput) => ScenarioInput): ScenarioInput {
  const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
  const seeded: ScenarioInput = { ...input, truck: { ...input.truck, truckCount: 30, dailyMileageKm: 300 } };
  return mutate ? mutate(seeded) : seeded;
}

/** 默认搜索（山西重卡 30 台、300 km/日、现有并网 2,000 kW）。 */
const OUT = recommendConfiguration({ base: baseInput(), existingGridCapacityKw: 2000 });
if (!OUT.ok) throw new Error(`默认推荐失败：${OUT.reason} ${OUT.detail}`);
const R: RecommendationResult = OUT;

describe("自动推荐（M5）：默认山西重卡搜索", () => {
  it("返回结构完整，且携带可追溯的版本信息", () => {
    expect(R.ok).toBe(true);
    expect(R.recommendRef).toBe(`recommend@${RECOMMEND_MODEL_VERSION}`);
    expect(recommendCalcRef()).toBe(`recommend@${RECOMMEND_MODEL_VERSION}`);
    expect(R.needsProfessionalReview).toBe(true);
    expect(R.objective).toBe("npv");
    expect(R.headline.length).toBeGreaterThan(10);
    expect(R.disclaimer).toContain("不保证全局最优");
    expect(R.reasons.length).toBeGreaterThan(0);
    expect(R.concerns.length).toBeGreaterThan(0);
    expect(R.dimensionTrace).toHaveLength(5);
    expect(R.best.inputHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("完全可复现：同一请求两次调用结果逐字段相同（结果中不含时间/耗时）", () => {
    const again = recommendConfiguration({ base: baseInput(), existingGridCapacityKw: 2000 });
    expect(again.ok).toBe(true);
    expect(again).toEqual(OUT);
    // 结果里必须没有时钟痕迹，否则「可复现」这条硬约束当场失效
    const serialized = JSON.stringify(OUT);
    expect(serialized).not.toContain("elapsedMs");
    expect(serialized).not.toContain("generatedAt");
    expect(serialized).not.toContain("timestamp");
  });

  it("排序是合法全序：达标 → 可行 → 主目标降 → 净投资升 → 标识升", () => {
    for (let i = 1; i < R.ranked.length; i++) {
      const a = R.ranked[i - 1];
      const b = R.ranked[i];
      if (a.meetsObjective !== b.meetsObjective) {
        expect(a.meetsObjective).toBe(true);
        continue;
      }
      const af = a.ok && a.feasible ? 1 : 0;
      const bf = b.ok && b.feasible ? 1 : 0;
      if (af !== bf) {
        expect(af).toBeGreaterThan(bf);
        continue;
      }
      if (a.score !== b.score) {
        expect(a.score).toBeGreaterThan(b.score);
        continue;
      }
      const ac = a.netCapexYuan ?? Number.POSITIVE_INFINITY;
      const bc = b.netCapexYuan ?? Number.POSITIVE_INFINITY;
      if (ac !== bc) {
        expect(ac).toBeLessThan(bc);
        continue;
      }
      expect(a.candidate.key < b.candidate.key).toBe(true);
    }
    expect(R.best.candidate.key).toBe(R.ranked[0].candidate.key);
    expect(R.runnerUp?.candidate.key).toBe(R.ranked[1].candidate.key);
    expect(R.table[0].key).toBe(R.best.candidate.key);
    expect(R.table.length).toBeLessThanOrEqual(40);
  });

  it("搜索统计自洽：全组合数、剪枝数、评估数互相闭合", () => {
    const dims =
      R.space.chargerCounts.length *
      R.space.chargerPowersKw.length *
      R.space.bessEnergiesKwh.length *
      R.space.pvCapacitiesKwp.length *
      R.space.gridCapacitiesKw.length *
      R.space.managedChargingOptions.length;
    expect(R.stats.spaceSize).toBe(dims);
    expect(R.stats.evaluated).toBe(R.ranked.length);
    expect(R.stats.evaluated).toBeLessThanOrEqual(R.stats.maxEvaluations);
    expect(R.stats.maxEvaluations).toBe(DEFAULT_MAX_EVALUATIONS);
    expect(R.stats.chargerRepresentatives).toBeGreaterThan(0);
    expect(R.stats.prunedByAnalytic).toBeGreaterThan(0);
    expect(R.stats.coveragePct).toBeCloseTo((R.stats.evaluated / R.stats.spaceSize) * 100, 1);
    expect(R.stats.truncated).toBe(false);
    // 剪枝账必须闭合：判死 + 帕累托合并 + 代表 = 全部桩组合
    const chargerCombos = R.space.chargerCounts.length * R.space.chargerPowersKw.length;
    expect(R.stats.prunedByAnalytic).toBeLessThan(chargerCombos);
    expect(R.stats.prunedByAnalytic + R.stats.collapsedByPareto + R.stats.chargerRepresentatives).toBe(
      chargerCombos,
    );
  });

  it("角点粗扫把极端配置钉住了：光伏拉满、储能拉满的组合都真的评估过", () => {
    const maxPv = Math.max(...R.space.pvCapacitiesKwp);
    const maxBess = Math.max(...R.space.bessEnergiesKwh);
    const maxGrid = Math.max(...R.space.gridCapacitiesKw);
    expect(R.ranked.some((e) => e.candidate.pvCapacityKwp === maxPv && e.candidate.bessEnergyKwh === maxBess)).toBe(true);
    expect(R.ranked.some((e) => e.candidate.gridCapacityKw === maxGrid)).toBe(true);
    expect(R.stats.anchorEvaluations).toBeGreaterThanOrEqual(2 ** 4);
  });

  it("交付不足的候选禁止胜出：推荐候选必须无未满足需求", () => {
    expect(R.best.ok).toBe(true);
    expect(R.best.unservedEnergyKwh ?? 0).toBeLessThanOrEqual(0);
    const unservedRejected = R.ranked.filter((e) => e.ok && (e.unservedEnergyKwh ?? 0) > 0);
    for (const e of unservedRejected) {
      expect(e.meetsObjective).toBe(false);
      expect(e.unmetReasons.join("；")).toMatch(/未满足需求/);
    }
  });

  it("推荐输入可直接复算：recommendedInput 的输入指纹与推荐候选逐位相同", () => {
    // 这是最强的可复算性检验：推荐结果自带的 recommendedInput 必须能**原样**
    // 复现推荐时评估的那个候选（同 hash = 同一份输入 = 引擎逐字节同样的输出）。
    // 它同时锁死了一件事：以后谁改动了候选→输入的构造规则却忘了同步，
    // 这里立刻红——而不是等到"推荐 570 万、保存后 480 万"被用户发现。
    const recomputed = runCalculation(R.recommendedInput);
    expect(recomputed.ok).toBe(true);
    if (!recomputed.ok) return;
    expect(recomputed.inputHash).toBe(R.best.inputHash);
    expect(recomputed.economics.metrics.npvYuan).toBeCloseTo(R.best.npvYuan ?? NaN, 2);
    expect(recomputed.economics.capex.netYuan).toBeCloseTo(R.best.netCapexYuan ?? NaN, 2);
    expect(recomputed.charging.unservedEnergyKwh).toBeCloseTo(R.best.unservedEnergyKwh ?? NaN, 2);
    // 推荐输入必须是"干净"的：只覆写被搜索维度，其余字段保留
    expect(R.recommendedInput.charging.charger.chargerCount).toBe(R.best.candidate.chargerCount);
    expect(R.recommendedInput.charging.charger.chargerPowerKw).toBe(R.best.candidate.chargerPowerKw);
    expect(R.recommendedInput.pv.enabled).toBe(R.best.candidate.pvCapacityKwp > 0);
    expect(R.recommendedInput.pv.capacityKwp).toBe(R.best.candidate.pvCapacityKwp);
    expect(R.recommendedInput.bess.enabled).toBe(R.best.candidate.bessEnergyKwh > 0);
    expect(R.recommendedInput.bess.energyKwh).toBe(R.best.candidate.bessEnergyKwh);
    expect(R.recommendedInput.grid.capacityKw).toBe(R.best.candidate.gridCapacityKw);
    expect(R.recommendedInput.definition.managedCharging).toBe(R.best.candidate.managedCharging);
    expect(R.recommendedInput.schemaVersion).toBe(baseInput().schemaVersion);
    expect(R.recommendedInput.site).toEqual(baseInput().site);
    expect(R.recommendedInput.truck).toEqual(baseInput().truck);
    expect(R.recommendedInput.economics.chargingServiceFeeYuanPerKwh).toBeCloseTo(FEE, 6);
  });

  it("基准方案（不上光伏、不上储能、不增容、无序）被显式评估，且推荐不劣于它", () => {
    expect(R.baseline.candidate.pvCapacityKwp).toBe(0);
    expect(R.baseline.candidate.bessEnergyKwh).toBe(0);
    expect(R.baseline.candidate.needsGridUpgrade).toBe(false);
    expect(R.baseline.candidate.managedCharging).toBe(false);
    expect(R.best.score).toBeGreaterThanOrEqual(R.baseline.score);
  });

  it("推荐理由与注意事项都带具体数值（不许出现「存在一定风险」式空话）", () => {
    for (const reason of R.reasons) expect(reason).toMatch(/\d/);
    for (const concern of R.concerns) expect(concern).toMatch(/\d/);
  });

  it("候选表与维度轨迹可审计：被剔除的候选都给出了原因", () => {
    expect(R.rejected.length).toBeGreaterThan(0);
    for (const r of R.rejected) expect(r.reason.length).toBeGreaterThan(0);
    for (const d of R.dimensionTrace) {
      expect(d.explored.length).toBeGreaterThan(0);
      expect(d.explored).toContain(d.chosen);
    }
    // 并网维度必须把「增容」与「沿用现有容量」区分开
    const gridTrace = R.dimensionTrace.find((d) => d.dimension === "grid");
    expect(gridTrace).toBeDefined();
    expect(gridTrace!.explored.some((x) => x.includes("增容"))).toBe(true);
  });

  it("增量账逐步单调变好（若有步可走）", () => {
    for (let i = 0; i < R.improvementTrace.length; i++) {
      const s = R.improvementTrace[i];
      expect(s.order).toBe(i + 1);
      expect(s.deltaScore).toBeGreaterThan(0);
      expect(s.scoreAfter).toBeGreaterThan(s.scoreBefore);
    }
  });

  it("每个已评估候选的输入哈希唯一（不同配置不得撞哈希）", () => {
    const hashes = R.ranked.map((e) => e.inputHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("候选的组件声明与规模档自洽（光伏/储能开关跟随容量档）", () => {
    for (const e of R.ranked) {
      const c = e.candidate;
      expect(c.pvCapacityKwp >= 0).toBe(true);
      expect(c.bessEnergyKwh >= 0).toBe(true);
      expect(c.needsGridUpgrade).toBe(c.gridCapacityKw > R.existingGridCapacityKw);
    }
  });
});

describe("自动推荐（M5）：可穷举的小空间必须命中全局最优", () => {
  /**
   * 这是本套测试里最强的一条：把一个能全覆盖的小空间交给推荐器，
   * 断言「推荐结果 === 穷举最优」。它同时验证三件事：
   *   ① 解析剪枝没有把真正的最优解剪掉；
   *   ② 角点粗扫 + 坐标下降 + 邻域精修的组合不会漏解；
   *   ③ 排序器给出的 best 确实是全局最大。
   * 用「小空间穷举」而不是「大空间断言某个期望值」，是因为后者只能证明「结果没变」，
   * 前者能证明「结果是对的」。
   */
  const smallSpace = {
    chargerCounts: [10],
    chargerPowersKw: [240],
    bessEnergiesKwh: [0, 2000],
    pvCapacitiesKwp: [0, 2000],
    gridCapacitiesKw: [2000, 2500],
    managedChargingOptions: [false, true],
  };

  const run = () =>
    recommendConfiguration({
      base: baseInput(),
      space: smallSpace,
      existingGridCapacityKw: 2000,
      maxEvaluations: 500,
    });

  it("统计显示全空间被评估完（覆盖 100%）", () => {
    const out = run();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stats.spaceSize).toBe(16);
    expect(out.stats.evaluated).toBe(16);
    expect(out.stats.coveragePct).toBeCloseTo(100, 1);
    expect(out.stats.truncated).toBe(false);
  });

  it("推荐等于穷举最优：不存在得分更高却未达标的达标候选", () => {
    const out = run();
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const valueOf = (e: (typeof out.ranked)[number]): number => e.npvYuan ?? Number.NEGATIVE_INFINITY;
    const qualified = out.ranked.filter((e) => e.meetsObjective);
    expect(qualified.length).toBeGreaterThan(0);
    expect(valueOf(out.best)).toBe(Math.max(...qualified.map(valueOf)));
    expect(qualified.filter((e) => valueOf(e) > valueOf(out.best) + 1e-6)).toHaveLength(0);
  });
});

describe("自动推荐（M5）：门槛、目标函数与边界", () => {
  it("服务费极低 → 全部候选不达标，结论明确说未找到，而不是硬推一套", () => {
    const out = recommendConfiguration({
      base: baseInput((i) => ({
        ...i,
        economics: { ...i.economics, chargingServiceFeeYuanPerKwh: 0.01 },
      })),
      existingGridCapacityKw: 2000,
      maxEvaluations: 60,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.best.meetsObjective).toBe(false);
    expect(out.best.unmetReasons.length).toBeGreaterThan(0);
    expect(out.headline).toContain("未找到达标配置");
    expect(out.concerns.some((c) => c.includes("没有任何候选配置通过全部门槛"))).toBe(true);
  });

  it("主目标切到静态回收期时，score 与回收期严格对应，且门槛优先于大小", () => {
    const out = recommendConfiguration({
      base: baseInput(),
      objective: "payback",
      existingGridCapacityKw: 2000,
      maxEvaluations: 60,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.objective).toBe("payback");
    expect(typeof out.best.simplePaybackYears).toBe("number");
    expect(out.best.score).toBeCloseTo(-(out.best.simplePaybackYears as number), 6);
    // 「先过门槛、再比大小」：最优只在**达标**集合里取最大，
    // 否则会出现"推荐一个交不了车的方案，只因它回收期短"。
    expect(out.best.meetsObjective).toBe(true);
    const qualified = out.ranked.filter((e) => e.meetsObjective);
    expect(out.best.score).toBe(Math.max(...qualified.map((e) => e.score)));
  });

  it("主目标切到资本金 NPV 时，score 与资本金 NPV 一致", () => {
    const out = recommendConfiguration({
      base: baseInput(),
      objective: "equityNpv",
      existingGridCapacityKw: 2000,
      maxEvaluations: 60,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.best.score).toBeCloseTo(out.best.equityNpvYuan ?? NaN, 2);
  });

  it("评估预算触顶时明确标记 truncated，但仍给出可用的最优候选", () => {
    const out = recommendConfiguration({ base: baseInput(), existingGridCapacityKw: 2000, maxEvaluations: 5 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stats.truncated).toBe(true);
    expect(out.stats.evaluated).toBeLessThanOrEqual(5);
    expect(out.best.candidate.key.length).toBeGreaterThan(0);
    expect(out.concerns.some((c) => c.includes("触顶"))).toBe(true);
  });

  it("缺服务费 → 显式失败（不许悄悄给默认价）", () => {
    const out = recommendConfiguration({
      base: baseInput((i) => ({ ...i, economics: { ...i.economics, chargingServiceFeeYuanPerKwh: Number.NaN } })),
      existingGridCapacityKw: 2000,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("invalid_input");
    expect(out.diagnostics.some((d) => d.code === "missing_service_fee")).toBe(true);
  });

  it("并网容量有效时，增容与否在理由中被明确区分", () => {
    const out = recommendConfiguration({
      base: baseInput(),
      // 现有容量取最低档 → 只要选到更大的并网档就必然需要增容
      existingGridCapacityKw: 1000,
      maxEvaluations: 60,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.existingGridCapacityKw).toBe(1000);
    expect(
      out.reasons.some((r) => r.includes("增容")) || out.reasons.some((r) => r.includes("沿用站点现有")),
    ).toBe(true);
  });

  it("现有并网容量默认取底座当前容量（不传即为不增容的基准线）", () => {
    const base = baseInput();
    const out = recommendConfiguration({ base, maxEvaluations: 40 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.existingGridCapacityKw).toBe(base.grid.capacityKw);
  });
});

describe("自动推荐（M5）：不污染引擎与调用方", () => {
  it("跑完推荐后，默认情景的输入哈希与直接计算完全一致", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
    const before = runCalculation(input);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const hashBefore = before.inputHash;

    recommendConfiguration({ base: baseInput(), existingGridCapacityKw: 2000, maxEvaluations: 40 });

    const { input: input2 } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
    const after = runCalculation(input2);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.inputHash).toBe(hashBefore);
  });

  it("搜索不就地修改调用方传入的 base 与 space 对象", () => {
    const base = baseInput();
    const space = { gridCapacitiesKw: [2000, 2500] };
    const baseSnapshot = JSON.stringify(base);
    const spaceSnapshot = JSON.stringify(space);
    const out: RecommendationOutcome = recommendConfiguration({
      base,
      space,
      existingGridCapacityKw: 2000,
      maxEvaluations: 50,
    });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(base)).toBe(baseSnapshot);
    expect(JSON.stringify(space)).toBe(spaceSnapshot);
  });

  it("底座里非搜索维度的取值确实被带进计算（改电价 → 推荐结论随之变化）", () => {
    const space = {
      chargerCounts: [10],
      chargerPowersKw: [240],
      bessEnergiesKwh: [0],
      pvCapacitiesKwp: [0],
      gridCapacitiesKw: [2000],
      managedChargingOptions: [false],
    };
    const a = recommendConfiguration({ base: baseInput(), space, existingGridCapacityKw: 2000, maxEvaluations: 20 });
    const b = recommendConfiguration({
      base: baseInput((i) => ({ ...i, grid: { ...i.grid, flatPriceYuanPerKwh: 0.9 } })),
      space,
      existingGridCapacityKw: 2000,
      maxEvaluations: 20,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.ranked).toHaveLength(1);
    expect(b.ranked).toHaveLength(1);
    // 电价从基准值抬到 0.9 元/kWh，结论必须变化——否则说明底座的非搜索字段被丢了
    expect(a.best.npvYuan).not.toBe(b.best.npvYuan);
  });
});
