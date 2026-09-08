/**
 * 冻结策略单元测试（创始人裁决 2026-09-08「历史项目"生成时模型版本"冻结策略」，STORE_VERSION 1.0.3）。
 *
 * 覆盖两个纯函数（离线、无 DB）：
 *   - `shouldAutoFreezeVersion`：内核身份变化（calcRef / engineVersions 指纹，含历史行缺版本键）⇒ 冻结；
 *     同内核普通参数编辑 / 旧结果缺失或失败 ⇒ 不冻结。
 *   - `frozenVersionSummary`：冻结 calcResult JSON **原样提取**（不重算），复用 projectCalcToColumns
 *     同一四舍五入口径；历史快照缺 storage 键 → null（API 层映射 "none"）；损坏 JSON 诚实降级 unreadable。
 * 同时钉桩：STORAGE_MODEL_VERSION 仅元数据（进 engineVersions 快照），经济结果零 churn 由既有黄金测试保证。
 */
import { describe, it, expect } from "vitest";
import { shouldAutoFreezeVersion, frozenVersionSummary, STORE_VERSION } from "@/server/sandbox-store";
import { STORAGE_MODEL_VERSION } from "@/server/sandbox-storage-value";

const EV_NEW = { model: "1.1.0", tech: "1.0.0", finance: "1.0.0", params: "1.2.0", storage: "1.0.0" };
const EV_LEGACY = { model: "1.0.0", tech: "1.0.0", finance: "1.0.0", params: "1.1.0" };

describe("sandbox-store 冻结策略 · STORE_VERSION / STORAGE_MODEL_VERSION", () => {
  it("STORE_VERSION 升至 1.0.3（语义化版本串）", () => {
    expect(STORE_VERSION).toBe("1.0.3");
  });

  it("STORAGE_MODEL_VERSION = 1.0.0（R9.0 首接生产经济层的口径，仅元数据）", () => {
    expect(STORAGE_MODEL_VERSION).toBe("1.0.0");
  });
});

describe("sandbox-store 冻结策略 · shouldAutoFreezeVersion（判据表）", () => {
  const base = {
    oldCalcRef: "model@1.0.0" as string | null,
    oldCalcResult: { ok: true, calcRef: "model@1.0.0", engineVersions: EV_LEGACY },
    nextCalcRef: "model@1.1.0",
    nextEngineVersions: EV_NEW,
  };

  it("模型升版（calcRef 变）→ 冻结，why 记录新旧 calcRef", () => {
    const r = shouldAutoFreezeVersion(base);
    expect(r.freeze).toBe(true);
    expect(r.why).toContain("model@1.0.0");
    expect(r.why).toContain("model@1.1.0");
  });

  it("同 calcRef 但 engineVersions 指纹变（storage 键补上）→ 冻结", () => {
    const r = shouldAutoFreezeVersion({
      ...base,
      oldCalcRef: "model@1.1.0",
      oldCalcResult: { ok: true, calcRef: "model@1.1.0", engineVersions: { ...EV_NEW, storage: undefined } },
      nextCalcRef: "model@1.1.0",
    });
    // storage: undefined 在 JSON 序列化后等同缺键 → 指纹不同
    expect(r.freeze).toBe(true);
    expect(r.why).toContain("engineVersions");
  });

  it("历史行完全没有 engineVersions 键（更老数据）→ 首次再编辑即受保护（冻结）", () => {
    const r = shouldAutoFreezeVersion({
      ...base,
      oldCalcRef: "model@1.1.0",
      oldCalcResult: { ok: true, calcRef: "model@1.1.0" },
      nextCalcRef: "model@1.1.0",
    });
    expect(r.freeze).toBe(true);
    expect(r.why).toContain("engineVersions");
  });

  it("同内核普通参数编辑（calcRef 与指纹全同）→ 不冻结（§4 日常路径）", () => {
    const r = shouldAutoFreezeVersion({
      oldCalcRef: "model@1.1.0",
      oldCalcResult: { ok: true, calcRef: "model@1.1.0", engineVersions: EV_NEW },
      nextCalcRef: "model@1.1.0",
      nextEngineVersions: EV_NEW,
    });
    expect(r.freeze).toBe(false);
  });

  it("jsonb 键序回归钉桩：指纹比较与键序无关（Postgres jsonb 读回不保序）→ 同内核不冻结", () => {
    const r = shouldAutoFreezeVersion({
      oldCalcRef: "model@1.1.0",
      oldCalcResult: {
        ok: true,
        calcRef: "model@1.1.0",
        // 键序被打乱（jsonb 规范化后的读回形态，键按长度+字节序重排）
        engineVersions: { storage: "1.0.0", params: "1.2.0", finance: "1.0.0", tech: "1.0.0", model: "1.1.0" },
      },
      nextCalcRef: "model@1.1.0",
      nextEngineVersions: EV_NEW, // 引擎插入序 model/tech/finance/params/storage
    });
    expect(r.freeze).toBe(false);
  });

  it("旧结果为失败快照（ok:false）→ 不冻结（失败态不是结论，覆写无损失）", () => {
    const r = shouldAutoFreezeVersion({
      ...base,
      oldCalcResult: { ok: false, calcRef: "model@1.0.0", reason: "tech_error" },
    });
    expect(r.freeze).toBe(false);
  });

  it("旧结果缺失（null / 非对象）→ 不冻结", () => {
    expect(shouldAutoFreezeVersion({ ...base, oldCalcResult: null }).freeze).toBe(false);
    expect(shouldAutoFreezeVersion({ ...base, oldCalcResult: "garbage" }).freeze).toBe(false);
  });
});

