import type { Metadata } from "next";
import { Container } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { FreeDiagnosePanel } from "@/components/diagnose/FreeDiagnosePanel";
import { seoMetadata } from "@/lib/site";

/**
 * /diagnose — 免登录「免费诊断」公开漏斗第一屏（V2 R3 · 落地 P5）。
 *
 * P5 的要求很具体：免费层不能只丢一张"留资表单"给用户，要先给**结论倾向**。
 * 本页让访客在注册、建项目之前，就用**同一台生产引擎**跑一套配置，拿到
 * "方向正不正、有没有一眼就该否决的硬问题"，再决定是否深入。
 *
 * 页面壳是 Server Component（静态段 `○`，无数据依赖、无鉴权）；交互全在 client
 * `FreeDiagnosePanel`，它只发请求 + 渲染服务端结论，本页**不计算任何东西**。
 */

export const metadata: Metadata = {
  title: "免费诊断 · 新能源重卡场站值不值得做",
  description:
    "不用注册：填车队、里程、服务费与并网容量，平台用同一台决策引擎当场给出结论倾向与明显否证——方向正不正、有没有一眼就该否决的硬问题，先看这个（结果需专业人工确认）。",
  ...seoMetadata({
    title: "免费诊断 · 新能源重卡场站值不值得做",
    description:
      "免登录用生产决策引擎跑一套配置，给结论倾向与明显否证；方向判断，非决策依据。",
    path: "/diagnose",
  }),
};

export default function DiagnosePage() {
  return (
    <Container size="xl" className="flex flex-col gap-6 py-10">
      <PageHeader
        title="免费诊断：这个场站大方向上成不成立？"
        description="免注册、免建项目。填你真正知道的几件事，平台用与付费版同一台决策引擎现算，给你一句结论倾向和必须先解决的硬问题。这是判断的起点，不是决策依据——所有结论仍需专业人工核实。"
      />
      <FreeDiagnosePanel />
    </Container>
  );
}
