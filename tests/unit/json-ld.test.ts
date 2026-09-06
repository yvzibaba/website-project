import { describe, expect, it } from "vitest";
import { absoluteUrl, SITE_NAME } from "@/lib/site";
import {
  breadcrumbJsonLd,
  caseArticleJsonLd,
  collectionPageJsonLd,
  organizationJsonLd,
  parsePriceNumber,
  serializeJsonLd,
  solutionProductJsonLd,
  websiteJsonLd,
  type JsonLdObject,
} from "@/lib/json-ld";

/**
 * 单元测试：JSON-LD 构造器（src/lib/json-ld.ts，Phase 14 M2）。
 *
 * 核心断言围绕**诚实边界（宪法第 20 条）**：缺字段就省略、绝不臆造（无摘要/无价/无来源/无地区 → 对应键不出现），
 * 以及 XSS 净化（`</script>` 被转义）与形状稳定（@context / @type / 相对→绝对 URL）。
 * URL 一律用 absoluteUrl 求期望值，避免把测试和 SITE_URL 默认值（localhost）写死耦合。
 */

const articleBase = {
  id: "case123",
  title: "某储能项目案例",
  summary: "一段摘要",
  industryName: "储能",
  regionName: "山西",
  regionCountry: "中国",
  sourceUrl: "https://example.com/report",
  discoveredAt: new Date("2026-01-02T03:04:05.000Z"),
};

describe("caseArticleJsonLd", () => {
  it("映射事实字段为 Article（headline/dates/url/publisher/keywords/contentLocation/citation）", () => {
    const ld = caseArticleJsonLd(articleBase);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Article");
    expect(ld.headline).toBe("某储能项目案例");
    expect(ld.description).toBe("一段摘要");
    expect(ld.url).toBe(absoluteUrl("/cases/case123"));
    expect((ld.mainEntityOfPage as JsonLdObject)["@id"]).toBe(absoluteUrl("/cases/case123"));
    expect(ld.datePublished).toBe("2026-01-02T03:04:05.000Z");
    expect((ld.publisher as JsonLdObject).name).toBe(SITE_NAME);
    expect((ld.author as JsonLdObject).name).toBe(SITE_NAME);
    expect(ld.keywords).toBe("储能");
    expect((ld.contentLocation as JsonLdObject).name).toBe("山西");
    expect(((ld.contentLocation as JsonLdObject).address as JsonLdObject).name).toBe("中国");
    expect((ld.citation as JsonLdObject).url).toBe("https://example.com/report");
  });

  it("去掉【DEMO】标题前缀，不把内部演示标记灌进结构化数据", () => {
    const ld = caseArticleJsonLd({ ...articleBase, title: "【DEMO】示例案例" });
    expect(ld.headline).toBe("示例案例");
  });

  it("诚实省略：无摘要/无地区/无来源 → description / contentLocation / citation 均不出现（绝不臆造）", () => {
    const ld = caseArticleJsonLd({
      ...articleBase,
      summary: null,
      regionName: null,
      regionCountry: null,
      sourceUrl: null,
    });
    expect("description" in ld).toBe(false);
    expect("contentLocation" in ld).toBe(false);
    expect("citation" in ld).toBe(false);
  });

  it("无 updatedAt 时不臆造 dateModified", () => {
    const ld = caseArticleJsonLd(articleBase);
    expect("dateModified" in ld).toBe(false);
    const ld2 = caseArticleJsonLd({ ...articleBase, updatedAt: new Date("2026-02-02T00:00:00.000Z") });
    expect(ld2.dateModified).toBe("2026-02-02T00:00:00.000Z");
  });

  it("刻意不提供 image（站方无 OG 图，避免虚构资源）", () => {
    expect("image" in caseArticleJsonLd(articleBase)).toBe(false);
  });
});

const productBase = {
  id: "sol123",
  title: "储能解决方案",
  summary: "方案摘要",
  industryName: "储能",
  isFree: false,
  currency: "CNY",
  priceDisplay: "¥1,200",
  caseTitle: "某储能项目案例",
  publishedAt: new Date("2026-03-01T00:00:00.000Z"),
};

