import { SITE_NAME, absoluteUrl } from "@/lib/site";

/**
 * JSON-LD 结构化数据构造器（Phase 14 M2，SEO 供给侧）。
 *
 * 为什么是「纯函数 + 无 DB / 无 Next 运行时依赖」（与 lib/site.ts 同构）：
 *   - 可被 client / server 两侧安全导入，可在单测里逐字节断言产物（宪法第 7 条：可复算、可验证）；
 *   - 数据来自各页已加载的 CaseDetail / SolutionDetail，这里只做**形状映射**，绝不查库、绝不补数。
 *
 * 诚实边界（宪法第 20 条，务必遵守）：
 *   - **只为真实产出**发结构化数据：DEMO 案例/方案不是真实研究/可售品，调用方须先判 `!isDemo` 再渲染（本模块不重复裁决，避免与页面 noindex 口径漂移）；
 *   - **缺字段就省略，绝不臆造**：无摘要不出 description、无合法价不出 offers.price、无来源链不出 citation、**无 OG 图就不出 image**（站方刻意不提供，见 site.ts）；
 *   - 只映射既有的事实字段（标题/摘要/日期/来源 URL/行业/地区/定价），不引入任何模型未产出的「结论」。
 *
 * hreflang **刻意不实现**：站点当前无多语言版本，硬加 `alternate hreflang` 等于虚构不存在的语种 URL（违 §20），留待真正 i18n 后再补。
 *
 * schema.org 参考：https://schema.org/{Article,Product,Offer,BreadcrumbList,CollectionPage,Organization,WebSite}
 */

/** JSON-LD 节点就是一个可序列化的普通对象；类型收口在此，避免各处裸 any。 */
export type JsonLdObject = Record<string, unknown>;

/** 面包屑单项（与各页 <Breadcrumb items> 形状一致：href 省略即当前页）。 */
export interface JsonLdBreadcrumbItem {
  label: string;
  href?: string;
}

const ORG: JsonLdObject = {
  "@type": "Organization",
  name: SITE_NAME,
  url: absoluteUrl("/"),
};

/** 站点级 Organization（供首页 WebSite.publisher 及复用）。 */
export function organizationJsonLd(): JsonLdObject {
  return { "@context": "https://schema.org", ...ORG };
}

/**
 * 首页 WebSite 节点：声明站点身份与规范 URL。
 * 不塞 SearchAction（站内搜索页刻意 noindex/disallow，见 robots.ts，避免引导爬虫索引查询串页）。
 */
export function websiteJsonLd(opts: { description?: string } = {}): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: absoluteUrl("/"),
    inLanguage: "zh-CN",
    ...(opts.description ? { description: opts.description } : {}),
    publisher: ORG,
  };
}

/**
 * 案例 → schema.org Article。
 * 仅映射 CaseDetail 既有事实字段；作者/发布方统一为站点组织（研究由平台流水线产出），
 * 地区落成 contentLocation，来源 URL 落成 citation（有则挂、无则省）。
 */
export function caseArticleJsonLd(input: {
  id: string;
  title: string;
  summary: string | null;
  industryName: string;
  regionName: string | null;
  regionCountry: string | null;
  sourceUrl: string | null;
  discoveredAt: Date;
  /** CaseDetail 若日后可携带更新时间则传入；缺省则不臆造 dateModified。 */
  updatedAt?: Date | null;
}): JsonLdObject {
  const url = absoluteUrl(`/cases/${input.id}`);
  const location = buildPlace(input.regionName, input.regionCountry);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: stripDemoPrefix(input.title),
    ...(input.summary ? { description: input.summary } : {}),
    inLanguage: "zh-CN",
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    datePublished: iso(input.discoveredAt),
    ...(input.updatedAt ? { dateModified: iso(input.updatedAt) } : {}),
    author: ORG,
    publisher: ORG,
    keywords: input.industryName,
    ...(location ? { contentLocation: location } : {}),
    ...(input.sourceUrl ? { citation: { "@type": "CreativeWork", url: input.sourceUrl } } : {}),
  };
}

/**
 * 方案 → schema.org Product + Offer。
 * 诚实要点：
 *   - 定价仅在「免费」或「能从展示串解析出数字」时输出；「定价待定」/null → **省略 offers**，不编造价格；
 *   - 不提供 image / availability（站方无 OG 图、数字报告也无库存语义，硬填即虚构）。
 */
