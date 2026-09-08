import { describe, expect, it } from "vitest";
import { parseBaselineLayers } from "@/lib/sandbox-project-restore";
import { defaultDemoState } from "@/server/sandbox-demo";
import { SANDBOX_PROFILE_IDS } from "@/server/sandbox-profiles";

/**
 * Phase 4 模块 B：?project= 载入还原的**纯解析**门禁。
 * 锁死三件事：示范档（demo 块）优先判别；工作台（wb 块）还原时扣除「与画像预设同值」的键
 * （归属诚实：画像默认 ≠ 用户已改）；非 number/boolean 覆写诚实丢弃、空分层返回 null。
 */

const PROJECT_NAME = "测试项目";

describe("parseBaselineLayers（沙盘 ?project= 还原解析）", () => {
  it("demo 块 → 示范档还原：state/touched 透传，projectName 随行", () => {
    const base = defaultDemoState();
    const state = { ...base, truckCount: 88 };
    const touched = { truckCount: true };
    const layers = {
      region: { values: {} },
      policy: [],
      user: { values: {} },
      demo: { version: "1.0.0", templateId: "x", preset: "y", state, touched },
    };
    const res = parseBaselineLayers(layers, PROJECT_NAME);
    expect(res).not.toBeNull();
    if (!res || res.kind !== "demo") throw new Error("expected demo restore");
    expect(res.projectName).toBe(PROJECT_NAME);
    expect(res.demo.state.truckCount).toBe(88);
    expect(res.demo.touched).toEqual(touched);
  });

  it("wb 块 → 工作台还原：与画像预设同值的键被扣除（归属诚实），异值保留，字符串覆写丢弃", () => {
    // fleet 预设含 project.trucksPerDay=150、finance.discountRate=10（见 sandbox-profiles）。
    const layers = {
      wb: { version: 1, regionId: "shanxi", profileId: "fleet" },
      user: {
        values: {
          "project.trucksPerDay": 99, // 与预设不同 → 用户已改，保留
          "finance.discountRate": 10, // 与预设同值 → 归还画像默认，扣除
          "project.note": "文本", // 字符串 → 非滑杆/开关域，诚实丢弃
        },
      },
    };
    const res = parseBaselineLayers(layers, PROJECT_NAME);
    expect(res).not.toBeNull();
    if (!res || res.kind !== "full") throw new Error("expected full restore");
    expect(res.full.regionId).toBe("shanxi");
    expect(res.full.profileId).toBe("fleet");
    expect(res.full.overrides).toEqual({ "project.trucksPerDay": 99 });
    expect(res.projectName).toBe(PROJECT_NAME);
  });

  it("无 wb 块但有无 user 覆写 → 仍按工作台还原（旧数据兼容），region/profile 缺省", () => {
    const layers = { user: { values: { "project.pvCapacity": 123 } } };
    const res = parseBaselineLayers(layers, PROJECT_NAME);
    expect(res).not.toBeNull();
    if (!res || res.kind !== "full") throw new Error("expected full restore");
    expect(res.full.overrides).toEqual({ "project.pvCapacity": 123 });
    expect(res.full.regionId).toBeUndefined();
    expect(res.full.profileId).toBeUndefined();
  });

  it("null / 非对象 → null；空对象 → 工作台默认态（空覆写，纯基线项目）", () => {
    expect(parseBaselineLayers(null, PROJECT_NAME)).toBeNull();
    expect(parseBaselineLayers("junk", PROJECT_NAME)).toBeNull();
    const res = parseBaselineLayers({}, PROJECT_NAME);
    if (!res || res.kind !== "full") throw new Error("expected full restore");
    expect(res.full.overrides).toEqual({});
    expect(res.full.regionId).toBeUndefined();
  });

  it("未知 wb.profileId → 全部 user 值按用户覆写还原（预设查找回落通用空预设，绝不裸抛）", () => {
    const layers = {
      wb: { version: 1, regionId: "national", profileId: "not-a-profile" },
      user: { values: { "finance.discountRate": 12 } },
    };
    const res = parseBaselineLayers(layers, PROJECT_NAME);
    if (!res || res.kind !== "full") throw new Error("expected full restore");
    // 通用画像无预设 → 无键可扣，覆写全保留。
    expect(res.full.overrides).toEqual({ "finance.discountRate": 12 });
    expect(SANDBOX_PROFILE_IDS).not.toContain("not-a-profile");
  });
});
