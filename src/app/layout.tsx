import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { SITE_DESCRIPTION, SITE_URL, isIndexable } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "产业案例与解决方案引擎",
    template: "%s · 产业案例引擎",
  },
  description: SITE_DESCRIPTION,
  robots: isIndexable()
    ? { index: true, follow: true }
    : {
        // 开发 / 预览 / 未配置正式域名时禁止收录（Phase 14 M1 环境门控，见 site.ts）。
        // 部署到正式域名并设 NEXT_PUBLIC_SITE_URL 后自动放开；私有页面各自再叠 noindex。
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
          <nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-4 gap-y-2 px-4 py-3 sm:justify-between">
            <Link
              href="/"
              className="font-semibold tracking-tight hover:opacity-80"
            >
              产业案例引擎
            </Link>
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm">
              <Link href="/industries" className="hidden hover:underline md:inline">
                行业
              </Link>
              <Link href="/cases" className="hover:underline">
                案例
              </Link>
              <Link href="/solutions" className="hover:underline">
                方案
              </Link>
              <Link href="/sandbox" className="hover:underline">
                沙盘
              </Link>
              <Link href="/search" className="hidden hover:underline md:inline">
                搜索
              </Link>
              <Link href="/about" className="hidden hover:underline md:inline">
                关于
              </Link>
              {/* 基础运营版：主导航补「我的项目」（沙盘项目列表）；游客点击走 /account/projects
                  → 由该页 redirect 携 callbackUrl 回跳登录，与「我的订单」同一模式。
                  开发用 /ui 与 /api/health 链接移出主导航（health 保留在页脚小字）。 */}
              <Link href="/account/projects" className="hover:underline">
                我的项目
              </Link>
              <Link href="/account/orders" className="hidden hover:underline sm:inline">
                我的订单
              </Link>
              <Link href="/login" className="hover:underline">
                登录
              </Link>
              <Link
                href="/register"
                className="rounded-full border border-border px-3 py-1 transition-colors hover:border-ring"
              >
                注册
              </Link>
            </div>
          </nav>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-zinc-200 py-6 dark:border-zinc-800">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 text-xs text-zinc-500">
            <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <Link href="/industries" className="hover:underline">
                行业
              </Link>
              <Link href="/cases" className="hover:underline">
                案例
              </Link>
              <Link href="/solutions" className="hover:underline">
                方案
              </Link>
              <Link href="/sandbox" className="hover:underline">
                沙盘
              </Link>
              <Link href="/search" className="hover:underline">
                搜索
              </Link>
              <Link href="/about" className="hover:underline">
                关于我们
              </Link>
              <Link href="/privacy" className="hover:underline">
                隐私政策
              </Link>
              <Link href="/terms" className="hover:underline">
                服务条款
              </Link>
              <Link href="/login" className="hover:underline">
                登录
              </Link>
              <Link href="/register" className="hover:underline">
                注册
              </Link>
              <Link href="/account" className="hover:underline">
                我的账号
              </Link>
              <Link href="/account/projects" className="hover:underline">
                我的项目
              </Link>
              {/* Phase 4 模块 C：公开反馈入口（游客可提交，后台人工处理）。 */}
              <Link href="/feedback" className="hover:underline">
                反馈
              </Link>
              <a
                href="https://github.com/yvzibaba/website-project"
                className="hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </nav>
            <p className="text-center">
              © 2026 产业案例引擎 · V1-A 开发中 · 隐私政策与服务条款为占位草稿，待法务审定后生效 ·{" "}
              <a href="/api/health" className="font-mono hover:underline">
                health
              </a>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