describe("sandbox-store 冻结策略 · frozenVersionSummary（原样提取，不重算）", () => {
  it("现代成功快照 → 指标定点串（复用 projectCalcToColumns 口径）+ storage 版本齐全", () => {
    const snap = {
      ok: true,
      calcRef: "model@1.1.0",
      engineVersions: EV_NEW,
      capex: { net: 1234.56 },
      opexY1: { gross: 77 },
      metrics: {
        npv: 2222.5,
        irr: { ok: true, value: 0.1234 },
        discountedPaybackYears: 5.14,
        roi: { ok: true, value: 0.4 },
      },
    };
    const s = frozenVersionSummary(snap);
    expect(s.calcStatus).toBe("ok");
    expect(s.calcRef).toBe("model@1.1.0");
    expect(s.capexNet).toBe("1234.56");
    expect(s.opexY1Gross).toBe("77.00");
    expect(s.npv).toBe("2222.50");
    expect(s.irrPct).toBe("12.3400");
    expect(s.paybackYears).toBe("5.14");
    expect(s.roiRatio).toBe("0.4000");
    expect(s.engineVersions).toEqual({ ...EV_NEW, storage: "1.0.0" });
  });

  it("历史快照（缺 storage 键、model 1.0.0）→ 指标照常提取，storage 诚实 null（API 层映射 none）", () => {
    const snap = {
      ok: true,
      calcRef: "model@1.0.0",
      engineVersions: EV_LEGACY,
      capex: { net: 111.11 },
      opexY1: { gross: 22.22 },
      metrics: {
        npv: 333.33,
        irr: { ok: true, value: 0.05 },
        discountedPaybackYears: 4.5,
        roi: { ok: true, value: 0.25 },
      },
    };
    const s = frozenVersionSummary(snap);
    expect(s.calcStatus).toBe("ok");
    expect(s.capexNet).toBe("111.11");
    expect(s.npv).toBe("333.33");
    expect(s.irrPct).toBe("5.0000");
    expect(s.paybackYears).toBe("4.50");
    expect(s.roiRatio).toBe("0.2500");
    expect(s.engineVersions.model).toBe("1.0.0");
    expect(s.engineVersions.storage).toBeNull();
  });

  it("失败快照 → calcStatus 记 reason，指标全 null（诚实，绝不编数）", () => {
    const s = frozenVersionSummary({ ok: false, calcRef: "model@1.1.0", reason: "missing_econ_inputs" });
    expect(s.calcStatus).toBe("missing_econ_inputs");
    expect(s.calcRef).toBe("model@1.1.0");
    expect(s.capexNet).toBeNull();
    expect(s.npv).toBeNull();
  });

  it("损坏 JSON（非对象 / 缺关键字段）→ 降级 unreadable，绝不抛错", () => {
    expect(frozenVersionSummary("garbage").calcStatus).toBe("unreadable");
    expect(frozenVersionSummary(null).calcStatus).toBe("unreadable");
    const s = frozenVersionSummary({ ok: true, calcRef: "model@1.1.0" }); // ok:true 但缺 capex/metrics
    expect(s.calcStatus).toBe("unreadable");
    expect(s.npv).toBeNull();
    expect(s.engineVersions.storage).toBeNull();
  });
});
