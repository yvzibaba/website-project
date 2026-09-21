/**
 * R8 · Research Workspace 视图的**零依赖纯函数**（分页/排序/筛选链接与展示派生）。
 *
 * 为什么单列成 *-model.ts（对齐仓内约定：Next 16 无 jsdom，UI 可测逻辑抽成纯函数走 node 单测，
 *   组件只当展示壳）：把「查询串拼装 / 分页页码窗口 / 排序方向翻转」这些**易错且可证**的逻辑从
 *   服务端组件里剥出来钉死，避免把 URL 拼接的边界（空值、越界、保留既有筛选）散在 JSX 里没人测。
 *
 * 铁律：这里**不产生任何"综合分数"**（mandate §七「不要把筛选结果变成虚假综合分」）——只搬运事实字段
 *   （page/pageSize/total/hasPrev/hasNext、逐闸通过数、unknowns 计数）。
 */

/** 从当前查询参数出发，覆盖若干键后拼成新查询串（跳过空值；page 覆盖时默认不保留旧 page）。 */
export function buildQuery(
  base: Record<string, string | undefined>,
  override: Record<string, string | number | undefined>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v != null && v !== "") merged[k] = v;
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === "") delete merged[k];
    else merged[k] = String(v);
  }
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) usp.set(k, v);
  return usp.toString();
}

/** 翻转到目标页（路径固定 /admin/research）。 */
export function pageHref(
  base: Record<string, string | undefined>,
  page: number,
): string {
  const q = buildQuery(base, { page });
  return q ? `/admin/research?${q}` : "/admin/research";
}

/** 切换排序：同字段→翻转方向；换字段→该字段倒序起步。 */
export function sortHref(
  base: Record<string, string | undefined>,
  field: string,
): string {
  const curField = base.sortBy || "createdAt";
  const curDir = base.sortDir === "asc" ? "asc" : "desc";
  const nextDir = curField === field && curDir === "desc" ? "asc" : "desc";
  const q = buildQuery(base, { sortBy: field, sortDir: nextDir, page: 1 });
  return q ? `/admin/research?${q}` : "/admin/research";
}

/** 排序列头当前是否正按此字段排（用于显示 ▲▼）。 */
export function isSortedBy(base: Record<string, string | undefined>, field: string): "asc" | "desc" | null {
  const curField = base.sortBy || "createdAt";
  if (curField !== field) return null;
  return base.sortDir === "asc" ? "asc" : "desc";
}

/**
 * 分页页码窗口：给定 total/pageSize/page，返回总页数、是否首/末页、以及一段连续页码（最多 span 个，居中当前页）。
 * 纯算术、不碰 DOM——正是该被单测钉死的那类逻辑。
 */
export function paginationInfo(
  total: number,
  pageSize: number,
  page: number,
  span = 5,
): { pageCount: number; safePage: number; hasPrev: boolean; hasNext: boolean; pages: number[] } {
  const size = pageSize > 0 ? pageSize : 1;
  const pageCount = Math.max(1, Math.ceil((total > 0 ? total : 0) / size));
  const safePage = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const hasPrev = safePage > 1;
  const hasNext = safePage < pageCount;
  let start = Math.max(1, safePage - Math.floor(span / 2));
  const end = Math.min(pageCount, start + span - 1);
  start = Math.max(1, end - span + 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);
  return { pageCount, safePage, hasPrev, hasNext, pages };
}
