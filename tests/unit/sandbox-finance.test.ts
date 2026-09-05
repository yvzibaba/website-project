/**
 * 财务评价原语黄金样本（R2.2）——用**手算可核验**的整数/干净小数把 npv/irr/payback/roi/现金流构造器钉死。
 * 遵循仓库范式：确定性、无 DB、纯函数直接测；重点覆盖 §7「程序算」与 §20「诚实降级不诈算」。
 */
import { describe, it, expect } from "vitest";
import {
  FINANCE_VERSION,
  financeCalcRef,
  round,
  npv,
  irr,
  simplePaybackYears,
  discountedPaybackYears,
  roiPct,
  buildAnnualNetCashFlow,
} from "../../src/server/sandbox-finance";

describe("sandbox-finance · 版本与 calcRef", () => {
  it("FINANCE_VERSION 语义化、calcRef 携带版本", () => {
    expect(FINANCE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(financeCalcRef()).toBe(`finance@${FINANCE_VERSION}`);
  });
});

describe("round · 定点四舍五入去浮点尾噪", () => {
  it("保留指定位、-0 归一为 0、非有限原样返回", () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.34567, 2)).toBe(2.35);
    expect(round(-0.0000001, 2)).toBe(0); // -0 归一
    expect(Object.is(round(-0.004, 2), 0)).toBe(true);
    expect(Number.isNaN(round(NaN, 2))).toBe(true);
    expect(round(Infinity, 2)).toBe(Infinity);
  });
});

describe("npv · 净现值", () => {
  it("rate=0 退化为简单求和", () => {
    expect(npv(0, [-100, 30, 40, 50])).toBeCloseTo(20, 10);
  });

  it("手算：npv(0.1, [-100,110]) = -100 + 110/1.1 = 0", () => {
    expect(npv(0.1, [-100, 110])).toBeCloseTo(0, 10);
  });

  it("手算：npv(0.1, [-100,50,50,50]) 逐项折现", () => {
    const expected = -100 + 50 / 1.1 + 50 / 1.1 ** 2 + 50 / 1.1 ** 3;
    expect(npv(0.1, [-100, 50, 50, 50])).toBeCloseTo(expected, 10);
  });

  it("flows[0] 在 t=0 不折现", () => {
    // 若误把 flows[0] 当 t=1 折现，结果会 != 这个精确值
    expect(npv(0.5, [-200, 300])).toBeCloseTo(-200 + 300 / 1.5, 10);
  });

  it("诚实降级：空数组 / 非法 rate / 含非有限现金流 → NaN", () => {
    expect(Number.isNaN(npv(0.1, []))).toBe(true);
    expect(Number.isNaN(npv(-1, [-100, 110]))).toBe(true); // rate≤-1 无定义
    expect(Number.isNaN(npv(-2, [-100, 110]))).toBe(true);
    expect(Number.isNaN(npv(NaN, [-100, 110]))).toBe(true);
    expect(Number.isNaN(npv(0.1, [-100, NaN]))).toBe(true);
    expect(Number.isNaN(npv(0.1, [-100, Infinity]))).toBe(true);
  });
});

