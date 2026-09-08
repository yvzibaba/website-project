/**
 * 沙盘项目「?project= 载入还原」的**纯解析**（Phase 4 模块 B）。
 *
 * 职责：把已保存项目基线情景的参数分层（`StoredParamLayers` JSON）判别为两档还原态——
 *   - 示范档项目（layers 带 `demo` 块，serializeDemoLayers 落的）→ 还原 10 参数滑杆位 + touched；
 *   - 完整工作台项目（layers 带 `wb` 块，SandboxWorkbench 保存时附加的地区/画像 id）→
 *     还原地区 id、画像 id 与用户覆写；user 层里「与画像预设同值」的键被扣除，
 *     让画像预设还原为「画像默认」归属，而非伪装成用户已改（引擎本就把二者都报成 origin=user，
 *     这层区分在应用侧用数据算，绝不臆测——与 sandbox-profiles.isProfileDefault 同一纪律）。
 *
 * 纯函数、零 React / 零网络依赖（可离线单测）；未知 id 不在此处裁决，交给面板诚实回落默认
 * （getRegionPack / getEnterpriseProfile 对未知 id 恒回落，绝不裸抛）。
 * 引擎只读 region/policy/user/now（见 sandbox-store.toEngineLayers），`demo`/`wb` 是刻意加性
 * 透传块，不参与任何计算，也不会被引擎改写。
 */
import { deserializeDemoState, type DemoHeadlineState, type DemoTouched } from "@/server/sandbox-demo";
import { getEnterpriseProfile } from "@/server/sandbox-profiles";

export interface DemoRestore {
  state: DemoHeadlineState;
  touched: DemoTouched;
}

export interface FullRestore {
  overrides: Record<string, number | boolean>;
  regionId?: string;
  profileId?: string;
}

export type ProjectRestore =
  | { kind: "demo"; demo: DemoRestore; projectName: string }
  | { kind: "full"; full: FullRestore; projectName: string }
  | null;

/**
 * 判别基线参数分层属于哪一档并产出还原态：
 *   - 有 `demo` 块（示范档项目）→ demo 还原（deserializeDemoState 已做逐字段兜底）；
 *   - 否则按工作台项目还原：`wb` 块取地区/画像 id；user 层 values 扣除「与画像预设同值」的键，
 *     且只收 number/boolean（滑杆/开关域），其余类型诚实丢弃（工作台覆写本就只有这两类）。
 *   - 空分层 / 非对象 → null（调用方按「无从还原」处理，不阻塞沙盘其余功能）。
 */
export function parseBaselineLayers(layers: unknown, projectName: string): ProjectRestore {
  if (!layers || typeof layers !== "object") return null;
  const demo = deserializeDemoState(layers);
  if (demo) return { kind: "demo", demo, projectName };

  const wb = (layers as { wb?: { regionId?: unknown; profileId?: unknown } }).wb;
  const regionId = typeof wb?.regionId === "string" ? wb.regionId : undefined;
  const profileId = typeof wb?.profileId === "string" ? wb.profileId : undefined;
  const userValues = (layers as { user?: { values?: Record<string, unknown> } }).user?.values ?? {};
  const preset = profileId ? getEnterpriseProfile(profileId).presetValues : {};
  const overrides: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(userValues)) {
    if (k in preset && preset[k] === v) continue;
    if (typeof v === "number" || typeof v === "boolean") overrides[k] = v;
  }
  return { kind: "full", full: { overrides, regionId, profileId }, projectName };
}
