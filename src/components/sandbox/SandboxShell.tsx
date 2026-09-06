/**
 * R8.8a — /sandbox 页面的**双档外壳**（客户端 · 极薄，只做模式切换，不含任何计算/数据逻辑）。
 *
 * 落地《R8.8 最小实施方案》§8「普通用户简单易懂、高级用户可展开更多」的裁决：
 *   - 默认「示范项目模型」档：露出 ~10 个核心参数（`SandboxDemoPanel`），改参数即调用**既有**沙盘引擎整链重算；
 *   - 「完整参数工作台」档：原样渲染既有 `SandboxWorkbench`（40 参数全量，R1–R7 主链，一字未改）。
 * 两档切换**只在客户端切组件**，不改路由（`/sandbox` 仍单一 `○` 静态路由、零新增）、不碰后端、不碰存储。
 *
 * 示范档「展开完整参数工作台」按钮 → 切到 full；full 档「返回示范项目模型」→ 切回 demo。两档各自持有内部 state，
 * 互不干扰（切档即重挂载，刻意如此：示范项目档默认态本就等于全局基线，重挂载不会引入偏差）。
 */

"use client";

import { useState } from "react";
import { SandboxDemoPanel } from "./SandboxDemoPanel";
import { SandboxWorkbench } from "./SandboxWorkbench";

type DemoMode = "demo" | "full";

export function SandboxShell() {
  const [mode, setMode] = useState<DemoMode>("demo");

  return (
    <div className="flex flex-col gap-5">
      <div
        role="tablist"
        aria-label="沙盘模式"
        className="inline-flex w-fit items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 p-1"
      >
        <ModeTab
          active={mode === "demo"}
          onClick={() => setMode("demo")}
          label="示范项目模型"
          hint="只露核心参数，改一项即整链重算"
        />
        <ModeTab
          active={mode === "full"}
          onClick={() => setMode("full")}
          label="完整参数工作台"
          hint="40 参数全量（R1–R7 主链）"
        />
      </div>

      {mode === "demo" ? (
        <SandboxDemoPanel onOpenFull={() => setMode("full")} />
      ) : (
        <SandboxWorkbench />
      )}
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={hint}
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-blue-600 text-white shadow-sm"
          : "text-zinc-600 hover:bg-white hover:text-zinc-900"
      }`}
    >
      {label}
    </button>
  );
}
