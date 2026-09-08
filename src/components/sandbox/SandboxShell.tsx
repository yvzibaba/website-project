/**
 * R8.8a — /sandbox 页面的**双档外壳**（客户端 · 极薄，只做模式切换与项目载入，不含任何计算逻辑）。
 *
 * 落地《R8.8 最小实施方案》§8「普通用户简单易懂、高级用户可展开更多」的裁决：
 *   - 默认「示范项目模型」档：露出 ~10 个核心参数（`SandboxDemoPanel`），改参数即调用**既有**沙盘引擎整链重算；
 *   - 「完整参数工作台」档：原样渲染既有 `SandboxWorkbench`（40 参数全量，R1–R7 主链，一字未改）。
 * 两档切换**只在客户端切组件**，不改路由（`/sandbox` 仍单一 `○` 静态路由、零新增）、不碰后端、不碰存储。
 *
 * Phase 4 模块 E/B（URL 进参）：
 *   - `?profile=<id>`：/enterprise 画像卡带入 → 默认切到工作台档并预选画像（画像只在 full 档）；
 *   - `?project=<id>`：/account/projects「在沙盘打开」带入 → 拉取项目基线分层，示范档项目（layers.demo 块）
 *     还原滑杆进示范档，工作台项目（layers.wb 块）还原地区/画像/覆写进 full 档。
 *   URL 读取用 useSyncExternalStore（服务端快照恒 null → 首屏按示范档水合，无 hydration mismatch；
 *   也不用 useSearchParams——那会强制本静态页挂 Suspense 边界）。
 *
 * 载入失败诚实降级：401 跳登录（携 callbackUrl 回到同一 ?project= 链接）；其余失败显示提示条，
 * 沙盘其余功能不受影响。两档各自持有内部 state，切档即重挂载（示范档默认态=全局基线，重挂载无偏差）。
 */

"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { mutateJson } from "@/components/admin/mutate";
import { parseBaselineLayers, type ProjectRestore } from "@/lib/sandbox-project-restore";
import { SandboxDemoPanel } from "./SandboxDemoPanel";
import { SandboxWorkbench } from "./SandboxWorkbench";

type DemoMode = "demo" | "full";

/** 只订阅浏览器历史变化的最小 store（进参只在进页时读，无需更细的重订阅）。 */
function subscribeLocation(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

/** 服务端快照：恒无参数（SSR/SSG 按示范档渲染，客户端水合后再用真实 URL 校正 → 无 hydration mismatch）。 */
function nullSnapshot(): string | null {
  return null;
}

/** 从 URL 读取单个查询参数的快照钩子（值是原始字符串，Object.is 稳定可比）。 */
function useQueryParam(name: string): string | null {
  return useSyncExternalStore(
    subscribeLocation,
    () => new URLSearchParams(window.location.search).get(name),
    nullSnapshot,
  );
}

/* ─────────────────── 外壳 ─────────────────── */

export function SandboxShell() {
  // 用户显式切档（非 null 时覆盖 URL/项目推导的默认档）。
  const [userMode, setUserMode] = useState<DemoMode | null>(null);
  const router = useRouter();
  const profileParam = useQueryParam("profile");
  const projectParam = useQueryParam("project");

  // Phase 4 模块 B：?project= 载入一次。未登录 → 跳登录（携 callbackUrl 回到同一链接）；
  // 其余失败 → 诚实提示条，沙盘其余功能不受影响。所有 setState 都在异步回调内（非 effect 同步）。
  const [restore, setRestore] = useState<ProjectRestore>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectParam) return;
    let alive = true;
    mutateJson(`/api/sandbox/projects/${encodeURIComponent(projectParam)}`, "GET")
      .then((res) => {
        if (!alive) return;
        if (res.status === 401) {
          router.replace(`/login?callbackUrl=${encodeURIComponent(`/sandbox?project=${projectParam}`)}`);
          return;
        }
        if (!res.ok) {
          setRestoreError(res.message ?? "项目载入失败");
          return;
        }
        const project = (res.data as { project?: { name?: string; baselineLayers?: unknown } })
          .project;
        setRestore(parseBaselineLayers(project?.baselineLayers, project?.name ?? "未命名"));
      })
      .catch(() => {
        if (alive) setRestoreError("项目载入失败（网络异常）");
      });
    return () => {
      alive = false;
    };
  }, [projectParam, router]);

  const mode: DemoMode =
    userMode ??
    (restore?.kind === "demo"
      ? "demo"
      : profileParam !== null || restore?.kind === "full"
        ? "full"
        : "demo");

  return (
    <div className="flex flex-col gap-5">
      {restoreError ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          载入项目失败：{restoreError}。你仍可正常使用沙盘，或从「我的项目」重新打开。
        </p>
      ) : null}

      <div
        role="tablist"
        aria-label="沙盘模式"
        className="inline-flex w-fit items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 p-1"
      >
        <ModeTab
          active={mode === "demo"}
          onClick={() => setUserMode("demo")}
          label="示范项目模型"
          hint="只露核心参数，改一项即整链重算"
        />
        <ModeTab
          active={mode === "full"}
          onClick={() => setUserMode("full")}
          label="完整参数工作台"
          hint="40 参数全量（R1–R7 主链）"
        />
      </div>

      {mode === "demo" ? (
        <SandboxDemoPanel
          onOpenFull={() => setUserMode("full")}
          initial={restore?.kind === "demo" ? restore.demo : null}
        />
      ) : (
        <SandboxWorkbench
          initialProfileId={profileParam ?? undefined}
          initialProject={restore?.kind === "full" ? restore.full : null}
        />
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
