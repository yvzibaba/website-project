import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Industry } from "@/lib/validation";

/**
 * 行业数据层（server-only）。
 *
 * 职责：
 *   1. 把 prisma 的 Industry 枚举映射成 URL slug + 中英文名 + 一句话简介（展示/路由用）；
 *   2. 提供按行业的"公开可见案例数"实时查询，供 /industries 列表与详情页使用。
 *
 * 为什么 slug 不直接用枚举名：
 *   枚举名是 SCREAMING_SNAKE（NEW_ENERGY），不适合做 URL；slug 用 kebab-case（new-energy），
 *   符合 SEO 友好（总控第 19 节）与 SlugSchema 校验。两者映射集中在此，禁止散落各处硬编码。
 *
 * ⚠️ 业务规则（推断，待创始人确认 — 宪法第 7 条区分事实/假设/推断）：
 *   "公开可见案例" = stage ∈ {DEEP_CASE, KEY_SOLUTION, PREMIUM_SOLUTION}。
 *   理由：漏斗（总控第 9 节）中 CANDIDATE(60)/KEY_RESEARCH(20) 是内部流水线中间态，
 *   不应对外展示；DEEP_CASE(10) 及以后才是可对外的"深度案例"。
 *   该规则集中在 PUBLIC_CASE_STAGES 一处，确认后改这里即可。
 */

const log = logger.child({ module: "server/industries" });

export interface IndustryMeta {
  /** prisma Industry 枚举值。 */
  enum: Industry;
  /** URL slug（kebab-case，唯一）。 */
  slug: string;
  /** 中文名。 */
  name: string;
  /** 英文名。 */
  nameEn: string;
  /** 一句话简介（展示用）。 */
  tagline: string;
  /** 装饰性图标（emoji，aria-hidden）。 */
  icon: string;
}

/**
 * 六大行业 + OTHER（与 prisma/schema.prisma 的 Industry 枚举、PRODUCT_SPEC §2 一一对应）。
 * 顺序即首页/列表展示顺序：六大行业按总控第 6 节排列，OTHER 兜底放最后。
 */
export const INDUSTRIES: readonly IndustryMeta[] = [
  {
    enum: "NEW_ENERGY",
    slug: "new-energy",
    name: "新能源",
    nameEn: "New Energy",
    tagline: "风光储氢、沼气、绿色甲醇、多能互补与碳资产。",
    icon: "⚡",
  },
  {
    enum: "INDUSTRIAL_MANUFACTURING",
    slug: "industrial-manufacturing",
    name: "工业制造",
    nameEn: "Industrial Manufacturing",
    tagline: "AI 视觉质检、预测性维护、工艺优化与柔性产线。",
    icon: "🏭",
  },
  {
    enum: "TRANSPORTATION",
    slug: "transportation",
    name: "交通运输",
    nameEn: "Transportation",
    tagline: "电动化、智能调度、车路协同与物流降本。",
    icon: "🚆",
  },
  {
    enum: "AGRICULTURE_FORESTRY_FISHERY",
    slug: "agriculture-forestry-fishery",
    name: "农林牧渔",
    nameEn: "Agriculture, Forestry & Fishery",
    tagline: "智慧种养、粪污资源化、冷链与农产品溯源。",
    icon: "🌾",
  },
  {
    enum: "EDUCATION_TRAINING",
    slug: "education-training",
    name: "教育培训",
    nameEn: "Education & Training",
    tagline: "AI 助教、职业技能实训与个性化学习。",
    icon: "🎓",
  },
  {
    enum: "REAL_ESTATE_CONSTRUCTION",
    slug: "real-estate-construction",
    name: "房地产建筑",
    nameEn: "Real Estate & Construction",
    tagline: "绿色建筑、装配式施工、楼宇节能与智慧工地。",
    icon: "🏗️",
  },
  {
    enum: "OTHER",
    slug: "other",
    name: "其他",
    nameEn: "Other",
    tagline: "尚未归入六大行业的跨领域产业机会。",
    icon: "🧩",
  },
] as const;

/**
 * 公开可见的案例阶段（漏斗 DEEP_CASE 及以后）。
 * 见文件头业务规则说明。用字符串字面量，运行时直接进 Prisma `in` 过滤。
 */
export const PUBLIC_CASE_STAGES = [
  "DEEP_CASE",
  "KEY_SOLUTION",
  "PREMIUM_SOLUTION",
] as const;

const bySlug = new Map<string, IndustryMeta>(INDUSTRIES.map((i) => [i.slug, i]));
const byEnum = new Map<Industry, IndustryMeta>(INDUSTRIES.map((i) => [i.enum, i]));

/** 按 slug 取行业元数据；不存在返回 undefined。 */
export function getIndustryBySlug(slug: string): IndustryMeta | undefined {
  return bySlug.get(slug);
}

/** 按枚举值取行业元数据。 */
export function getIndustryByEnum(value: Industry): IndustryMeta | undefined {
  return byEnum.get(value);
}

/** 枚举值 → slug（用于生成案例/方案链接）。未知枚举回落 "other"。 */
export function getIndustrySlug(value: Industry): string {
  return byEnum.get(value)?.slug ?? "other";
}

/** 校验 slug 是否为合法行业 slug。 */
export function isValidIndustrySlug(slug: string): boolean {
  return bySlug.has(slug);
}

export interface IndustryCountResult {
  ok: boolean;
  /** slug → 公开可见案例数。DB 失败时全部为 0。 */
  counts: Record<string, number>;
  error?: string;
}

/** 全 0 计数（DB 失败兜底，保证页面仍可渲染 — 与首页 getTableCounts 同策略）。 */
function zeroCounts(): Record<string, number> {
  return Object.fromEntries(INDUSTRIES.map((i) => [i.slug, 0]));
}

/**
 * 查询每个行业的公开可见案例数。
 *
 * 用 groupBy 一次查回，避免 N+1。DB 不可达时返回 { ok:false, counts:全0, error }，
 * 让页面降级展示而非整页崩溃（宪法第 5 条：可运行优先；诚实标注查询失败）。
 */
export async function getIndustryCaseCounts(): Promise<IndustryCountResult> {
  try {
    const rows = await prisma.case.groupBy({
      by: ["industry"],
      where: { stage: { in: [...PUBLIC_CASE_STAGES] } },
      _count: { _all: true },
    });
    const counts = zeroCounts();
    for (const row of rows) {
      const meta = byEnum.get(row.industry as Industry);
      if (meta) counts[meta.slug] = row._count._all;
    }
    return { ok: true, counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("getIndustryCaseCounts failed", { err });
    return { ok: false, counts: zeroCounts(), error: message };
  }
}
