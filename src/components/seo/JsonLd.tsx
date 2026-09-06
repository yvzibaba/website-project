import { serializeJsonLd, type JsonLdObject } from "@/lib/json-ld";

/**
 * JsonLd — 把 JSON-LD 对象渲染成 <script type="application/ld+json">（服务端组件，无客户端 JS）。
 *
 * XSS 安全（关键）：data 最终源自数据库里的案例/方案文本（AI 或人工产出）。
 * 净化统一委托给 lib/json-ld 的 `serializeJsonLd`（把 `<` 转成合法 JSON 转义 `<`），
 * 使 `</script>` 无法提前闭合脚本标签——净化单点、可被单测直连，避免此处逻辑漂移。
 *
 * 仅 `dangerouslySetInnerHTML` 承载我们**已自证净化**的串，不接任何未经转义的外部字符串。
 */
export function JsonLd({ data, id }: { data: JsonLdObject | JsonLdObject[]; id?: string }) {
  return <script type="application/ld+json" id={id} dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
