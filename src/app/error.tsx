"use client";

import { useEffect } from "react";

/**
 * 全局错误边界（App Router 约定：error.tsx 必须是 Client Component）。
 *
 * 触发场景：任意 Server Component / Route Handler 抛出未捕获错误。
 * Phase 9 会把 error 上报到结构化 telemetry（AI 调用成本 / 用户操作日志）。
 * 当前只在浏览器 console 打一条，供开发时排查。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[app-error-boundary]", {
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="max-w-md space-y-4 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">出错了</h2>
        <p className="text-zinc-600 dark:text-zinc-400">
          页面加载时发生异常。你可以尝试重新加载，或返回首页。
        </p>
        {error.digest && (
          <p className="font-mono text-xs text-zinc-500">
            错误编号：{error.digest}
          </p>
        )}
        <div className="flex justify-center gap-3 pt-2">
          <button
            onClick={reset}
            className="rounded-full bg-black px-5 py-2 text-sm text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            重试
          </button>
          <a
            href="/"
            className="rounded-full border border-zinc-300 px-5 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            回首页
          </a>
        </div>
      </div>
    </div>
  );
}
