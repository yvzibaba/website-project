import { Container, Skeleton, Spinner } from "@/components/ui";

/**
 * 根级 loading.tsx — Suspense 回退（Next.js App Router 约定）。
 *
 * 触发场景：导航到任意 force-dynamic 页面（如 /industries 需实时查 Neon 计数）
 * 或服务端数据仍在流式返回时，先展示骨架而非白屏。
 *
 * Neon 免费库冷启动首连可能 ~5s（见 MEMORY 冒烟坑），此时该骨架尤其有用。
 * Spinner 提供 role="status" 供屏幕阅读器播报；Skeleton aria-hidden。
 */
export default function Loading() {
  return (
    <Container size="lg" className="py-10 flex flex-col gap-8" aria-busy="true">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Spinner size={18} label="页面加载中" />
        正在加载…
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-48" />
        <Skeleton variant="text" lines={2} className="max-w-2xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-lg" />
        ))}
      </div>
    </Container>
  );
}
