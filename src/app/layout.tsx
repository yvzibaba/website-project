import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "产业案例与解决方案引擎",
    template: "%s · 产业案例引擎",
  },
  description:
    "AI 驱动的产业案例研究与解决方案生成引擎。V1-A 目标：跑通「免费案例 → 标准方案 → 购买」的最小闭环。",
  robots: {
    // V1-A 开发阶段禁止爬取，Phase 14 打开 SEO 时再改。
    index: false,
    follow: false,
  },
};

/**
 * 根布局：定义 <html>、<body>、公共导航与页脚。
 *
 * Next.js 16 约定：使用全局 LayoutProps<'/'> 助手获得类型安全的 params。
 * 该助手由 `next typegen` 生成到 .next/types/routes.d.ts，postinstall 时会自动跑。
 *
 * 字体策略（宪法第 4 条 MVP 优先）：
 *   脚手架原本用 next/font/google 拉 Geist，但本机构建环境无法访问 fonts.googleapis.com，
 *   build 会失败。改为纯 CSS 系统字体栈（见 globals.css 的 --font-sans / --font-mono），
 *   零外部依赖、零构建时网络请求、加载最快。Phase 5 视觉升级时再考虑 self-host 字体。
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-zinc-200 dark:border-zinc-800">
          <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link
              href="/"
              className="font-semibold tracking-tight hover:opacity-80"
            >
              产业案例引擎
            </Link>
            <div className="flex items-center gap-4 text-sm">
              <Link href="/cases" className="hover:underline">
                案例
              </Link>
              <Link href="/solutions" className="hover:underline">
                方案
              </Link>
              <Link href="/about" className="hover:underline">
                关于
              </Link>
              <Link
                href="/ui"
                className="font-mono text-xs text-zinc-500 hover:underline"
                title="UI 组件库演示"
              >
                ui
              </Link>
              <Link
                href="/api/health"
                className="font-mono text-xs text-zinc-500 hover:underline"
                title="健康检查 API"
              >
                health
              </Link>
            </div>
          </nav>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-zinc-200 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800">
          © 2026 产业案例引擎 · V1-A 开发中 ·{" "}
          <a
            href="https://github.com/yvzibaba/website-project"
            className="hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </footer>
      </body>
    </html>
  );
}
