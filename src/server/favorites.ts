/**
 * 收藏数据层（Phase 4 Module C，server-only）。
 *
 * 职责：用户对案例/方案的「收藏」标记——状态查询（供详情页 FavoriteButton 初始态）、
 * 幂等添加/移除、带展示字段的个人收藏列表。
 *
 * 设计要点（对齐 schema.prisma Favorite 注释）：
 *   - targetType/targetId 无 FK：目标行被删后收藏成悬挂引用——读列表时**跳过并诚实忽略**
 *     （ModelCall 归因列先例：观测不因实体删除级联丢失），绝不伪造「已删除条目」。
 *   - 唯一约束 (userId,targetType,targetId)：重复添加走 upsert 幂等，不报错不重复。
 *   - 结果一律判别联合（ok/invalid/not_found/error），不裸抛——api-guard.mutationResponse 统一翻译。
 *   - ownerId 只从服务端会话取（调用方传入 SessionUser），绝不接受客户端传入的 userId（SECURITY）。
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { SessionUser } from "@/server/authz";

const log = logger.child({ module: "server/favorites" });

/** 可收藏对象类型白名单（DB 存 String，对齐 ModelCall 先例；server 层枚举约束）。 */
export const FAVORITE_TARGET_TYPES = ["CASE", "SOLUTION"] as const;
export type FavoriteTargetType = (typeof FAVORITE_TARGET_TYPES)[number];

/** 收藏层版本（改输入契约/口径须升版记原因，规则 13）。 */
export const FAVORITES_VERSION = "1.0.0";

/* ────────────────────────── 输入契约（Zod） ────────────────────────── */

export const favoriteMutationSchema = z.object({
  targetType: z.enum(FAVORITE_TARGET_TYPES),
  targetId: z.string().trim().min(1, "缺少目标 id").max(100, "目标 id 过长"),
});
export type FavoriteMutationInput = z.infer<typeof favoriteMutationSchema>;

/* ────────────────────────── 判别联合结果 ────────────────────────── */

export type FavoriteMutationResult =
  | { status: "ok"; favorited: boolean }
  | { status: "invalid"; error: string }
  | { status: "not_found"; error: string }
  | { status: "error"; error: string };

/* ────────────────────────── 状态查询（详情页初始态 / 列表页批量态） ────────────────────────── */

/**
 * 批量查询：这批 (targetType, targetIds) 里当前用户已收藏了哪些？
 * 返回 Set<targetId>，供服务端渲染详情页/列表页的收藏按钮初始态（避免闪烁）。
 * 一次查询、无逐条 N+1；DB 失败返回空 Set（按「未收藏」渲染，宁可保守不挡主内容）。
 */
export async function getFavoritedSet(
  userId: string,
  targetType: FavoriteTargetType,
  targetIds: string[],
): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  try {
    const rows = await prisma.favorite.findMany({
      where: { userId, targetType, targetId: { in: targetIds } },
      select: { targetId: true },
    });
    return new Set(rows.map((r) => r.targetId));
  } catch (err) {
    log.error("getFavoritedSet failed", { err, userId, targetType });
    return new Set();
  }
}

/** 单条状态便捷封装（详情页用）。 */
export async function isFavorited(
  userId: string,
  targetType: FavoriteTargetType,
  targetId: string,
): Promise<boolean> {
  const set = await getFavoritedSet(userId, targetType, [targetId]);
  return set.has(targetId);
}

/* ────────────────────────── 添加 / 移除 ────────────────────────── */

/** 目标行是否存在（CASE→Case 表 / SOLUTION→Solution 表；悬挂输入在此拒绝，不产生脏收藏）。 */
async function targetExists(targetType: FavoriteTargetType, targetId: string): Promise<boolean> {
  if (targetType === "CASE") {
    const row = await prisma.case.findUnique({ where: { id: targetId }, select: { id: true } });
    return row !== null;
  }
  const row = await prisma.solution.findUnique({ where: { id: targetId }, select: { id: true } });
  return row !== null;
}

