import type { Metadata } from "next";
import { Container, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";

/**
 * /privacy — 隐私政策（V1-A 占位，PRODUCT_SPEC §5）。
 *
 * ⚠️ 法务边界（宪法第 21 条：法律领域须标注"需要专业人工确认"）：
 *   正式隐私政策属于法律文件，必须由具备资质的法务/律师根据实际数据处理活动、
 *   适用法域（如《个人信息保护法》PIPL、GDPR 等）起草与审定。
 *   此页当前仅为**结构化占位大纲**，列出正式上线前必须覆盖的条款清单，
 *   不构成任何法律承诺或生效条款。AI 不得自行"生成一份看起来完整的隐私政策"冒充法律文件。
 */

export const metadata: Metadata = {
  title: "隐私政策",
  description: "隐私政策（草稿占位，待法务审定）。",
  robots: { index: false, follow: false },
};

/** 正式隐私政策必须覆盖的条款清单（大纲，非法条）。 */
const SECTIONS = [
  { title: "我们收集哪些信息", desc: "账号信息（邮箱等）、下单与支付相关信息、企业诊断中用户主动提交的资料、访问日志与 request-id。" },
  { title: "我们如何使用信息", desc: "提供案例/方案浏览与购买、订单履约、客户支持、安全与反欺诈、法律合规义务。" },
  { title: "信息的存储与保护", desc: "存储地点（含境外托管数据库说明）、加密与访问控制、保留期限。" },
  { title: "信息的共享与委托处理", desc: "支付服务商、云与数据库托管方、必要的法律披露；是否涉及跨境传输。" },
  { title: "你的权利", desc: "访问、更正、删除、撤回同意、注销账号、导出数据的途径与响应时限。" },
  { title: "Cookie 与同类技术", desc: "是否使用、用途、如何管理。" },
  { title: "未成年人保护", desc: "是否面向未成年人、相关限制。" },
  { title: "政策更新与联系方式", desc: "版本与生效日期、变更通知方式、投诉与联系渠道。" },
] as const;

export default function PrivacyPage() {
  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="隐私政策"
        description="本页为开发阶段的结构化占位，尚未生效。"
        breadcrumb={
          <Breadcrumb items={[{ label: "首页", href: "/" }, { label: "隐私政策" }]} />
        }
      />

      <Alert variant="warning" title="待法务审定 · 尚未生效">
        正式隐私政策属于法律文件，须由具备资质的法务/律师根据实际数据处理活动与适用法域
        （如《个人信息保护法》等）起草审定后方可发布。以下仅为正式上线前必须覆盖的条款大纲，
        <strong>不构成任何法律承诺或生效条款</strong>。
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
              <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
              <p className="text-sm leading-6 text-muted-foreground">{section.desc}</p>
            </div>
          </li>
        ))}
      </ol>
    </Container>
  );
}
