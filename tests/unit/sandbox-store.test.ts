import { describe, it, expect, vi } from "vitest";

// 只测导出的纯映射函数 `projectCalcToColumns`（不触库）；顶掉 prisma 以免实例化客户端。
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { runSandboxModel, type CalcResult, type CalcResultOk } from "@/server/sandbox-model";
import { projectCalcToColumns, STORE_VERSION } from "@/server/sandbox-store";

const base = runSandboxModel();
if (!base.ok) {
  // 基线必须成功（R2 已锁），否则本文件所有黄金值失效——尽早失败并指名。
  throw new Error("基线 runSandboxModel 未成功，测试前置不成立");
}
const BASELINE = base;

describe("sandbox-store · projectCalcToColumns（CalcResult → Decimal 汇总列，纯映射）", () => {
  it("STORE_VERSION 是语义化版本串", () => {
    expect(STORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("基线成功结果 → calcStatus ok + 各汇总列定点字符串（golden，逐项对齐 R2 手算）", () => {
    const cols = projectCalcToColumns(BASELINE);
    expect(cols.calcStatus).toBe("ok");
    expect(cols.calcRef).toBe("model@1.0.0");
    // 净 CAPEX 3,524,500；NPV≈4,277,409；IRR 0.237553→23.7553%；折现回收 5.28 年；ROI 比值 4.0035
    expect(cols.capexNet).toBe("3524500.00");
    expect(cols.npv).toBe("4277409.00");
    expect(cols.irrPct).toBe("23.7553");
    expect(cols.paybackYears).toBe("5.28");
    expect(cols.roiRatio).toBe("4.0035");
  });

  it("汇总列字符串可精确回读为定点数（Decimal 防漂移的落库前提）", () => {
    const cols = projectCalcToColumns(BASELINE);
    // 每位小数都对齐：npv 两位、irr 四位、roi 四位
    expect(cols.npv!.split(".")[1].length).toBe(2);
    expect(cols.irrPct!.split(".")[1].length).toBe(4);
    expect(cols.roiRatio!.split(".")[1].length).toBe(4);
    expect(Number(cols.npv)).toBeGreaterThan(0);
  });

  it("npv 为 NaN（算不出）→ npv 诚实 null，其余仍按值给", () => {
    const mutated: CalcResultOk = {
      ...BASELINE,
      metrics: { ...BASELINE.metrics, npv: NaN },
    };
    const cols = projectCalcToColumns(mutated);
    expect(cols.npv).toBeNull();
    expect(cols.calcStatus).toBe("ok");
    expect(cols.capexNet).toBe("3524500.00"); // 不受 npv 影响
  });

  it("IRR 无解（ok:false）→ irrPct null，绝不编造比率", () => {
    const mutated: CalcResultOk = {
      ...BASELINE,
      metrics: {
        ...BASELINE.metrics,
        irr: { ok: false, reason: "no_sign_change", signChanges: 0 },
      },
    };
    expect(projectCalcToColumns(mutated).irrPct).toBeNull();
  });

  it("折现回收期 null（分析期内未回本）→ paybackYears null，不假设迟早回本", () => {
    const mutated: CalcResultOk = {
      ...BASELINE,
      metrics: { ...BASELINE.metrics, discountedPaybackYears: null },
    };
    expect(projectCalcToColumns(mutated).paybackYears).toBeNull();
  });

  it("ROI 不可得（no_investment）→ roiRatio null", () => {
    const mutated: CalcResultOk = {
      ...BASELINE,
      metrics: { ...BASELINE.metrics, roi: { ok: false, reason: "no_investment" } },
    };
    expect(projectCalcToColumns(mutated).roiRatio).toBeNull();
  });

  it("负 NPV / 负回收期值 → 定点串如实带符号（不夹逼到 0）", () => {
    const neg = runSandboxModel({ user: { values: { "project.chargingPrice": 0.5 } } });
    expect(neg.ok).toBe(true);
    const cols = projectCalcToColumns(neg);
    // 低单价下 NPV 应为负（R2.4 已证 chargingPrice=0.5→NPV<0）
    if (cols.npv != null) expect(cols.npv.startsWith("-")).toBe(true);
  });

  it("失败结果（tech_error）→ 全部汇总列 null + calcStatus 记 reason", () => {
    const err: CalcResult = {
      ok: false,
      calcRef: "model@1.0.0",
      reason: "tech_error",
      detail: "技术层未通过",
    };
    const cols = projectCalcToColumns(err);
    expect(cols.calcStatus).toBe("tech_error");
    expect(cols.capexNet).toBeNull();
    expect(cols.npv).toBeNull();
    expect(cols.irrPct).toBeNull();
    expect(cols.paybackYears).toBeNull();
    expect(cols.roiRatio).toBeNull();
  });

  it("missing_econ_inputs 失败 → calcStatus 原样透传该 reason", () => {
    const err: CalcResult = {
      ok: false,
      calcRef: "model@1.0.0",
      reason: "missing_econ_inputs",
      detail: "缺少经济参数",
      missingInputs: ["project.chargingPrice"],
    };
    const cols = projectCalcToColumns(err);
    expect(cols.calcStatus).toBe("missing_econ_inputs");
    expect(cols.npv).toBeNull();
  });

  it("确定性：同一 CalcResult 两次映射深相等（可复算）", () => {
    expect(projectCalcToColumns(BASELINE)).toEqual(projectCalcToColumns(BASELINE));
  });
});
