"use client";

/**
 * global-error.tsx（Phase 4 模块 D 统一体验）：root layout 自身崩溃时的最后边界。
 *
 * 与 error.tsx 的分工：error.tsx 挡页面段的运行时错误（layout/header/footer 仍在）；
 * 本文件只在**根布局渲染失败**时整屏接管（此时 header/footer 都没渲染出来），
 * 因此必须自带 <html><body>。生产只显示通用文案 + digest 便于对日志，绝不透出内部错误细节。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen items-center justify-center bg-white p-8 font-sans dark:bg-zinc-950">
        <div className="max-w-md space-y-4 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            网站暂时无法显示
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400">
            发生了意外错误。你可以尝试重新加载，或稍后再访问。
          </p>
          {error.digest ? (
            <p className="font-mono text-xs text-zinc-500">错误编号：{error.digest}</p>
          ) : null}
          <div className="flex justify-center gap-3 pt-2">
            <button
              onClick={reset}
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-black"
            >
              重试
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
