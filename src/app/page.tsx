import type { Metadata } from "next";
import Link from "next/link";
import { Container, Badge, Button, Input, Alert } from "@/components/ui";
import { EmptyState } from "@/components/page";
import { INDUSTRIES } from "@/server/industries";
import { listPublicCases } from "@/server/cases";
import { listPublishedSolutions } from "@/server/solutions";

/**
 * 首页 `/`（V1-A，总控第 6 节 / PRODUCT_SPEC §6）。
 *
 * 明确不是"AI 聊天机器人"。六屏结构：
 *   ① 主视觉 + 两个入口（发现产业方案 / 分析我的企业[V1-B 未开放，诚实置灰]）+ 搜索框
 *   ② 今日全球产业案例（六大行业每日精选；当前库空则诚实空态）
 *   ③ 今日产业解决方案（3 个精选；里程碑 2 起不种子方案，故当前空态）
 *   ④ 企业 AI 产业诊断（V1-B，文案 + 即将开放）
 *   ⑤ 我们如何工作（六步工作流）
 *   ⑥ 六大行业入口
 *
 * force-dynamic：案例/方案计数与最新条目须实时。DB 不可达时相关区块降级为提示而非崩溃。
 * 首页展示真实数据（includeDemo=false）——DEMO 仅用于 /cases?demo=1 的开发验证，不在首页出现。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "产业案例与解决方案引擎 · 发现全球产业机会",
    template: "%s · 产业案例与解决方案引擎",
  },
  description:
    "发现全球产业机会，把成功案例重新变成你的解决方案：AI 拆解全球产业案例、匹配开源技术、中国本土化重构，形成可购买、可实施的产业解决方案。",
};

/** 六步工作流（总控第 6 节第五部分 / about 页一致口径）。 */
const WORKFLOW = [
  { step: "全球案例", desc: "每日从六大产业发现高价值真实案例" },
  { step: "AI 拆解", desc: "拆解商业模式、技术能力与关键数字" },
  { step: "开源技术匹配", desc: "在 GitHub / 开源生态中匹配可复用能力" },
  { step: "中国本土化重构", desc: "结合本土供应链、政策与成本重构方案" },
  { step: "产业解决方案", desc: "形成含成本/收益/风险/未知变量的方案" },
  { step: "企业验证与项目", desc: "企业适配、真实验证，发现项目机会" },
] as const;

