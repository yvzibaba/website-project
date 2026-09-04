import type { Metadata } from "next";
import { Container, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";

/**
 * /terms — 服务条款（V1-A 占位，PRODUCT_SPEC §5）。
 *
 * ⚠️ 法务边界（宪法第 21 条）：
 *   正式服务条款/购买协议属于法律文件，须由法务/律师起草审定。此页为结构化占位大纲，
 *   列出上线前必须覆盖的条款，并特别标出本产品**必须包含**的 AI 免责声明要点
 *   （内容为 AI 研究产出、区分事实/假设/推断/预测、高风险领域需专业人工确认、
 *   不构成投资/法律/工程等专业意见）——这些是产品事实，但最终法律表述仍待法务确认。
 */

export const metadata: Metadata = {
  title: "服务条款",
  description: "服务条款（草稿占位，待法务审定）。",
  robots: { index: false, follow: false },
};

const SECTIONS: ReadonlyArray<{ title: string; desc: string; highlight?: boolean }> = [
  { title: "服务说明", desc: "本站提供产业案例研究、解决方案内容与购买服务；明确 V1 阶段的功能范围。" },
  { title: "账号与实名", desc: "注册资格、账号安全、企业信息真实性责任。" },
  { title: "内容与知识产权", desc: "案例/方案内容的权属、许可范围、用户对购买方案的使用边界（个人/企业内使用、禁止转售等）。" },
  { title: "购买、支付与退款", desc: "单份方案一次性购买的定价、支付方式、发票、退款与争议处理规则。" },
  { title: "AI 生成内容免责声明", desc: "关键要点见下方高亮框：内容为 AI 研究产出，可能含假设/推断/预测，不构成专业意见。", highlight: true },
  { title: "用户行为规范", desc: "禁止滥用、爬取、逆向、违法使用等。" },
  { title: "责任限制", desc: "在适用法律允许范围内的责任上限与免责情形。" },
  { title: "条款变更、适用法律与争议解决", desc: "变更通知方式、适用法域、管辖与争议解决机制。" },
];

const AI_DISCLAIMER_POINTS = [
  "站内案例与方案为 AI 研究系统的产出，用于产业参考，不构成投资、法律、财务、工程安全或医疗等专业意见。",
  "内容会明确区分「事实 / 假设 / 推断 / 预测」；关键数字标注来源与假设，用户须自行复核后再据以决策。",
  "涉及法律、投资、融资、金融、工程安全、环保、土地、能源、电力、医疗、政策、重大设备等高风险领域的方案，均标注「需要专业人工确认」，用户应咨询具备资质的专业人士。",
  "AI 输出可能存在错误或遗漏；在法律允许范围内，本站不对基于内容作出的商业决策结果承担责任。",
] as const;

export default function TermsPage() {
  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="服务条款"
        description="本页为开发阶段的结构化占位，尚未生效。"
        breadcrumb={
          <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "服务条款" }]} />
        }
      />

      <Alert variant="warning" title="待法务审定 · 尚未生效">
        正式服务条款与购买协议属于法律文件，须由具备资质的法务/律师起草审定后方可发布。
        以下为上线前必须覆盖的条款大纲，<strong>不构成任何生效的法律约定</strong>。
      </Alert>

      <ol className="flex flex-col gap-4">
        {SECTIONS.map((section, i) => (
          <li
            key={section.title}
            className="flex gap-4 rounded-lg border border-dashed border-border bg-muted/20 p-4"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs text-muted-foreground">
              {i + 1}
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold text-foreground">
                {section.title}
                {section.highlight ? (
                  <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                    产品必含
                  </span>
                ) : null}
              </h2>
              <p className="text-sm leading-6 text-muted-foreground">{section.desc}</p>
            </div>
          </li>
        ))}
      </ol>

      <section className="flex flex-col gap-3 rounded-lg border border-info/30 bg-info/5 p-5">
        <h2 className="text-sm font-semibold text-foreground">
          AI 生成内容免责声明（拟定要点，最终表述待法务确认）
        </h2>
        <ul className="flex flex-col gap-2">
          {AI_DISCLAIMER_POINTS.map((point) => (
            <li key={point} className="flex gap-2 text-sm leading-6 text-muted-foreground">
              <span aria-hidden className="text-info">•</span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </section>
    </Container>
  );
}
