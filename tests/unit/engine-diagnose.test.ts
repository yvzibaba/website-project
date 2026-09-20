import { describe, it, expect } from "vitest";
import {
  DIAGNOSE_VERSION,
  diagnoseCalcRef,
  diagnoseScenario,
  type DiagnosisOutcome,
} from "@app/kernel/engine/diagnose";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import { ENGINE_VERSION, MODEL_VERSION } from "@app/kernel/engine/engine";
import { BENCHMARK_VERSION } from "@app/kernel/engine/benchmark";
import type { ScenarioInput } from "@app/kernel/engine/types";

/* 诊断是"结论投影"层，不是第二台引擎。故这里的断言只钉：
   ① 判向规则（feasible / NPV>0 两条客观事实）② 确定性 ③ 诚实边界
   （无时钟/随机、无虚构联系方式、算不通时不假装出数）。
   金额本身不在这里钉死——那由引擎黄金基线负责，避免同一处数值两处维护。 */

const FEE = 0.45;

function baseInput(): ScenarioInput {
  return defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE, templateId: "pv-bess-tou" }).input;
}

function withFee(fee: number): ScenarioInput {
  return defaultScenarioInput({ chargingServiceFeeYuanPerKwh: fee, templateId: "pv-bess-tou" }).input;
}

describe("免费诊断 · 契约与元数据", () => {
  it("版本与追溯字段与内核常量一致", () => {
    const out = diagnoseScenario(baseInput()) as DiagnosisOutcome;
    expect(out.ok).toBe(true);
    expect(out.diagnoseRef).toBe(`diag@${DIAGNOSE_VERSION}`);
    expect(diagnoseCalcRef()).toBe(`diag@${DIAGNOSE_VERSION}`);
    expect(out.engineVersion).toBe(ENGINE_VERSION);
    expect(out.modelVersion).toBe(MODEL_VERSION);
    expect(out.benchmarkVersion).toBe(BENCHMARK_VERSION);
    expect(out.needsProfessionalReview).toBe(true);
  });

  it("判向落在四档之内，且成功计算时给出非空输入指纹", () => {
    const out = diagnoseScenario(baseInput());
    expect(["not_computable", "infeasible", "borderline", "promising"]).toContain(out.verdict);
    if (out.verdict !== "not_computable") {
      expect(out.inputHash.length).toBeGreaterThan(0);
    }
    expect(out.headline.length).toBeGreaterThan(0);
    expect(out.deepWorkWithheld.length).toBeGreaterThan(0);
  });
});

describe("免费诊断 · 判向规则（只用两条客观事实）", () => {
  it("高服务费 → 收入抬起来 → 倾向为正（promising）且 NPV>0、硬约束通过", () => {
    const out = diagnoseScenario(withFee(1.5));
    expect(out.keyNumbers.feasible).toBe(true);
    expect(out.keyNumbers.npvSign).toBe("positive");
    expect(out.verdict).toBe("promising");
  });

  it("极低服务费 → 不划算（borderline）或不可行，但绝不谎报为正", () => {
    const out = diagnoseScenario(withFee(0.01));
    if (out.keyNumbers.feasible === true) {
      // 可行但几乎无收入：不应被判为 promising
      expect(out.verdict).not.toBe("promising");
    }
  });

  it("服务费更高时全投资 NPV 单调不减（收入直接进 NPV，不是噪声）", () => {
    const low = diagnoseScenario(withFee(0.3)).keyNumbers.npvYuan;
    const high = diagnoseScenario(withFee(1.5)).keyNumbers.npvYuan;
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect((high as number) ?? 0).toBeGreaterThan((low as number) ?? 0);
  });
});

describe("免费诊断 · 明显否证", () => {
  it("算不出可信结果 → not_computable，且一定给得出理由（不留空白）", () => {
    const input = baseInput();
    // 触发引擎结构校验致命项：并网容量必须 > 0。
    input.grid.capacityKw = 0;
    const out = diagnoseScenario(input);
    expect(out.verdict).toBe("not_computable");
    expect(out.inputHash).toBe(""); // 如实留空，绝不拿 calcRef 冒充哈希
    expect(out.falsifications.length).toBeGreaterThan(0);
    // 否证里必须能追溯到引擎原因，而不是泛泛而谈。
    expect(out.falsifications.some((f) => f.message.length > 0)).toBe(true);
  });

  it("充电配不足以满足车队 → 出现 charging_unserved_energy 否证（或判为不可行）", () => {
    const input = baseInput();
    input.truck.truckCount = 400; // 车队巨大
    input.charging.charger.chargerCount = 1; // 只给一根桩
    const out = diagnoseScenario(input);
    const unserved = out.keyNumbers.unservedEnergyKwh;
    const hasUnservedFalsifier = out.falsifications.some((f) => f.code === "charging_unserved_energy");
    const infeasible = out.verdict === "infeasible" || out.verdict === "not_computable";
    expect((unserved != null && unserved > 0 && hasUnservedFalsifier) || infeasible).toBe(true);
  });
});

describe("免费诊断 · 确定性与诚实边界", () => {
  it("同一输入两次调用逐字节相同（纯函数、无随机）", () => {
    const a = diagnoseScenario(baseInput());
    const b = diagnoseScenario(baseInput());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("输出不含耗时/日期时间戳（可复算、可缓存、可跨环境比对）", () => {
    const json = JSON.stringify(diagnoseScenario(baseInput()));
    expect(json).not.toMatch(/elapsedMs/i);
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO 日期时间
  });

  it("出口话术不虚构联系方式（无手机号、无邮箱）", () => {
    const out = diagnoseScenario(baseInput());
    const text = out.paidNextStep + " " + out.confidenceNote;
    expect(text).not.toMatch(/1[3-9]\d{9}/); // 大陆手机号
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/); // 邮箱
    expect(text).not.toMatch(/微信|wx[:：]/i); // 微信号
  });
});