/** 添加收藏（幂等：已收藏直接 ok，不改写 createdAt）。目标不存在 → not_found。 */
export async function addFavorite(input: unknown, user: SessionUser): Promise<FavoriteMutationResult> {
  const parsed = favoriteMutationSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid", error: parsed.error.issues[0]?.message ?? "入参校验未通过" };
  }
  const { targetType, targetId } = parsed.data;
  try {
    if (!(await targetExists(targetType, targetId))) {
      return { status: "not_found", error: "收藏对象不存在或已下架" };
    }
    await prisma.favorite.upsert({
      where: { userId_targetType_targetId: { userId: user.id, targetType, targetId } },
      create: { userId: user.id, targetType, targetId },
      update: {},
    });
    return { status: "ok", favorited: true };
  } catch (err) {
    log.error("addFavorite failed", { err, userId: user.id, targetType, targetId });
    return { status: "error", error: "收藏失败，请稍后重试" };
  }
}

/** 移除收藏（幂等：未收藏也 ok）。 */
export async function removeFavorite(
  input: unknown,
  user: SessionUser,
): Promise<FavoriteMutationResult> {
  const parsed = favoriteMutationSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid", error: parsed.error.issues[0]?.message ?? "入参校验未通过" };
  }
  const { targetType, targetId } = parsed.data;
  try {
    await prisma.favorite.deleteMany({
      where: { userId: user.id, targetType, targetId },
    });
    return { status: "ok", favorited: false };
  } catch (err) {
    log.error("removeFavorite failed", { err, userId: user.id, targetType, targetId });
    return { status: "error", error: "取消收藏失败，请稍后重试" };
  }
}

/* ────────────────────────── 个人收藏列表（/account/favorites） ────────────────────────── */

export interface FavoriteListItem {
  favoriteId: string;
  targetType: FavoriteTargetType;
  targetId: string;
  /** 展示字段；悬挂引用（目标已删）时为 null，UI 显示「已失效」并允许移除。 */
  title: string | null;
  href: string | null;
  createdAt: Date;
}

/**
 * 当前用户收藏列表（createdAt 倒序）。批量回查展示字段：
 *  - CASE → /cases/{id}；SOLUTION → /solutions/{id}（详情页按 id 路由）；
 *  - 悬挂引用：title/href 为 null，列表标注「已失效」——诚实呈现而非悄悄吞掉行数。
 * DB 失败 → { ok:false }（页面渲染提示条，不崩溃，对齐 cases.ts 列表降级策略）。
 */
export async function listFavoritesForUser(
  userId: string,
  limit = 100,
): Promise<{ ok: true; items: FavoriteListItem[] } | { ok: false; items: [] }> {
  try {
    const rows = await prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });

    const caseIds = rows.filter((r) => r.targetType === "CASE").map((r) => r.targetId);
    const solutionIds = rows.filter((r) => r.targetType === "SOLUTION").map((r) => r.targetId);

    const [caseRows, solutionRows] = await Promise.all([
      caseIds.length
        ? prisma.case.findMany({
            where: { id: { in: caseIds } },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
      solutionIds.length
        ? prisma.solution.findMany({
            where: { id: { in: solutionIds } },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
    ]);
    const caseTitle = new Map(caseRows.map((c) => [c.id, c.title]));
    const solutionTitle = new Map(solutionRows.map((s) => [s.id, s.title]));

    const items: FavoriteListItem[] = rows.map((r) => {
      const type = r.targetType as FavoriteTargetType;
      const title = type === "CASE" ? (caseTitle.get(r.targetId) ?? null) : (solutionTitle.get(r.targetId) ?? null);
      return {
        favoriteId: r.id,
        targetType: type,
        targetId: r.targetId,
        title,
        href:
          title === null
            ? null
            : type === "CASE"
              ? `/cases/${r.targetId}`
              : `/solutions/${r.targetId}`,
        createdAt: r.createdAt,
      };
    });
    return { ok: true, items };
  } catch (err) {
    log.error("listFavoritesForUser failed", { err, userId });
    return { ok: false, items: [] };
  }
}
