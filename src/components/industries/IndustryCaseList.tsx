"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Alert, Button, Skeleton } from "@/components/ui";
import { EmptyState } from "@/components/page";

/**
 * 行业详情页真实案例预览（Phase 4 模块 A，客户端拉取）。
 *
 * 为什么用客户端 fetch 而非服务端直查：行业详情页必须保持**静态预渲染**
 * （generateStaticParams + dynamicParams=false 才能对非法 slug 回真 404，见该页头注释；
 * root loading.tsx 的 Suspense 会让 force-dynamic + notFound() 先 flush 200 shell）。
 * 因此真实案例数据走公开只读 API /api/cases 在浏览器端补齐，页面骨架仍是静态 HTML。
 *
 * 诚实边界：API 恒查公开可见（stage ≥ DEEP_CASE 且非 DEMO）；空态不编数据。
 * 对响应做最小形状校验（ok===true 且 items 是数组）才采纳，不盲信 payload。
 */

interface ApiCaseItem {
  id: string;
  title: string;
  summary: string | null;
  industryName: string;
  regionName: string | null;
  discoveredAt: string;
  opportunityScore: number | null;
  evidenceConfidence: number | null;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "done"; items: ApiCaseItem[]; total: number };

/** ISO 串 → YYYY-MM-DD（解析失败回 null，调用方省略日期，不臆造）。 */
function fmtDate(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function IndustryCaseList({ slug, industryName }: { slug: string; industryName: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    fetch(`/api/cases?industry=${encodeURIComponent(slug)}&limit=6`, {
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();
        if (
          data &&
          typeof data === "object" &&
          (data as { ok?: unknown }).ok === true &&
          Array.isArray((data as { items?: unknown }).items)
        ) {
          const items = (data as { items: unknown[] }).items as ApiCaseItem[];
          const total = (data as { total?: unknown }).total;
          if (alive) {
            setPhase({
              kind: "done",
              items,
              total: typeof total === "number" ? total : items.length,
            });
          }
          return;
        }
        throw new Error("bad payload");
      })
      .catch(() => {
        if (alive) setPhase({ kind: "error" });
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  if (phase.kind === "loading") {
    return (
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="案例加载中">
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-background p-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </li>
        ))}
      </ul>
    );
  }

  if (phase.kind === "error") {
    return (
      <Alert variant="warning" title="案例暂不可用">
        案例列表加载失败（数据库可能正在冷启动或不可达），请稍后重试；您仍可先体验决策沙盘。
      </Alert>
    );
  }

  if (phase.items.length === 0) {
    return (
      <>
        <EmptyState
          title={`「${industryName}」暂无已发布的深度案例`}
          description="每日流水线（60 候选 → 20 重点 → 10 深度 → 3 方案 → 1 精品）将自动发现并填充。当前为诚实空态，未预置任何示例数据。"
        />
        <div className="flex justify-center">
          <Button variant="secondary" href="/sandbox">
            先体验新能源决策沙盘 →
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {phase.items.map((c) => {
          const date = fmtDate(c.discoveredAt);
          return (
            <li key={c.id}>
              <Link href={`/cases/${c.id}`} className="group block h-full">
                <article className="flex h-full flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" compact>{c.industryName}</Badge>
                    {typeof c.opportunityScore === "number" ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        机会评分 <strong className="text-foreground tabular-nums">{c.opportunityScore}</strong>
                      </span>
                    ) : null}
                  </div>
                  <h3 className="text-base font-semibold leading-6 text-foreground group-hover:text-primary">{c.title}</h3>
                  {c.summary ? <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{c.summary}</p> : null}
                  <p className="mt-auto text-xs text-muted-foreground">
                    {[c.regionName, date].filter(Boolean).join(" · ")}
                  </p>
                </article>
              </Link>
            </li>
          );
        })}
      </ul>
      {phase.total > phase.items.length ? (
        <div className="flex justify-center">
          <Button variant="secondary" href={`/cases?industry=${encodeURIComponent(slug)}`}>
            查看该行业全部 {phase.total} 个案例 →
          </Button>
        </div>
      ) : (
        <div className="flex justify-center">
          <Link href={`/cases?industry=${encodeURIComponent(slug)}`} className="text-sm text-primary underline-offset-4 hover:underline">
            在案例浏览页中查看该行业 →
          </Link>
        </div>
      )}
    </div>
  );
}
