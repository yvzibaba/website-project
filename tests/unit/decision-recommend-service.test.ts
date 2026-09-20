import { describe, expect, it } from "vitest";
import { defaultScenarioInput } from "@app/kernel/engine/scenario";
import { recommendPreview, recommendRequestSchema } from "@app/kernel/server/decision-service";

/**
 * 服务层契约测试：`/api/workbench/decision/recommend` 背后的 `recommendPreview`。
 *
 * 这里验的是**边界**而不是算法（算法由 `engine-recommend.test.ts` 负责）：
 * 输入契约是否真的拦住了坏请求、错误是否被翻译成统一的 invalid 分支、
 * 以及"没达标"是否被如实回报而不是伪装成成功。
 */

const FEE = 0.45;

function basePayload(): Record<string, unknown> {
  const { input } = defaultScenarioInput({ chargingServiceFeeYuanPerKwh: FEE });
  return JSON.parse(JSON.stringify({ ...input, truck: { ...input.truck, truckCount: 30, dailyMileageKm: 300 } })) as Record<
    string,
    unknown
  >;
}

/** 压到最小空间，让服务层测试不至于把每次用例都跑成一整轮搜索。 */
const tinySpace = {
  chargerCounts: [10],
  chargerPowersKw: [240],
  bessEnergiesKwh: [0],
  pvCapacitiesKwp: [0],
  gridCapacitiesKw: [2000],
  managedChargingOptions: [false],
};

describe("推荐服务层：输入契约", () => {
  it("合法请求：返回 recommended:true 与完整结果", () => {
    const out = recommendPreview({
      body: { base: basePayload(), space: tinySpace, maxEvaluations: 20 },
    });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.recommended).toBe(true);
    const result = out.result as Record<string, unknown> | null;
    expect(result).not.toBeNull();
    expect(result!.recommendRef).toMatch(/^recommend@/);
    expect(result!.recommendedInput).toBeTruthy();
  });

  it("缺少服务费 → invalid（服务费是市场调节价，绝不允许代填默认值）", () => {
    const base = basePayload();
    const economics = base.economics as Record<string, unknown>;
    delete economics.chargingServiceFeeYuanPerKwh;
    const out = recommendPreview({ body: { base, space: tinySpace } });
    expect(out.status).toBe("invalid");
    if (out.status !== "invalid") return;
    const all = Object.values(out.fieldErrors).flat().join("；");
    expect(all).toContain("服务费");
  });

  it("非法主目标 → invalid", () => {
    const out = recommendPreview({ body: { base: basePayload(), objective: "profit" } });
    expect(out.status).toBe("invalid");
  });

  it("评估预算越界 → invalid（防止该端点沦为匿名算力入口）", () => {
    const tooBig = recommendPreview({ body: { base: basePayload(), maxEvaluations: 2001 } });
    expect(tooBig.status).toBe("invalid");
    const tooSmall = recommendPreview({ body: { base: basePayload(), maxEvaluations: 0 } });
    expect(tooSmall.status).toBe("invalid");
  });

  it("档位数组为空 → invalid", () => {
    const out = recommendPreview({ body: { base: basePayload(), space: { chargerCounts: [] } } });
    expect(out.status).toBe("invalid");
  });

  it("底座不是对象 → invalid", () => {
    const out = recommendPreview({ body: { base: "not-an-object" } });
    expect(out.status).toBe("invalid");
  });

  it("请求体缺 base → invalid", () => {
    const out = recommendPreview({ body: {} });
    expect(out.status).toBe("invalid");
  });
});

describe("推荐服务层：结果诚实性", () => {
  it("服务费极低时：仍返回 recommended:true，但结果里明确标记未达标（不伪装成成功）", () => {
    const base = basePayload();
    (base.economics as Record<string, unknown>).chargingServiceFeeYuanPerKwh = 0.01;
    const out = recommendPreview({ body: { base, space: tinySpace, maxEvaluations: 20 } });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.recommended).toBe(true);
    const result = out.result as { best: { meetsObjective: boolean; unmetReasons: string[] }; headline: string };
    expect(result.best.meetsObjective).toBe(false);
    expect(result.best.unmetReasons.length).toBeGreaterThan(0);
    expect(result.headline).toContain("未找到达标配置");
  });

  it("请求契约本身可独立使用（schema safeParse 与 service 结论一致）", () => {
    const body = { base: basePayload(), space: tinySpace, maxEvaluations: 20 };
    expect(recommendRequestSchema.safeParse(body).success).toBe(true);
    expect(recommendRequestSchema.safeParse({ base: basePayload(), objective: "nope" }).success).toBe(false);
  });
});
