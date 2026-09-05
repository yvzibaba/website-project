import { describe, it, expect, vi } from "vitest";

// 只测导出的纯函数 `toEngineLayers`（不触库）；顶掉 prisma/logger 以免实例化客户端。
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { toEngineLayers, type StoredParamLayers } from "@/server/sandbox-store";
import { runSandboxModel } from "@/server/sandbox-model";
import { buildSandboxLayers } from "@/server/sandbox-regions";

/**
 * R6.3 命脉正确性回归（政策日期窗 §6 + 时钟 now 持久化回放）。
 *
 * 真正会翻车的不是「全字符串」——ISO 8601 串按字典序==按时间序，纯串比较仍正确。
 * 危险在**混合**：`now` 是 Date、而某层 `effectiveFrom/Until` 是 JSON 反序列化出的字符串时，
 * 关系运算 `Date < "2024-…"` 走「非双字符串」分支 → 两边都 `Number()` → 串变 `NaN` → 比较恒 false
 * → 本该「未生效 / 已过期」的政策被**误判为现行**。`toEngineLayers` 把 now 与各层日期窗一律复活为
 * 真正的 `Date`，从根上消灭这条混合路径，并让「落库快照 → 回放重算」逐位可复算（§4 / 规则 7 / §9）。
 */

const NOW_ACTIVE = "2026-06-01T00:00:00.000Z"; // 2024 现行窗口内
const NOW_BEFORE = "2020-06-01T00:00:00.000Z"; // 2024 政策尚未生效
const shanxiStr = (now: string) => buildSandboxLayers("shanxi", {}, new Date(now));

describe("sandbox-store · toEngineLayers（R6.3 复活 now / 政策日期窗）", () => {
  it("空分层 → 不注入任何键（保持既有「仅默认」行为，兼容 R3 集成测试）", () => {
    const out = toEngineLayers({});
    expect(out).toEqual({});
    expect("now" in out).toBe(false);
    expect("region" in out).toBe(false);
    expect("policy" in out).toBe(false);
  });

  it("ISO 串 now → 复活为真正的 Date 实例（不是字符串）", () => {
    const out = toEngineLayers({ now: NOW_ACTIVE } as StoredParamLayers);
    expect(out.now).toBeInstanceOf(Date);
    expect(out.now!.toISOString()).toBe(NOW_ACTIVE);
  });

  it("无效 / 缺失 now → 不注入该键（绝不塞 Invalid Date 污染引擎）", () => {
    expect(toEngineLayers({ now: "not-a-date" } as StoredParamLayers)).not.toHaveProperty("now");
    expect(toEngineLayers({ now: null } as StoredParamLayers)).not.toHaveProperty("now");
    expect(toEngineLayers({} as StoredParamLayers)).not.toHaveProperty("now");
  });

  it("policy 层 effectiveFrom/Until（JSON 串）→ 逐个复活为 Date；无窗的层不注入空键", () => {
    const layers = {
      policy: [
        { values: { "policy.x": 1 }, effectiveFrom: "2024-01-01T00:00:00.000Z", effectiveUntil: "2099-12-31T00:00:00.000Z" },
        { values: { "policy.y": 2 } },
      ],
    } as unknown as StoredParamLayers;
    const out = toEngineLayers(layers);
    expect(out.policy).toHaveLength(2);
    expect(out.policy![0].effectiveFrom).toBeInstanceOf(Date);
    expect(out.policy![0].effectiveUntil).toBeInstanceOf(Date);
    expect(out.policy![1]).not.toHaveProperty("effectiveFrom");
    expect(out.policy![1]).not.toHaveProperty("effectiveUntil");
  });

  it("★§6 实证：同一山西输入，now 落在 2024 政策窗口内 vs 之前 → NPV 必不同（现行政策确有生效）", () => {
    const active = runSandboxModel(shanxiStr(NOW_ACTIVE));
    const before = runSandboxModel(shanxiStr(NOW_BEFORE));
    expect(active.ok).toBe(true);
    expect(before.ok).toBe(true);
    if (active.ok && before.ok) {
      // 现行补贴 / 上网价生效 → 结果不同于「政策尚未生效」；若相等说明政策层被静默吞掉。
      expect(active.metrics.npv).not.toBeCloseTo(before.metrics.npv, 2);
    }
  });

  it("★命脉可复算：山西此刻保存的输入，JSON 落库（全串）后回放重算与原值逐位相同", () => {
    const original = shanxiStr(NOW_ACTIVE);
    const direct = runSandboxModel(original);
    expect(direct.ok).toBe(true);
    const fromDb = JSON.parse(JSON.stringify(original)) as StoredParamLayers; // Date→串（正是回放入口）
    const replay = runSandboxModel(toEngineLayers(fromDb));
    expect(replay.ok).toBe(true);
    if (direct.ok && replay.ok) {
      expect(replay.metrics.npv).toBeCloseTo(direct.metrics.npv, 6);
      expect(replay.calcRef).toBe(direct.calcRef);
    }
  });

  it("★混合护栏：now=Date 而政策窗=串（未复活）会把 2024 政策误判为现行；复活后回到正确值", () => {
    // 正确基线：now=Date(2020)，政策窗=Date → 2024 政策「尚未生效」→ 应被跳过。
    const correct = runSandboxModel(shanxiStr(NOW_BEFORE));
    expect(correct.ok).toBe(true);
    // 混合态：now 保持 Date(2020)，但政策 effectiveFrom/Until 被 JSON 化成字符串（模拟半路落库回读）。
    const mixed = {
      ...shanxiStr(NOW_BEFORE),
      policy: JSON.parse(JSON.stringify(shanxiStr(NOW_BEFORE).policy)),
    };
    const naive = runSandboxModel(mixed); // 未复活：Date<串 → NaN → 比较恒 false → 2024 政策被误当现行
    const revived = runSandboxModel(toEngineLayers(mixed as StoredParamLayers)); // 复活 → Date 比 Date → 正确跳过
    expect(naive.ok).toBe(true);
    expect(revived.ok).toBe(true);
    if (correct.ok && naive.ok && revived.ok) {
      // 未复活的错误结果 ≠ 正确结果（证明混合场景真实翻车 → 修复必要）。
      expect(naive.metrics.npv).not.toBeCloseTo(correct.metrics.npv, 2);
      // 复活后的结果 = 正确结果（修复到位）。
      expect(revived.metrics.npv).toBeCloseTo(correct.metrics.npv, 6);
    }
  });
});
