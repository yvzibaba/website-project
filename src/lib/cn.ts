/**
 * className 合并工具（零依赖版）。
 *
 * 设计取舍（宪法第 4 条 MVP 优先 / 第 5 条 最简可维护）：
 *   不引入 clsx + tailwind-merge（两个包 ~15KB gzip，且 tailwind-merge 需要跟 Tailwind 版本同步升级）。
 *   V1 组件数量少、样式冲突可控，用极简实现：过滤 falsy → 数组扁平 → join 空格。
 *   后写覆盖前写的"智能合并"留到 Phase 5 视觉升级时再评估是否引入 tailwind-merge。
 *
 * 用法：
 *   cn("px-2 py-1", isActive && "bg-primary", className)
 *   cn(["flex", "gap-2"], { "text-sm": small })
 */

export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[]
  | { [key: string]: unknown };

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    append(out, input);
  }
  return out.join(" ");
}

function append(out: string[], value: ClassValue): void {
  if (!value && value !== 0) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (typeof value === "number") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) append(out, v);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (v) {
        const trimmed = k.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
}
