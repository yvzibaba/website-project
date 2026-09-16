import type { Metadata } from "next";
import Link from "next/link";
import { Container, Badge, Button } from "@/components/ui";
import { SandboxUpgradePanel } from "@/components/sandbox/SandboxUpgradePanel";
import { JsonLd } from "@/components/seo";
import { seoMetadata } from "@/lib/site";
import { organizationJsonLd, websiteJsonLd } from "@/lib/json-ld";

/**
 * 首页 `/`（V1.1 批次 P3 · 三屏定位首页，方案 §3.2）。
 *
 * 定位从「产业案例引擎」门户收敛为**光储充投资决策软件**的着陆页，三屏：
 *   ① 一句话价值 + 主 CTA「免费算一个项目」（直达 /sandbox 一级沙盘，免登录）
 *   ② 三个真实商业问题卡（值不值得建 / 银行看什么 / 什么最怕），各配沙盘结果示例（示意数据·明确标注）
 *   ③ 真实案例验证区（诚实空态，不编造案例）+ 次级入口条（案例库 / 方案库 / 企业画像 / 行业）
 *
 * 示意数据取自沙盘当前示例参数的真实引擎输出（黄金样本口径，逐项可复算），并显式声明
 * 「示例参数 · 未经逐条核实 · 非真实项目结果」——与全库诚实纪律一致，绝不虚构项目业绩。
 *
 * 渲染方式：新版首页无任何数据库查询，纯静态预渲染（原 force-dynamic 随三屏重写移除）。
 */

/** 一句话定位（对外统一口径，方案 §3.2）。 */
export const HOME_TAGLINE = "新能源重卡光储充项目的投资决策软件";
export const HOME_VALUE_LINE = "3 分钟算清：投多少、几年回本、最怕什么";

export const metadata: Metadata = {
  title: {
    default: "光储充投资决策沙盘 · 3 分钟算清投多少、几年回本、最怕什么",
    template: "%s · 光储充投资决策沙盘",
  },
  description:
    "面向新能源重卡光储充项目的投资决策软件：拖动参数即时重算投资额、回收期、NPV/IRR 与最敏感变量，输出带口径与溯源声明的确定性报告。示例参数未经核实，结论需专业人工确认。",
  ...seoMetadata({
    title: "光储充投资决策沙盘 · 3 分钟算清投多少、几年回本、最怕什么",
    description:
      "面向新能源重卡光储充项目的投资决策软件：拖动参数即时重算投资额、回收期、NPV/IRR 与最敏感变量，输出带口径与溯源声明的确定性报告。示例参数未经核实，结论需专业人工确认。",
    path: "/",
  }),
};

/**
 * ② 三问卡的示意数据 = 沙盘当前示例参数（车队 60 台 / 桩 8×360kW / 光伏 500kWp / 储能 200kW/400kWh，
 * 山西·需量免征主情景）的引擎输出，与回归黄金逐字同源（tests/unit/sandbox-model.test.ts、
 * tests/unit/sandbox-store.test.ts 钉桩：NPV 4,448,573 / IRR 24.35% / 折现回收 5.14 年 /
 * 净投资 3,524,500 / 盈亏平衡充电单价 0.7431 元/kWh）。**展示前四舍五入到口语精度，并标「示意数据」。**
 */
const QUESTION_CARDS = [
  {
    q: "这个场站值不值得建？",
    a: "给出净现值与内部收益率：示例参数下 15 年净现值约 +445 万元、IRR 约 24%，屏幕上每个数字都随滑块即时重算。",
    mock: [
      { k: "净投资", v: "约 352 万元" },
      { k: "净现值 NPV", v: "约 +445 万元" },
      { k: "内部收益率 IRR", v: "约 24%" },
      { k: "折现回收期", v: "约 5.1 年" },
    ],
  },
  {
    q: "银行 / 合伙人会看哪些指标？",
    a: "报告一键生成：投资构成、成本收入拆解、回收期、盈亏平衡充电单价与全部口径声明——先按全投资（无杠杆）口径算清，贷款视角（还本付息覆盖）在规划中。",
    mock: [
      { k: "盈亏平衡充电单价", v: "约 0.74 元/kWh" },
      { k: "当前充电单价", v: "0.90 元/kWh" },
      { k: "动态报告", v: "改参数即整份重写" },
      { k: "口径与溯源", v: "逐条写进报告" },
    ],
  },
  {
    q: "哪个变量最怕动？",
    a: "关键因素影响力排行自动生成：电价、充电单价、利用率……谁最能左右回本，一眼看出该先核实哪个数。",
    mock: [
      { k: "敏感性排行", v: "自动按影响幅度排序" },
      { k: "龙卷风图", v: "每个变量拉多长一眼见" },
      { k: "政策场景", v: "需量电费 免征/征收 一键切换" },
      { k: "每个输入", v: "标注 示例·待核实" },
    ],
  },
] as const;

