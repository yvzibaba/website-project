import type { Metadata } from "next";
import { Container } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { SandboxWorkbench } from "@/components/sandbox";
import { seoMetadata } from "@/lib/site";

/**
 * /sandbox — 「新能源重卡 + 光伏 + 储能 + 充电」产业项目可视化决策沙盘（中途重构 R4）。
 *
 * 这是《项目中途重构总控》把 V1 唯一焦点落成的人可交互页面：左侧改参数、右侧技术 / 经济 /
 * 图表 / 敏感性即时重算联动（§4 命脉）。页面壳为 Server Component，重活全在 client
 * `SandboxWorkbench`（纯前端即时重算，无网络往返）。
 *
 * 诚实边界：本页参数默认全是占位假设、经济口径为透明简化、结果需专业人工确认；
 * R3 项目持久化 / R5 地区参数种子 / R6 动态报告 + AI 解释尚未接到本页，§17 E2E 主链未通。
 */

export const metadata: Metadata = {
  title: "产业项目决策沙盘",
  description:
    "新能源重卡 + 光伏 + 储能 + 充电一体化项目的可视化决策沙盘：改参数即重算技术结果、经济评价（NPV/IRR/回收期/ROI）、能量平衡与敏感性，图表与模型实时联动。",
  ...seoMetadata({
    title: "产业项目决策沙盘",
    description:
      "改参数即重算技术、经济、风险与敏感性的一体化产业项目可视化决策沙盘（结果需专业人工确认）。",
    path: "/sandbox",
  }),
};

export default function SandboxPage() {
  return (
    <Container size="xl" className="flex flex-col gap-6 py-10">
      <PageHeader
        title="产业项目可视化决策沙盘"
        description="V1 试点：新能源重卡 + 光伏 + 储能 + 充电一体化场站。选参数 → 跑模型 → 看技术 / 经济 / 风险 / 敏感性联动。"
      />
      <SandboxWorkbench />
    </Container>
  );
}
