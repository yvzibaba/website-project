import type { Metadata } from "next";
import Link from "next/link";
import { Container, Badge, Button, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { JsonLd } from "@/components/seo";
import { SANDBOX_PROFILES, SANDBOX_PROFILES_VERSION } from "@/server/sandbox-profiles";
import { seoMetadata } from "@/lib/site";
import { breadcrumbJsonLd } from "@/lib/json-ld";

/**
 * /enterprise — 企业服务页（Phase 4 模块 E，V1-B 边界内的最小实现）。
 *
 * 目标（创始人 Phase 4 §二/§五）：让企业用户「描述自己 → 得到个性化测算」的最短路径：
 *   选一张企业画像卡 → 带画像进入沙盘（/sandbox?profile=…）→ 沙盘按画像预设参数重算 →
 *   报告追加「企业个性化视角」节。复用 R7 画像目录（SANDBOX_PROFILES），零引擎改动、零落库。
 *
 * 诚实边界（宪法第 20 条 / §十六自主执行规则）：
 *   - 完整「企业 AI 产业诊断」（企业画像建档 / 诊断报告 / 方案适配）属 V1-B，本页不做、不假装；
 *   - 画像预设全部是示例占位假设（ASSUMPTION，confidence≤50），只给"这类企业通常如此"的起点，
 *     用户可在沙盘逐项改写；结论恒需专业人工确认；
 *   - 本页为静态页，不查库、不写库（画像目录是版本化纯数据）。
 */

export const metadata: Metadata = {
  title: "企业服务 · 基础画像",
  description:
    "选择你的企业类型（车队 / 充电运营商 / 园区业主 / 公交市政 / 投资人），带画像进入决策沙盘，按企业视角重算 CAPEX/OPEX/NPV/IRR/回收期。完整企业 AI 诊断即将开放。",
  ...seoMetadata({
    title: "企业服务 · 基础画像",
    description:
      "选择企业画像并带入决策沙盘，按企业视角重算经济性与回收期（完整企业 AI 诊断属 V1-B，即将开放）。",
    path: "/enterprise",
  }),
};

/** 指标卡 key → 展示名（与沙盘指标卡一致口径，仅做翻译，不新增语义）。 */
const METRIC_LABEL: Record<string, string> = {
  npv: "NPV",
  irr: "IRR",
  payback: "回收期",
  roi: "ROI",
  breakeven: "盈亏平衡",
};

const STEPS = [
  { step: "① 选择企业画像", desc: "六类典型企业各有一组参数预设起点与决策侧重；也可不选，用通用口径。" },
  { step: "② 沙盘内改成你的条件", desc: "地区、车队规模、电价、光照、造价等参数全部可改，每次改动即时重算。" },
  { step: "③ 看个性化结果并保存", desc: "指标、敏感性、动态报告按画像侧重呈现；登录后可保存为项目、继续询价。" },
] as const;

export default function EnterprisePage() {
  return (
    <Container size="lg" className="py-10 flex flex-col gap-8">
      <JsonLd
        id="ld-enterprise-breadcrumb"
        data={breadcrumbJsonLd([
          { label: "首页", href: "/" },
          { label: "企业服务" },
        ])}
      />
      <PageHeader
        title="企业服务 · 基础画像"
        description="告诉平台你是哪类企业，用企业视角重算同一套确定性模型：先选画像，再进沙盘改成你的真实条件。"
        breadcrumb={<Breadcrumb items={[{ label: "首页", href: "/" }, { label: "企业服务" }]} />}
      >
        <Badge variant="info">基础能力 · V1</Badge>
      </PageHeader>

      <Alert variant="info" title="与「完整企业 AI 诊断」的边界">
        完整的企业画像建档、AI 诊断与方案适配属 <strong>V1-B 范围，尚未开放</strong>。
        本页当前提供的是基础能力：选择企业画像 → 带入决策沙盘按企业视角重算。
        页面不收集任何企业信息，不出具诊断结论。
      </Alert>

      {/* 三步用法 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">怎么用</h2>
        <ol className="grid gap-3 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.step} className="flex flex-col gap-1 rounded-lg border border-border bg-background p-4">
              <h3 className="text-sm font-semibold text-foreground">{s.step}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{s.desc}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* 六画像卡（复用 R7 画像目录，零新数据） */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">选择你的企业画像</h2>
          <span className="font-mono text-[11px] text-muted-foreground">profiles@{SANDBOX_PROFILES_VERSION}</span>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SANDBOX_PROFILES.map((p) => (
            <li key={p.id}>
              <article className="flex h-full flex-col gap-2 rounded-lg border border-border bg-background p-4 shadow-sm transition-all hover:border-ring hover:shadow-md">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-foreground">{p.name}</h3>
                  {p.id === "generic" ? <Badge variant="outline" compact>默认</Badge> : null}
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{p.summary}</p>
                <p className="text-xs leading-5 text-foreground/80">{p.emphasis.headline}</p>
                <div className="flex flex-wrap gap-1">
                  {p.emphasis.metricKeys.map((mk) => (
                    <Badge key={mk} variant="outline" compact>{METRIC_LABEL[mk] ?? mk}</Badge>
                  ))}
                </div>
                <div className="mt-auto pt-2">
                  {p.id === "generic" ? (
                    <Button variant="secondary" href="/sandbox" className="w-full">
                      直接进入沙盘 →
                    </Button>
                  ) : (
                    <Button variant="secondary" href={`/sandbox?profile=${encodeURIComponent(p.id)}`} className="w-full">
                      带画像进入沙盘 →
                    </Button>
                  )}
                </div>
              </article>
            </li>
          ))}
        </ul>
        <p className="text-xs leading-5 text-muted-foreground">
          诚实标注：全部画像预设均为<strong>示例占位假设</strong>（evidenceKind=ASSUMPTION，置信度 ≤50，
          来源带【示例·待核实】），只提供「这类企业常见量级」的起点，未经逐项核实，绝不当事实使用。
          你可以在沙盘中逐项改写为真实条件；涉及投资决策的结论<strong>需专业人工确认</strong>。
          画像预设的展示与选择也可在沙盘工作台内随时切换。
        </p>
      </section>

      {/* 延伸：登录后链路 */}
      <section className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4">
        <h2 className="text-sm font-semibold text-foreground">测算完之后</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          沙盘内可把当前情景<strong>保存为项目</strong>（记录参数快照、模型版本与结果），登录后随时重开或复制重算；
          也可以把情景导出为产业方案草案并<strong>询价购买</strong>。
          <Link href="/register" className="ml-1 text-primary underline underline-offset-4">注册 / 登录 →</Link>
        </p>
      </section>
    </Container>
  );
}
