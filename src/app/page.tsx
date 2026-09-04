import Link from "next/link";
import { prisma } from "@/lib/prisma";

/**
 * 首页（Phase 4 骨架版）。
 *
 * 是一个 async Server Component：直接在服务端查一次数据库，
 * 把 17 张表的计数渲染出来，作为"网站 ↔ Neon Postgres"链路可见的最直观证据。
 *
 * force-dynamic：每次请求都重新查，避免开发阶段看到陈旧计数。
 */
export const dynamic = "force-dynamic";

const CORE_TABLES = [
  "Region",
  "Market",
  "Case",
  "Evidence",
  "BusinessModel",
  "TechCapability",
  "CaseCapability",
  "OpenSourceProject",
  "CapabilityProject",
  "Localization",
  "Supplier",
  "LocalizationSupplier",
  "Solution",
  "SolutionFinancial",
  "UnknownVariable",
  "Order",
  "ChangeLog",
] as const;

async function getTableCounts(): Promise<
  | { ok: true; counts: Array<{ table: string; count: number }> }
  | { ok: false; error: string }
> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string; row_count: bigint }>
    >`
      SELECT relname AS table_name, n_live_tup AS row_count
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY relname
    `;
    const map = new Map(rows.map((r) => [r.table_name, Number(r.row_count)]));
    return {
      ok: true,
      counts: CORE_TABLES.map((t) => ({ table: t, count: map.get(t) ?? 0 })),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function Home() {
  const db = await getTableCounts();

  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-16">
      <section className="space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight">
          产业案例与解决方案引擎
        </h1>
        <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          V1-A 目标：跑通「免费案例 → 标准方案 → 购买」的最小闭环。
          当前处于 <strong className="text-zinc-900 dark:text-zinc-100">Phase 4（项目骨架）</strong>，
          Neon Postgres 数据库已就绪，17 张业务表 + 11 个枚举全部建库成功。
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/api/health"
            className="rounded-full bg-black px-4 py-2 text-sm text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            健康检查 API
          </Link>
          <a
            href="https://github.com/yvzibaba/website-project"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            GitHub 仓库
          </a>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">
          数据库实时状态
        </h2>
        {db.ok ? (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              来自 <code className="font-mono text-xs">pg_stat_user_tables</code>（Neon
              Postgres <code className="font-mono text-xs">public</code> schema），
              按 V1-A 核心表顺序列出。计数为 Postgres 估算值，写入后可能延迟。
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {db.counts.map(({ table, count }) => (
                <div
                  key={table}
                  className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <div className="font-mono text-xs text-zinc-500">{table}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">
                    {count}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
            <strong>数据库查询失败：</strong>
            <span className="font-mono">{db.error}</span>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 p-5 text-sm dark:border-zinc-800">
        <h2 className="mb-3 font-semibold tracking-tight">
          Phase 4 已完成的骨架清单
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-zinc-700 dark:text-zinc-300">
          <li>
            Prisma Client 单例 · <code className="font-mono text-xs">src/lib/prisma.ts</code>
          </li>
          <li>
            结构化 JSON 日志 + 敏感字段脱敏 ·{" "}
            <code className="font-mono text-xs">src/lib/logger.ts</code>
          </li>
          <li>
            AppError 层级 + 统一错误响应 ·{" "}
            <code className="font-mono text-xs">src/lib/errors.ts</code>
          </li>
          <li>
            Zod 环境变量校验 · <code className="font-mono text-xs">src/lib/env.ts</code>
          </li>
          <li>
            健康检查 API · <code className="font-mono text-xs">/api/health</code>
          </li>
          <li>
            全局错误边界 + 404 页 ·{" "}
            <code className="font-mono text-xs">error.tsx / not-found.tsx</code>
          </li>
          <li>
            Vitest 单元 + 集成测试 ·{" "}
            <code className="font-mono text-xs">tests/</code>
          </li>
        </ul>
      </section>
    </div>
  );
}
