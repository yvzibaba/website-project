import type { Metadata } from "next";
import Link from "next/link";
import { Container, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { INDUSTRIES } from "@/server/industries";

/**
 * /about — 关于我们（V1-A，PRODUCT_SPEC §5/§6）。
 *
 * 内容来源：PRODUCT_SPEC §1（产品定位）、§6（首页体验/我们如何工作）。
 * 全部为产品事实性描述，不含需要法务确认的条款（那部分在 /privacy、/terms）。
 *
 * 诚实原则（宪法第 20 条）：明确写出当前处于 V1-A 开发阶段、
 * 数据库内容由每日流水线逐步填充，不夸大"已上线/已验证"。
 */

export const metadata: Metadata = {
  title: "关于我们",
  description:
    "我们每天从全球发现高价值产业案例，用 AI 拆解商业模式与技术路线，匹配开源能力并进行中国本土化重构，形成可购买、可实施的产业解决方案。",
};

const WORKFLOW_STEPS = [
  { title: "全球案例发现", desc: "从新闻、论文、年报与行业数据库中筛选六大产业的高价值真实案例。" },
  { title: "AI 拆解", desc: "拆解成功案例的商业模式、成本结构、收入来源与关键技术能力。" },
  { title: "开源匹配", desc: "在 GitHub 与开源生态中匹配可复用的技术能力，并做许可证、依赖与安全审查。" },
  { title: "中国本土化重构", desc: "结合中国供应链、设备、能源、政策与产业条件，把案例改造成可落地方案。" },
  { title: "产业解决方案", desc: "输出含成本模型、ROI、回收期、风险与关键未知变量的结构化方案。" },
  { title: "验证与项目", desc: "企业适配与真实验证，逐步演化为 POC 与产业项目机会（V2+）。" },
] as const;

export default function AboutPage() {
  return (
    <Container size="lg" className="py-10 flex flex-col gap-10">
      <PageHeader
        title="关于我们"
        description="发现全球产业机会，把成功案例重新变成你的解决方案。"
        breadcrumb={
          <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "关于" }]} />
        }
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">我们在做什么</h2>
        <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
          我们每天从全球发现高价值产业案例，把其中成功的商业模式、技术路线、专利论文、
          GitHub 开源能力，与中国的供应链和本土产业条件进行 AI 重构，形成
          <strong className="text-foreground">可购买、可实施、可进一步定制</strong>
          的产业解决方案。我们不是内容生成器，而是一套「发现 → 研究 → 验证 → 重构 → 生成 → 审查」
          的产业研究系统：高价值方案会经过多角色（Research / Bull / Bear / Judge / QA）交叉论证，
          关键数字要求来源可追溯、公式可复算，并明确区分事实、假设、推断与预测。
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">我们如何工作</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {WORKFLOW_STEPS.map((step, i) => (
            <Card key={step.title}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 font-mono text-xs text-primary">
                    {i + 1}
                  </span>
                  {step.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{step.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">覆盖行业</h2>
        <div className="flex flex-wrap gap-2">
          {INDUSTRIES.filter((i) => i.enum !== "OTHER").map((industry) => (
            <Link
              key={industry.slug}
              href={`/industries/${industry.slug}`}
              className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm transition-colors hover:border-ring"
            >
              <span aria-hidden>{industry.icon}</span>
              {industry.name}
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-muted/30 p-5 text-sm leading-6 text-muted-foreground">
        <h2 className="mb-2 font-semibold text-foreground">当前阶段说明</h2>
        <p>
          本站正处于 <strong className="text-foreground">V1-A 开发阶段</strong>，
          目标是先跑通「免费案例 → 标准方案 → 购买」的最小闭环。数据库中的案例与方案
          由每日流水线逐步发现、拆解与生成，当前可能为空或未完整填充——这是真实状态，
          我们不预置任何示例或伪造内容。涉及法律、投资、能源、医疗、政策等高风险领域的方案，
          均会标注「需要专业人工确认」。
        </p>
      </section>
    </Container>
  );
}
