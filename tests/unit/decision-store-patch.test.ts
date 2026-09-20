import { describe, expect, it } from "vitest";
import { applyScenarioPatch, decisionSnapshotToColumns, computeDecisionSnapshot } from "@app/kernel/server/decision-store";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import type { ScenarioInput } from "@app/kernel/engine/types";

/**
 * 增量补丁合并的语义（纯函数，不连库）。
 *
 * 这组用例守的是一个**很容易被忽略、后果又很隐蔽**的失败：
 * 前端在构造补丁时留下 `{ note: undefined }` 这类键，若用 `{...base, ...patch}` 合并，
 * 会把一个本来有值的字段悄悄抹掉。用户只改了一个参数，却丢了另一处数据，
 * 而且页面上不会报任何错——这正是本仓库最不接受的失败方式。
 */

const FEE = 0.45;

function base(): ScenarioInput {
  const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
  return { ...input, name: "基线情景", note: "这段备注不能被静默抹掉" };
}

describe("情景增量补丁：透明且不丢数据", () => {
  it("显式 undefined 的键被跳过（视为「没提这件事」），不抹掉原值", () => {
    const b = base();
    const merged = applyScenarioPatch(b, { note: undefined, name: undefined });
    expect(merged.note).toBe("这段备注不能被静默抹掉");
    expect(merged.name).toBe("基线情景");
  });

  it("显式 null 的键照写（那是「明确要置空」的意图，不能替用户反悔）", () => {
    const b = base();
    const merged = applyScenarioPatch(b, { note: null as unknown as string });
    expect(merged.note).toBeNull();
  });

  it("嵌套对象做一层合并：只改一个字段不会把同层其他字段重置", () => {
    const b = base();
    const merged = applyScenarioPatch(b, { truck: { truckCount: b.truck.truckCount + 7 } as never });
    expect(merged.truck.truckCount).toBe(b.truck.truckCount + 7);
    // 同层未被提及的字段必须原样保留
    expect(merged.truck.dailyMileageKm).toBe(b.truck.dailyMileageKm);
    expect(merged.truck.chargingWindowStartHour).toBe(b.truck.chargingWindowStartHour);
    expect(merged.truck.energyConsumptionKwhPerKm).toBe(b.truck.energyConsumptionKwhPerKm);
  });

  it("嵌套对象里的 undefined 同样被跳过（表单空值不会击穿一层）", () => {
    const b = base();
    const merged = applyScenarioPatch(b, {
      economics: { chargingServiceFeeYuanPerKwh: FEE + 0.1, swapServiceFeeYuanPerKwh: undefined } as never,
    });
    expect(merged.economics.chargingServiceFeeYuanPerKwh).toBeCloseTo(FEE + 0.1, 9);
    expect(merged.economics.swapServiceFeeYuanPerKwh).toBe(b.economics.swapServiceFeeYuanPerKwh);
  });

  it("数组整体替换，不做元素级合并（避免合并出四不像）", () => {
    const b = base();
    const merged = applyScenarioPatch(b, { definition: { components: ["GRID", "CHARGING"] } as never });
    expect(merged.definition.components).toEqual(["GRID", "CHARGING"]);
  });

  it("空补丁得到与原输入等价的输入（哈希不变）", () => {
    const b = base();
    const merged = applyScenarioPatch(b, {});
    expect(JSON.stringify(merged)).toBe(JSON.stringify(b));
  });

  it("补丁合并后喂引擎仍算得通，且指标确实随补丁变化", () => {
    const b = base();
    const k = applyScenarioPatch(b, { economics: { chargingServiceFeeYuanPerKwh: FEE + 0.2 } as never });
    const a = computeDecisionSnapshot(b, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    const c = computeDecisionSnapshot(k, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    expect(a.ok && c.ok).toBe(true);
    if (!a.ok || !c.ok) return;
    expect(c.snapshot.calc.inputHash).not.toBe(a.snapshot.calc.inputHash);
    expect(c.snapshot.calc.economics.metrics.npvYuan).not.toBeCloseTo(a.snapshot.calc.economics.metrics.npvYuan, 2);
    // 备注没被碰过 → 输入快照里仍在
    expect(c.snapshot.calc.inputSnapshot.note).toBe("这段备注不能被静默抹掉");
  });
});

describe("落库列映射：失败口径不得留下任何数字", () => {
  it("成功映射：关键指标逐分写入，且带齐版本指纹", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
    const computed = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    const cols = decisionSnapshotToColumns(computed.snapshot);
    const m = computed.snapshot.calc.economics.metrics;

    expect(cols.calcStatus).toBe("ok");
    expect(cols.engineVersion).toBe(computed.snapshot.calc.calcRef);
    expect(cols.inputHash).toBe(computed.snapshot.calc.inputHash);
    expect(Number(cols.npv)).toBeCloseTo(m.npvYuan, 2);
    expect(Number(cols.capexNet)).toBeCloseTo(computed.snapshot.calc.economics.capex.netYuan, 2);
    // 映射出来的都是「定点小数字符串」，不能是科学计数法或 Infinity
    for (const v of [cols.npv, cols.capexNet, cols.irrPct, cols.lcoeYuanPerKwh, cols.npvEquity, cols.irrEquityPct]) {
      expect(typeof v).toBe("string");
      expect(Number.isFinite(Number(v))).toBe(true);
      expect(v!).not.toMatch(/e/i);
    }
    // 落库的输入就是实际参与计算的那份（不是外面另传一份）
    expect(JSON.stringify(cols.scenarioInput)).toBe(JSON.stringify(computed.snapshot.calc.inputSnapshot));
  });

  it("IRR 不收敛（ok:false）时该列必须是 null，不能填 0 冒充", () => {
    const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
    const computed = computeDecisionSnapshot(input, { generatedAtIso: "2026-01-01T00:00:00.000Z" });
    if (!computed.ok) throw new Error("引擎算不出来");
    const cols = decisionSnapshotToColumns(computed.snapshot);
    if (!computed.snapshot.calc.economics.metrics.irr.ok) {
      expect(cols.irrPct).toBeNull();
    }
    // 无论是否收敛，列值都必须与引擎口径一致（或为 null）
    if (computed.snapshot.calc.economics.metrics.irr.ok) {
      expect(Number(cols.irrPct)).toBeCloseTo(computed.snapshot.calc.economics.metrics.irr.valuePct!, 4);
    }
  });
});
