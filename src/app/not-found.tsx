import Link from "next/link";

/**
 * 404 页面（App Router 约定：not-found.tsx）。
 * 当调用 notFound() 或路由不匹配时渲染。
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="max-w-md space-y-4 text-center">
        <p className="text-6xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          404
        </p>
        <h1 className="text-xl font-semibold">页面不存在</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          你访问的页面可能已被移除、改名，或链接本身有误。
        </p>
        <Link
          href="/"
          className="mt-2 inline-block rounded-full bg-black px-5 py-2 text-sm text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          回首页
        </Link>
      </div>
    </div>
  );
}