describe("solutionProductJsonLd", () => {
  it("映射为 Product，价格可解析时挂 Offer（price/priceCurrency/url）", () => {
    const ld = solutionProductJsonLd(productBase);
    expect(ld["@type"]).toBe("Product");
    expect(ld.name).toBe("储能解决方案");
    expect(ld.category).toBe("储能");
    expect(ld.url).toBe(absoluteUrl("/solutions/sol123"));
    expect(ld.datePublished).toBe("2026-03-01T00:00:00.000Z");
    const offers = ld.offers as JsonLdObject;
    expect(offers["@type"]).toBe("Offer");
    expect(offers.price).toBe("1200");
    expect(offers.priceCurrency).toBe("CNY");
    expect(offers.url).toBe(absoluteUrl("/solutions/sol123"));
  });

  it("免费方案 → Offer.price 为 '0'", () => {
    const ld = solutionProductJsonLd({ ...productBase, isFree: true, priceDisplay: null });
    expect((ld.offers as JsonLdObject).price).toBe("0");
  });

  it("诚实省略：'定价待定' / null 价 → 不输出 offers（绝不编造价格）", () => {
    const pending = solutionProductJsonLd({ ...productBase, priceDisplay: "定价待定" });
    expect("offers" in pending).toBe(false);
    const nullPrice = solutionProductJsonLd({ ...productBase, isFree: false, priceDisplay: null });
    expect("offers" in nullPrice).toBe(false);
  });

  it("isBasedOn 引用来源案例标题且去【DEMO】；无摘要省略 description；不臆造 image/availability", () => {
    const ld = solutionProductJsonLd({ ...productBase, summary: null, caseTitle: "【DEMO】示例" });
    expect("description" in ld).toBe(false);
    expect(ld.isBasedOn).toBe("源自产业案例：示例");
    expect("image" in ld).toBe(false);
    const offers = ld.offers as JsonLdObject;
    expect("availability" in offers).toBe(false);
    expect("itemAvailability" in offers).toBe(false);
  });

  it("publishedAt=null 时省略 datePublished", () => {
    const ld = solutionProductJsonLd({ ...productBase, publishedAt: null });
    expect("datePublished" in ld).toBe(false);
  });
});

describe("breadcrumbJsonLd", () => {
  it("生成有序 BreadcrumbList，末项（无 href）不带 item", () => {
    const ld = breadcrumbJsonLd([
      { label: "首页", href: "/" },
      { label: "案例", href: "/cases" },
      { label: "当前案例" },
    ]);
    expect(ld["@type"]).toBe("BreadcrumbList");
    const list = ld.itemListElement as JsonLdObject[];
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ "@type": "ListItem", position: 1, name: "首页", item: absoluteUrl("/") });
    expect(list[1].item).toBe(absoluteUrl("/cases"));
    expect("item" in list[2]).toBe(false);
    expect(list[2].name).toBe("当前案例");
  });
});

describe("collectionPageJsonLd", () => {
  it("集合页 → CollectionPage，含 isPartOf/publisher，url 绝对化", () => {
    const ld = collectionPageJsonLd({ name: "案例", description: "描述", path: "/cases" });
    expect(ld["@type"]).toBe("CollectionPage");
    expect(ld.name).toBe("案例");
    expect(ld.description).toBe("描述");
    expect(ld.url).toBe(absoluteUrl("/cases"));
    expect((ld.isPartOf as JsonLdObject).url).toBe(absoluteUrl("/"));
    expect("description" in collectionPageJsonLd({ name: "x", path: "/x" })).toBe(false);
  });
});

describe("organizationJsonLd / websiteJsonLd", () => {
  it("站点级身份：Organization / WebSite 均含 @context 与规范 URL", () => {
    const org = organizationJsonLd();
    expect(org["@type"]).toBe("Organization");
    expect(org.name).toBe(SITE_NAME);
    const site = websiteJsonLd();
    expect(site["@type"]).toBe("WebSite");
    expect(site.url).toBe(absoluteUrl("/"));
    expect((site.publisher as JsonLdObject).name).toBe(SITE_NAME);
    // 不塞 SearchAction（站内搜索页刻意 noindex/disallow）
    expect("potentialAction" in site).toBe(false);
  });
});

describe("parsePriceNumber", () => {
  it("从展示串抽取纯数字价，异常输入返回 null", () => {
    expect(parsePriceNumber("¥1,200")).toBe("1200");
    expect(parsePriceNumber("$19.9")).toBe("19.9");
    expect(parsePriceNumber("免费")).toBeNull();
    expect(parsePriceNumber("定价待定")).toBeNull();
    expect(parsePriceNumber(null)).toBeNull();
  });
});

describe("serializeJsonLd（XSS 净化）", () => {
  it("转义 < 使 </script> 无法提前闭合脚本标签，且产物仍是合法 JSON", () => {
    const payload = { name: "</script><img src=x onerror=alert(1)>", url: "https://a.test" };
    const s = serializeJsonLd(payload);
    expect(s).not.toContain("</script>");
    expect(s).toContain("\\u003c");
    // 反解析回原对象，证明转义不破坏 JSON 结构
    expect(JSON.parse(s)).toEqual(payload);
  });
});
