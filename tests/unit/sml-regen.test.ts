/**
 * 「S/M/L 现实性回归」黄金 fixture **官方重录器**（V1.1 批次 1.1 收编入库）。
 *
 * 背景：阶段3A 起 fixture 的重录靠一次性 scratch 生成器（历史上不入库，工程资产丢失，
 * 审计 Top-20 #18）。本文件把它焊成**可复现的正式工具**：
 *   - 平时 `npm run test:unit` 里本文件**整文件跳过**（不设 env 不写盘，零副作用）。
 *   - 需要重录时跑 `npm run regen:sml`（= `node scripts/sml-regen.mjs`，置 `SML_REGEN=1`）。
 *
 * 纪律（宪法 §13 / 测试铁律）：
 *   - 输入（state/touched/id/label）**永远取自现有 fixture**——重录器只重算"期望输出"，
 *     **绝不改输入**，防止借重录悄悄换场景。
 *   - 重录前把**新旧关键结果逐场景打印成对照表**（npv/irr/roi/payback/capex/opex/revenue），
 *     人工过目 diff 后才提交；`meta.reRecordReason` 由 `SML_REGEN_REASON` 注入（缺省留 TODO 强制手填）。
 *   - 舍入口径与测试完全一致（金额 2 位 / 比率 6 位 / 不可得 null）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeDemoScenario, type DemoHeadlineState, type DemoTouched } from "@app/kernel/server/sandbox-demo";

const REGEN = process.env.SML_REGEN === "1";
const FIXTURE_PATH = resolve(
  process.cwd(),
  "tests",
  "fixtures",
  "regression",
  "scenarios-sml.json",
);

const money = (x: number) => Math.round(x * 100) / 100;
const ratio = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6;

describe.skipIf(!REGEN)("sml-regen · 官方重录器（仅 SML_REGEN=1 时执行）", () => {
  it("重算三场景期望输出并写回 fixture（输入零改动 · 打印新旧对照）", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const fixedNow = new Date(raw.meta.fixedNow);
    const diffs: string[] = [];

    for (const s of raw.scenarios) {
      // 输入零改动：state/touched 原样回喂（仅类型断言）。
      const scn = computeDemoScenario(
        s.state as DemoHeadlineState,
        s.touched as DemoTouched,
        fixedNow,
      );
      const calc = scn.calc;
      expect(calc.ok, `场景 ${s.id} 引擎失败，先修引擎再谈重录`).toBe(true);
      if (!calc.ok) return;

      const old = s.expect;
      const next = {
        vmOk: scn.vm.ok,
        calcOk: calc.ok,
        calcRef: calc.calcRef,
        engineVersions: calc.engineVersions,
        userValues: scn.userValues,
        results: {
          npv: money(calc.metrics.npv),
          irrOk: calc.metrics.irr.ok,
          irr: ratio(calc.metrics.irr.value),
          roiOk: calc.metrics.roi.ok,
          roi: ratio(calc.metrics.roi.value),
          simplePaybackYears: ratio(calc.metrics.simplePaybackYears),
          discountedPaybackYears: ratio(calc.metrics.discountedPaybackYears),
          capexGross: money(calc.capex.gross),
          capexNet: money(calc.capex.net),
          opexY1: money(calc.opexY1.gross),
          revenueY1: money(calc.revenueY1.gross),
          storageValueY1: money(calc.revenueY1.storageValue),
        },
      };
      diffs.push(
        `[${s.id}]\n  calcRef ${old.calcRef} → ${next.calcRef}\n` +
          [
            ["npv", old.results.npv, next.results.npv],
            ["irr", old.results.irr, next.results.irr],
            ["roi", old.results.roi, next.results.roi],
            ["payback(d)", old.results.discountedPaybackYears, next.results.discountedPaybackYears],
            ["capexGross", old.results.capexGross, next.results.capexGross],
            ["capexNet", old.results.capexNet, next.results.capexNet],
            ["opexY1", old.results.opexY1, next.results.opexY1],
            ["revenueY1", old.results.revenueY1, next.results.revenueY1],
            ["storageValueY1", old.results.storageValueY1, next.results.storageValueY1],
          ]
            .map(([k, a, b]) => `  ${String(k).padEnd(16)} ${String(a)} → ${String(b)}`)
            .join("\n") +
          `\n  userValues keys ${JSON.stringify(Object.keys(old.userValues))} → ${JSON.stringify(Object.keys(next.userValues))}`,
      );
      s.expect = next;
    }

    raw.meta.reRecordedAt = new Date().toISOString().slice(0, 10);
    raw.meta.reRecordReason =
      process.env.SML_REGEN_REASON ||
      "TODO：重录原因未注入（SML_REGEN_REASON 缺省）——提交前必须手工补写，含新旧值与版本依据";
    raw.meta.reRecord =
      "npm run regen:sml（scripts/sml-regen.mjs → tests/unit/sml-regen.test.ts，置 SML_REGEN=1 写盘并打印新旧对照）；人工 diff 后提交。";

    console.log(
      "\n━━━ SML 黄金重录·新旧对照（提交前逐条过目！） ━━━\n" + diffs.join("\n"),
    );
    writeFileSync(FIXTURE_PATH, JSON.stringify(raw, null, 2) + "\n", "utf8");
    console.log(`已写回 ${FIXTURE_PATH}`);
  });
});
