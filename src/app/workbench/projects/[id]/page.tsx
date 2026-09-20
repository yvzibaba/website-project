import type { Metadata } from "next";
import { Container } from "@/components/ui";
import { PageHeader } from "@/components/page";
import { DecisionProjectPanel } from "@/components/decision";

/**
 * /workbench/projects/[id] — V2 决策项目详情（九段式）。
 *
 * 页面壳是 Server Component，只负责取路由参数；所有取值、计算与渲染都在客户端面板里，
 * 而面板**只通过唯一的生产计算入口**拿数（见 DecisionProjectPanel 头注）。
 * 动态段故不生成静态参数。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "项目决策详情",
  description: "用能需求、充换电方案、能源配置、能量平衡、项目经济性、场景比较、决策结果与可留档报告。",
};

interface Params {
  params: Promise<{ id: string }>;
}

export default async function DecisionProjectPage({ params }: Params) {
  const { id } = await params;
  return (
    <Container size="xl" className="flex flex-col gap-6 py-10">
      <PageHeader
        title="项目决策详情"
        description="九个部分逐段回答：要多少电、怎么补、配什么、平不平、赚不赚、比哪个好、建议做什么，以及一份可复算的留档报告。"
      />
      <DecisionProjectPanel projectId={id} />
    </Container>
  );
}