export default async function Home() {
  // 首页只展示真实数据（不含 DEMO）；两类查询并行，DB 失败各自降级。
  const [cases, solutions] = await Promise.all([
    listPublicCases({
      offset: 0,
      limit: 6,
      page: 1,
      pageSize: 6,
      sortBy: "discoveredAt",
      sortOrder: "desc",
      includeDemo: false,
    }),
    listPublishedSolutions({
      offset: 0,
      limit: 3,
      page: 1,
      pageSize: 3,
      sortBy: "publishedAt",
      sortOrder: "desc",
      includeDemo: false,
    }),
  ]);

  return (
    <div className="flex flex-col">
      {/* ① 主视觉 */}
      <section className="border-b border-border bg-muted/30">
        <Container size="lg" className="py-16 flex flex-col gap-6">
          <Badge variant="primary" className="w-fit">V1-A · 案例 → 方案 → 购买 最小闭环</Badge>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            发现全球产业机会，把成功案例重新变成你的解决方案。
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
            我们把全球真实产业案例经 AI 拆解、开源技术匹配与中国本土化重构，
            形成可购买、可实施、含成本/收益/风险与关键未知变量的产业解决方案。
          </p>

          {/* 搜索入口 */}
          <form method="get" action="/search" role="search" className="flex max-w-xl gap-2 pt-1">
            <Input
              type="search"
              name="q"
              placeholder="搜索产业案例或方案，如：沼气、储能、视觉质检…"
              aria-label="搜索关键词"
              maxLength={100}
              className="flex-1 bg-background"
            />
            <Button type="submit" variant="secondary">搜索</Button>
          </form>

          {/* 两个主入口 */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button href="/cases" variant="primary" size="lg">发现产业方案</Button>
            <Button
              variant="secondary"
              size="lg"
              disabled
              title="企业 AI 产业诊断属 V1-B 范围，尚未开放"
            >
              分析我的企业（即将开放）
            </Button>
          </div>
        </Container>
      </section>

      {/* ② 今日全球产业案例 */}
      <Container size="lg" className="py-12 flex flex-col gap-5">
        <SectionHead
          title="今日全球产业案例"
          desc="六大产业每日精选、经 AI 深度拆解的真实案例，免费查看。"
          moreHref="/cases"
          moreLabel="浏览全部案例"
        />
        {!cases.ok ? (
          <Alert variant="warning" title="案例暂不可用">数据库可能正在冷启动或不可达，请稍后重试。</Alert>
        ) : cases.items.length === 0 ? (
          <EmptyState
            title="暂无公开案例"
            description="真实案例由每日流水线（60 候选 → 20 重点 → 10 深度 → 3 方案 → 1 精品）自动发现并填充，当前尚未有公开案例。"
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cases.items.map((c) => (
              <li key={c.id}>
                <Link href={`/cases/${c.id}`} className="group block h-full">
                  <article className="flex h-full flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" compact>{c.industryName}</Badge>
                      {typeof c.opportunityScore === "number" ? (
                        <span className="ml-auto text-xs text-muted-foreground">
                          机会评分 <strong className="text-foreground tabular-nums">{c.opportunityScore}</strong>
                        </span>
                      ) : null}
                    </div>
                    <h3 className="text-base font-semibold leading-6 text-foreground group-hover:text-primary">{c.title}</h3>
                    {c.summary ? <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{c.summary}</p> : null}
                  </article>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Container>

      {/* ③ 今日产业解决方案 */}
      <section className="border-y border-border bg-muted/20">
        <Container size="lg" className="py-12 flex flex-col gap-5">
          <SectionHead
            title="今日产业解决方案"
            desc="可购买、可实施、可定制的方案，含成本/收益模型、ROI、回收期、风险与关键未知变量。"
            moreHref="/solutions"
            moreLabel="浏览全部方案"
          />
          {!solutions.ok ? (
            <Alert variant="warning" title="方案暂不可用">数据库可能正在冷启动或不可达，请稍后重试。</Alert>
          ) : solutions.items.length === 0 ? (
            <EmptyState
              icon="📦"
              title="暂无已发布的产业解决方案"
              description="方案须由每日流水线经技术匹配、开源许可证检查、中国本土化重构与多角色质量门禁（Research → Bull → Bear → Judge → QA）生成，并经人工审核后方可发布。当前尚未有方案发布。"
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-3">
              {solutions.items.map((s) => (
                <li key={s.id}>
                  <Link href={`/solutions/${s.id}`} className="group block h-full">
                    <article className="flex h-full flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" compact>{s.industryName}</Badge>
                        {s.priceDisplay ? (
                          <span className="ml-auto text-sm font-semibold text-foreground tabular-nums">{s.priceDisplay}</span>
                        ) : null}
                      </div>
                      <h3 className="text-base font-semibold leading-6 text-foreground group-hover:text-primary">{s.title}</h3>
                      {s.summary ? <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{s.summary}</p> : null}
                    </article>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Container>
      </section>

      {/* ④ 企业 AI 产业诊断（V1-B） */}
      <Container size="lg" className="py-12 flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
          <Badge variant="info" className="mb-3">V1-B · 即将开放</Badge>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">企业 AI 产业诊断</h2>
          <p className="mt-2 max-w-2xl text-base leading-7 text-muted-foreground">
            告诉 AI 你的企业有什么，AI 帮你寻找下一步可以做什么。基于企业画像与产业能力数据库，
            给出可落地的转型方向与方案适配建议。
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            该能力属 V1-B 范围（企业画像 / 诊断 / 适配），将在 V1-A 的案例 → 方案 → 购买闭环跑通后开放。
          </p>
        </div>
      </Container>

      {/* ⑤ 我们如何工作 */}
      <section className="border-t border-border bg-muted/20">
        <Container size="lg" className="py-12 flex flex-col gap-5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">我们如何工作</h2>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {WORKFLOW.map((w, i) => (
              <li key={w.step} className="flex flex-col gap-1 rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <h3 className="text-sm font-semibold text-foreground">{w.step}</h3>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{w.desc}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* ⑥ 六大行业入口 */}
      <Container size="lg" className="py-12 flex flex-col gap-5">
        <SectionHead title="按行业浏览" desc="选择你关注的产业，查看该行业的案例与方案。" moreHref="/industries" moreLabel="全部行业" />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {INDUSTRIES.map((ind) => (
            <li key={ind.slug}>
              <Link href={`/industries/${ind.slug}`} className="group block h-full">
                <article className="flex h-full flex-col gap-1 rounded-lg border border-border bg-background p-4 shadow-sm transition-all group-hover:border-ring group-hover:shadow-md">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="text-lg">{ind.icon}</span>
                    <h3 className="text-base font-semibold text-foreground group-hover:text-primary">{ind.name}</h3>
                    <span className="ml-auto text-xs text-muted-foreground">{ind.nameEn}</span>
                  </div>
                  <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{ind.tagline}</p>
                </article>
              </Link>
            </li>
          ))}
        </ul>
      </Container>
    </div>
  );
}

interface SectionHeadProps {
  title: string;
  desc: string;
  moreHref: string;
  moreLabel: string;
}

function SectionHead({ title, desc, moreHref, moreLabel }: SectionHeadProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{desc}</p>
      </div>
      <Link href={moreHref} className="text-sm text-primary underline-offset-4 hover:underline">
        {moreLabel} →
      </Link>
    </div>
  );
}