export default function Home() {
  return (
    <div className="flex flex-col">
      {/* 站点级结构化数据：Organization / WebSite 身份声明（纯加性，不含内容结论）。 */}
      <JsonLd id="ld-organization" data={organizationJsonLd()} />
      <JsonLd id="ld-website" data={websiteJsonLd()} />

      {/* ── 屏① 价值句 + 主 CTA ─────────────────────────────────────── */}
      <section className="border-b border-border bg-muted/30">
        <Container size="lg" className="py-20 flex flex-col items-start gap-5">
          <Badge variant="primary" className="w-fit">免费 · 无需注册 · 3 分钟出结果</Badge>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            {HOME_TAGLINE}
          </h1>
          <p className="max-w-2xl text-xl leading-8 text-muted-foreground sm:text-2xl">
            {HOME_VALUE_LINE}
          </p>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            车队规模、桩配置、光伏储能、电价与政策补贴……全部做成滑块；每次拖动都由计算引擎
            即时重算投资与回报，并生成一份带口径、假设与来源声明的报告。所有默认参数为
            示例值（未经逐条核实），结论需专业人工确认——它是帮你把问题问全的工具，不是替你拍板的顾问。
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button href="/sandbox" variant="primary" size="lg">免费算一个项目 →</Button>
            <Button href="/enterprise" variant="secondary" size="lg">先选我的企业类型</Button>
          </div>
        </Container>
      </section>

      {/* ── 屏② 三个真实商业问题（示意数据卡）──────────────────────── */}
      <section className="border-b border-border">
        <Container size="lg" className="py-14 flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">投资决策要回答的三个问题</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              下面每张小卡是沙盘的真实输出样式（示例参数下由计算引擎生成，非任何已建项目的业绩）。
            </p>
          </div>
          <ul className="grid gap-4 lg:grid-cols-3">
            {QUESTION_CARDS.map((c) => (
              <li key={c.q} className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
                <div className="flex flex-col gap-2 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-base font-semibold leading-6 text-foreground">{c.q}</h3>
                    <Badge variant="neutral" compact className="shrink-0">示意数据</Badge>
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">{c.a}</p>
                </div>
                <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border bg-muted/30 px-5 py-4">
                  {c.mock.map((m) => (
                    <div key={m.k} className="flex flex-col">
                      <dt className="text-xs text-muted-foreground">{m.k}</dt>
                      <dd className="text-sm font-semibold text-foreground tabular-nums">{m.v}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-5 text-muted-foreground">
            * 示意数据基于沙盘示例参数（车队 60 台 / 桩 8×360kW / 光伏 500kWp / 储能 200kW·400kWh / 需量电费免征情景）由计算引擎生成，
            参数均为【示例·待核实】，口径为全投资（无杠杆）简化年度模型，非可研级，不构成任何投资建议。
          </p>
        </Container>
      </section>

      {/* ── 屏②·B 免费 vs 专业 转化带（与沙盘结果页同一组件、同一口径，杜绝文案漂移）── */}
      <section className="border-b border-border bg-muted/20">
        <Container size="lg" className="py-14 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">先用免费的算清楚，再决定要不要专业版</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              免费版不是「试用然后卡住」——它本身就是一份能读、能核对口径的完整决策报告。
              下面列出升级到企业 / 人工尽调时才多出来的东西，全部真实可用或明确标注为人工交付，没有点了没反应的假功能。
            </p>
          </div>
          <SandboxUpgradePanel level="basic" contactAnchorHint="企业页 / 沙盘报告尾的留资表单" />
        </Container>
      </section>

      {/* ── 屏③ 真实案例验证区（诚实空态）+ 次级入口条 ─────────────── */}
      <section className="bg-muted/20">
        <Container size="lg" className="py-14 flex flex-col gap-6">
          <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-background p-6 shadow-sm">
            <Badge variant="info" className="w-fit">真实案例验证中</Badge>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">用真实项目验证这套算法</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              我们坚持不拿编造的项目业绩做宣传：沙盘当前的每一个输出都标明示例参数与计算口径。
              真实案例的输入数据、计算结果与事后核对正在首批用户验证中产生——
              <strong className="text-foreground">首批用户将获得免费企业适配与人工复核通道</strong>。
            </p>
            <div>
              <Button href="/sandbox" variant="secondary">现在就算我的项目 →</Button>
            </div>
          </div>

          {/* 次级入口：保留原有门户能力（案例 / 方案 / 企业 / 行业），收敛为一条入口带，避免稀释主定位。 */}
          <nav aria-label="站点入口" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Link href="/cases" className="group rounded-lg border border-border bg-background p-4 shadow-sm transition-all hover:border-ring hover:shadow-md">
              <h3 className="text-sm font-semibold text-foreground group-hover:text-primary">产业案例库</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">全球新能源案例，经 AI 拆解与人工审核。</p>
            </Link>
            <Link href="/solutions" className="group rounded-lg border border-border bg-background p-4 shadow-sm transition-all hover:border-ring hover:shadow-md">
              <h3 className="text-sm font-semibold text-foreground group-hover:text-primary">产业方案库</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">可购买的落地方案，含成本收益与风险清单。</p>
            </Link>
            <Link href="/enterprise" className="group rounded-lg border border-border bg-background p-4 shadow-sm transition-all hover:border-ring hover:shadow-md">
              <h3 className="text-sm font-semibold text-foreground group-hover:text-primary">企业画像</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">选车队 / 运营商 / 园区 / 投资人视角，沙盘预设随企业视角重排。</p>
            </Link>
            <Link href="/industries" className="group rounded-lg border border-border bg-background p-4 shadow-sm transition-all hover:border-ring hover:shadow-md">
              <h3 className="text-sm font-semibold text-foreground group-hover:text-primary">按行业浏览</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">重卡充电、光伏、储能、充电网络等赛道入口。</p>
            </Link>
          </nav>
        </Container>
      </section>
    </div>
  );
}
