import { describe, it, expect } from "vitest";
import {
  V1_RETIREMENT_REGISTRY_VERSION,
  V1_SURFACES,
  RETIREMENT_PRECONDITION_CHAIN,
  PRECONDITION_MET,
  areAllPreconditionsMet,
  mayAdvanceBeyondRetain,
  allSurfacesRetain,
  anyDeletionAuthorized,
  surfacesAt,
  type RetirementStatus,
  type V1Surface,
} from "@/server/v1-retirement-registry";

/**
 * R9 · V1 退役登记表测（mandate §十二–§十三）。
 *
 * 三条**硬约束**（比"读表逻辑对不对"更重要）：
 *   ① 前置链 11 环今天**全部未发生**（`PRECONDITION_MET[k] === false`）；
 *   ② 全表**必须一律 RETAIN**（今天没有任何一面获准进入 DEPRECATE_MARK/NAV_REMOVE/…）；
 *   ③ 零 `READY_TO_DELETE` / 零 `DELETED`（mandate §十三"禁止一步删除"最直白的实现）。
 *
 * 若后来人**真**跑通了一条完整客户链、想让某面推进一档，必须：
 *   1. 在 `PRECONDITION_MET` 里按真实事件把对应键翻 true（附项目 ID / 合同号 / 交付凭证链接）；
 *   2. 把某一面 status 推进一档（且 `mayAdvanceBeyondRetain()` 必须先 true）；
 *   3. 更新 registry 版本号 + 本测的期望值。
 * 这三步"改一处破三测"是刻意的摩擦，逼任何删除动作都留下公开可审计的决策痕迹（宪法第 20 条诚实）。
 */

describe("R9 · V1 退役登记表（今日硬约束）", () => {
  it("版本常量钉死（改任何 blocking / status 推进须升版并记原因，规则 13）", () => {
    expect(V1_RETIREMENT_REGISTRY_VERSION).toBe("1.0.0");
  });

  it("mandate §十二 前置链 11 环 · 顺序逐字与总控原文对齐", () => {
    expect(RETIREMENT_PRECONDITION_CHAIN).toEqual([
      "REAL_PROJECT_SIGNED",
      "REAL_INPUT_RECORDED",
      "REAL_COMPUTATION_RUN",
      "VERSION_FROZEN",
      "REPORT_ISSUED",
      "PRODUCTIZED",
      "HUMAN_REVIEWED",
      "PUBLISHED",
      "REAL_DELIVERY",
      "ACTUAL_CAPTURED",
      "DEVIATION_REVIEWED",
    ]);
  });

  it("今天：11 环**全部未发生**（任何 true 都须创始人 §23 签字 + 真实凭证链接）", () => {
    for (const k of RETIREMENT_PRECONDITION_CHAIN) {
      expect(PRECONDITION_MET[k], `前置 ${k} 当前必须 false`).toBe(false);
    }
    expect(areAllPreconditionsMet()).toBe(false);
    expect(mayAdvanceBeyondRetain()).toBe(false); // 前置未闭合 → 禁推进
  });

  it("V1 面清单：≥ 12 条、id 唯一、必填字段齐、kind/status 落在白名单内", () => {
    expect(V1_SURFACES.length).toBeGreaterThanOrEqual(12);
    const ids = new Set<string>();
    const KINDS = new Set(["PAGE", "API", "STORE", "LIB", "COMPONENT", "JSONB_POINTER"]);
    const STATUSES: RetirementStatus[] = [
      "RETAIN",
      "DEPRECATE_MARK",
      "NAV_REMOVE",
      "MIGRATION_NOTE",
      "READY_TO_DELETE",
      "DELETED",
    ];
    for (const s of V1_SURFACES) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(ids.has(s.id), `id 重复：${s.id}`).toBe(false);
      ids.add(s.id);
      expect(s.path.length).toBeGreaterThan(0);
      expect(KINDS.has(s.kind), `未知 kind：${s.kind}`).toBe(true);
      expect(STATUSES.includes(s.status), `未知 status：${s.status}`).toBe(true);
      expect(s.blockingReason.length, `空 blocking：${s.id}`).toBeGreaterThan(0);
      expect(Array.isArray(s.conditions)).toBe(true);
      expect(s.conditions.length, `conditions 空：${s.id}`).toBeGreaterThanOrEqual(1);
      for (const c of s.conditions) expect(typeof c).toBe("string");
    }
  });

  it("★ 今天：全表一律 RETAIN（mandate §十二 前置未闭合 → 任何一面不许推进）", () => {
    expect(allSurfacesRetain()).toBe(true);
    expect(surfacesAt("DEPRECATE_MARK")).toHaveLength(0);
    expect(surfacesAt("NAV_REMOVE")).toHaveLength(0);
    expect(surfacesAt("MIGRATION_NOTE")).toHaveLength(0);
  });

  it("★★ 零授权删除（mandate §十三 禁止一步删除 · READY_TO_DELETE 与 DELETED 都必须为空）", () => {
    expect(anyDeletionAuthorized()).toBe(false);
    expect(surfacesAt("READY_TO_DELETE")).toHaveLength(0);
    expect(surfacesAt("DELETED")).toHaveLength(0);
  });

  it("R7-A/B/C/D/E + R8 各里程碑的关键 V1 面都已被登记（防漏登）", () => {
    // 至少要登记这几面（回归哨兵，将来有人改这份表时若不小心删掉某条会立刻红）
    const required: string[] = [
      "workbench-root",
      "workbench-api-solution-draft",
      "kernel-project-store",
      "kernel-solution-draft-lib",
      "kernel-project-model",
      "solution-v1-sandbox-source-pointer",
      "publish-v1-direct-draft-to-published",
    ];
    const ids = new Set((V1_SURFACES as readonly V1Surface[]).map((s) => s.id));
    for (const r of required) expect(ids.has(r), `缺失关键面：${r}`).toBe(true);
  });

  it("每一面的 blockingReason 里都点明了「哪个 § 或哪条硬约束」在拦（防含混话）", () => {
    // 至少提到 § / 前置 / 真实 / mandate / 创始人 / 稳定 / backfill / 历史 / 只读 / 观察期 / 归档 /
    //   永久（跨链基础设施，不适用退役链）之一，才不算"等一等"式含混
    const SIGNAL = /(§|前置|真实|mandate|创始人|backfill|稳定|历史|只读|观察期|归档|永久|基础设施)/;
    for (const s of V1_SURFACES) {
      expect(
        SIGNAL.test(s.blockingReason),
        `含混 blocking（${s.id}）：${s.blockingReason}`,
      ).toBe(true);
    }
  });
});
