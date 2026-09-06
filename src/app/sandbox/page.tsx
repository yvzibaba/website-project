import type { Metadata } from "next";
import { Container } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { SandboxShell } from "@/components/sandbox";
import { seoMetadata } from "@/lib/site";

/**
 * /sandbox — 「新能源重卡 + 光伏 + 储能 + 充电」产业项目可视化决策沙盘（中途重构 R4）。
 *
 * 这是《项目中途重构总控》把 V1 唯一焦点落成的人可交互页面：左侧改参数、右侧技术 / 经济 /
 * 图表 / 敏感性即时重算联动（§4 命脉）。页面壳为 Server Component，重活全在 client
 * `SandboxShell`（纯前端即时重算，无网络往返）。
 *
 * R8.8a：`SandboxShell` 提供双档——默认「示范项目模型」（~10 核心参数简化入口）与
 * 「完整参数工作台」（40 参数全量，R1–R7 主链）。两档复用同一引擎链，零新路由（本页仍单一 `○` 静态段）、
 * 零 schema 迁移；示范档「项目总投资」只作计算结果展示，贷款/债务口径推迟 R8.8b。
 *
 * 诚实边界：本页参数默认全是占位假设（示例·待核实）、经济口径为透明简化、结果恒需专业人工确认，
 * 不得作投资 / 并网决策依据。项目持久化 / 地区参数 / 动态报告已接入本页（R3/R5/R6/R8.6/R8.7）。
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
      <SandboxShell />
    </Container>
  );
}