describe("irr · 区间二分 + 诚实无解", () => {
  it("手算干净根：[-100, 10, 110] 的 IRR = 0.1（NPV(0.1)=0）", () => {
    const r = irr([-100, 10, 110]);
    expect(r.ok).toBe(true);
    expect(r.value).toBeCloseTo(0.1, 5);
    expect(r.signChanges).toBe(1);
    expect(r.multipleRootsPossible).toBeFalsy();
  });

  it("与 npv 自洽：求出的 IRR 使 NPV≈0", () => {
    const flows = [-1000, 300, 420, 680, 900];
    const r = irr(flows);
    expect(r.ok).toBe(true);
    expect(npv(r.value!, flows)).toBeCloseTo(0, 3);
  });

  it("单年回本：[-100, 150] 的 IRR = 0.5", () => {
    const r = irr([-100, 150]);
    expect(r.ok).toBe(true);
    expect(r.value).toBeCloseTo(0.5, 5);
  });

  it("诚实：全同号（无符号变化）→ no_sign_change，不诈算比率", () => {
    expect(irr([100, 110, 120]).ok).toBe(false);
    expect(irr([100, 110, 120]).reason).toBe("no_sign_change");
    expect(irr([-100, -50, -30]).reason).toBe("no_sign_change");
  });

  it("诚实：根在搜索区间上界之外（IRR 高过 maxRate）→ no_bracket（不外推假数）", () => {
    // [-100, 5000] 真实 IRR = 49 = 4900%，超过 maxRate=10；
    // 区间两端 NPV 同为正（lo 端尾部发散为正、hi 端 5000/11≫100）→ 未跨零轴
    const r = irr([-100, 5000], { maxRate: 10 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_bracket");
  });

  it("弱项目仍有（负）IRR：[-100,1,1,1,1] 未回本但存在 (-1,0) 内的根，二分如实找到", () => {
    // 说明：未回本 ≠ 无 IRR。近 -1 时正尾部发散使 NPV→+∞，NPV(0)=-96<0，
    // 由介值定理存在一个负 IRR——诚实的二分应 ok:true 且 value 略小于 0。
    const r = irr([-100, 1, 1, 1, 1]);
    expect(r.ok).toBe(true);
    expect(r.value!).toBeLessThan(0);
    expect(r.value!).toBeGreaterThan(-1);
  });

  it("非法入参：长度<2 或含非有限 → invalid_input", () => {
    expect(irr([-100]).reason).toBe("invalid_input");
    expect(irr([]).reason).toBe("invalid_input");
    expect(irr([-100, NaN]).reason).toBe("invalid_input");
  });

  it("多根示警：符号变化>1 时 multipleRootsPossible=true（值仍为其中一个根）", () => {
    // 现金流 + - + 形态（先赚后投再赚），符号变化 2 次
    const r = irr([100, -250, 160]);
    expect(r.signChanges).toBe(2);
    expect(r.multipleRootsPossible).toBe(true);
  });

  it("不收敛：人为把 maxIter 压到 0 → not_converged（判据本身被诚实执行）", () => {
    const r = irr([-100, 10, 110], { maxIter: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_converged");
  });
});

describe("simplePaybackYears · 静态回收期", () => {
  it("手算插值：[-1000,300,300,300,300] 第 3~4 年间转正 → ≈3.33", () => {
    // 累计: -1000,-700,-400,-100,200 → 在第4段(从-100到+200)跨越
    // t-1=3, span=300, frac=100/300=0.333 → 3.33
    expect(simplePaybackYears([-1000, 300, 300, 300, 300])).toBeCloseTo(3.33, 2);
  });

  it("整年恰回本：[-100,50,50] → 2.0", () => {
    expect(simplePaybackYears([-100, 50, 50])).toBe(2);
  });

  it("t=0 后即已非负（flows[0]≥0）→ null（回收期无定义）", () => {
    expect(simplePaybackYears([100, 50])).toBeNull();
    expect(simplePaybackYears([0, 50])).toBeNull();
  });

  it("分析期内从未回本 → null，绝不假设迟早回本", () => {
    expect(simplePaybackYears([-1000, 100, 100, 100])).toBeNull();
  });

  it("非法：空 / 含非有限 → null", () => {
    expect(simplePaybackYears([])).toBeNull();
    expect(simplePaybackYears([-100, NaN, 200])).toBeNull();
  });
});

describe("discountedPaybackYears · 折现回收期", () => {
  it("比静态回收期更晚（折现惩罚时间价值）", () => {
    const flows = [-1000, 400, 400, 400, 400];
    const stat = simplePaybackYears(flows)!;
    const disc = discountedPaybackYears(flows, 0.1)!;
    expect(disc).toBeGreaterThan(stat);
  });

  it("rate=0 时与静态回收期一致", () => {
    const flows = [-1000, 300, 300, 300, 300];
    expect(discountedPaybackYears(flows, 0)).toBeCloseTo(simplePaybackYears(flows)!, 6);
  });

  it("非法 rate（≤-1 / 非有限）→ null", () => {
    expect(discountedPaybackYears([-100, 50, 50], -1)).toBeNull();
    expect(discountedPaybackYears([-100, 50, 50], NaN)).toBeNull();
  });
});

describe("roiPct · 全周期简单投资回报率", () => {
  it("手算：[-100,110] → inflow 110 / capex 100 = 1.1", () => {
    const r = roiPct([-100, 110]);
    expect(r.ok).toBe(true);
    expect(r.value).toBeCloseTo(1.1, 6);
  });

  it("多年求和：[-1000,300,400,500] → 1200/1000 = 1.2", () => {
    expect(roiPct([-1000, 300, 400, 500]).value).toBeCloseTo(1.2, 6);
  });

  it("无投资 flows[0]≥0 → no_investment", () => {
    expect(roiPct([100, 110]).ok).toBe(false);
    expect(roiPct([100, 110]).reason).toBe("no_investment");
  });

  it("非法：长度<2 或含非有限 → invalid_input", () => {
    expect(roiPct([-100]).reason).toBe("invalid_input");
    expect(roiPct([-100, NaN]).reason).toBe("invalid_input");
  });
});

describe("buildAnnualNetCashFlow · 现金流构造器", () => {
  it("形状 [-capex, net×life]，net=revenue-opex", () => {
    const flows = buildAnnualNetCashFlow({
      capex: 1000,
      opexAnnual: 100,
      revenueAnnual: 400,
      lifeYears: 3,
    });
    expect(flows).toEqual([-1000, 300, 300, 300]);
  });

  it("life=1 只有一年运营", () => {
    expect(
      buildAnnualNetCashFlow({ capex: 500, opexAnnual: 50, revenueAnnual: 200, lifeYears: 1 }),
    ).toEqual([-500, 150]);
  });

  it("可与 npv/irr 串联（负净现金也如实产出）", () => {
    const flows = buildAnnualNetCashFlow({
      capex: 1000,
      opexAnnual: 500,
      revenueAnnual: 300,
      lifeYears: 2,
    })!;
    expect(flows).toEqual([-1000, -200, -200]);
    // 全负后续 → IRR 无经济意义，串联验证诚实路径
    expect(irr(flows).reason).toBe("no_sign_change");
  });

  it("诚实：life<1 或任一入参非有限 → null（不产出含 NaN 的现金流）", () => {
    expect(
      buildAnnualNetCashFlow({ capex: 1000, opexAnnual: 100, revenueAnnual: 400, lifeYears: 0 }),
    ).toBeNull();
    expect(
      buildAnnualNetCashFlow({ capex: NaN, opexAnnual: 100, revenueAnnual: 400, lifeYears: 3 }),
    ).toBeNull();
  });
});

describe("确定性", () => {
  it("同入参多次调用输出完全一致（无时钟/随机/IO）", () => {
    const flows = [-1000, 300, 420, 680, 900];
    const a = irr(flows);
    const b = irr(flows);
    expect(a).toEqual(b);
    expect(npv(0.08, flows)).toBe(npv(0.08, flows));
  });
});