export function solutionProductJsonLd(input: {
  id: string;
  title: string;
  summary: string | null;
  industryName: string;
  isFree: boolean;
  currency: string;
  priceDisplay: string | null;
  caseTitle: string;
  publishedAt: Date | null;
}): JsonLdObject {
  const url = absoluteUrl(`/solutions/${input.id}`);
  const price = input.isFree ? "0" : parsePriceNumber(input.priceDisplay);
  const product: JsonLdObject = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: stripDemoPrefix(input.title),
    ...(input.summary ? { description: input.summary } : {}),
    category: input.industryName,
    url,
    brand: ORG,
    ...(input.publishedAt ? { datePublished: iso(input.publishedAt) } : {}),
    // isBasedOn：诚实记录该方案源自哪个案例（有标题即可挂文案引用，不编 URL 除非有 id）
    isBasedOn: input.caseTitle ? `源自产业案例：${stripDemoPrefix(input.caseTitle)}` : undefined,
  };
  if (price != null) {
    product.offers = {
      "@type": "Offer",
      price,
      priceCurrency: input.currency,
      url,
    };
  }
  // 清掉显式 undefined（保持产物最小、可逐字段断言）
  return dropUndefined(product);
}

/** 面包屑 → BreadcrumbList（末项无 href 时按 Google 规范可省 item）。 */
export function breadcrumbJsonLd(items: JsonLdBreadcrumbItem[]): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: stripDemoPrefix(it.label),
      ...(it.href ? { item: absoluteUrl(it.href) } : {}),
    })),
  };
}

/** 列表页 → CollectionPage（声明集合页身份，mainEntity 指向自身规范 URL，不逐条铺开以免臃肿）。 */
export function collectionPageJsonLd(input: {
  name: string;
  description?: string;
  path: string;
}): JsonLdObject {
  const url = absoluteUrl(input.path);
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    url,
    inLanguage: "zh-CN",
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: absoluteUrl("/") },
    publisher: ORG,
  };
}

// ---------- 内部小工具（纯函数，导出于此仅便于单测直连） ----------

/** 去【DEMO】前缀：结构化数据只描述真实语义，别把内部演示标记灌进搜索摘要。 */
function stripDemoPrefix(title: string): string {
  return title.replace(/^【DEMO】/, "").trim();
}

/** Date → ISO8601 字符串（schema.org 接受 ISO 文本）。 */
function iso(d: Date): string {
  return new Date(d).toISOString();
}

/** 地区 → Place（只挂确知的名称/国家，任一缺省即降级/省略，绝不臆造）。 */
function buildPlace(regionName: string | null, regionCountry: string | null): JsonLdObject | undefined {
  if (!regionName && !regionCountry) return undefined;
  const place: JsonLdObject = { "@type": "Place" };
  if (regionName) place.name = regionName;
  if (regionCountry) place.address = { "@type": "Country", name: regionCountry };
  return place;
}

/**
 * 从展示价串解析纯数字价（如 "¥1,200"→"1200"、"$19.9"→"19.9"）。
 * 解析不出数字（null / "定价待定" / 无数字）→ 返回 null，令调用方**省略价格**而非编造。
 */
export function parsePriceNumber(priceDisplay: string | null): string | null {
  if (!priceDisplay) return null;
  const digits = priceDisplay.replace(/[^\d.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n >= 0 ? String(n) : null;
}

/** 递归剔除对象里的 undefined 值，产出最小、稳定、可逐字段断言的 JSON-LD。 */
function dropUndefined<T extends JsonLdObject>(obj: T): T {
  const out: JsonLdObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

/**
 * 序列化为可安全内联进 <script type="application/ld+json"> 的字符串（净化单点，供渲染器复用 + 可单测）。
 *
 * 把**所有** `<` 转义为 `<`：JSON 仍完全合法（< 是合法字符串转义），
 * 但浏览器不再把它当标签起始，杜绝内容里的 `</script>` 提前闭合脚本并注入 HTML（SECURITY：绝不裸插未净化内容）。
 * 数据源自 DB 的标题/摘要（AI/人工产出），故净化不可省。
 */
export function serializeJsonLd(data: JsonLdObject | JsonLdObject[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
