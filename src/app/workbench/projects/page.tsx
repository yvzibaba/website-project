import type { Metadata } from "next";
import { Container } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { DecisionProjectsPanel } from "@/components/decision";
import { seoMetadata } from "@/lib/site";

/**
 * /workbench/projects — V2 决策平台的项目列表。
 *
 * 与 `/workbench`（V1 简化年度模型沙盘）并列而非替换：两套引擎的输入契约与结果口径不同，
 * 放在同一个页面里会让"这个数到底是哪台机器算的"变得无法回答。V2 独立成段，
 * 页面上所有数字都只来自 `kernel/src/engine/` 这一台生产计算引擎。
 */

export const metadata: Metadata = {
  title: "项目决策平台",
  description:
    "新能源重卡能源项目的决策平台：按情景计算用能需求、充换电方案、光伏储能配置与项目经济性，给出可行性判定与可留档的决策报告。",
  ...seoMetadata({
    title: "项目决策平台",
    description: "按情景计算用能需求、充换电方案与经济性，输出可复算、可留档的决策报告。",
    path: "/workbench/projects",
  }),
};

export default function DecisionProjectsPage() {
  return (
    <Container size="xl" className="flex flex-col gap-6 py-10">
      <PageHeader
        title="项目决策平台"
        description="新建一个场站项目，按情景算清「要多少电、怎么补、要花多少钱、值不值得做」，并把结论留档成可复算的报告。"
      />
      <DecisionProjectsPanel />
    </Container>
  );
}
