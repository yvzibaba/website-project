import Link from "next/link";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";

/**
 * 「免费 → 专业」转化与最后一公里说明面板（V1.1 P4-brief · 商业闭环）。
 *
 * 目的：让访客在看清价值后，明确 **下一步做什么、怎么联系、为什么要付费**，
 * 且**只列真实存在（或明确标注为人工/规划中）的能力——绝不放会点但没反应的假按钮**。
 *
 * 边界（诚实 + 不越权）：
 *   - 本面板不做在线支付、不展示具体价格——**定价 / 收款 / 合同法务终稿留创始人拍板**（宪法高风险边界）；
 *   - 「完整 / 专业」能力里，凡系统尚未自动化的（多方案情景对比、融资 DSCR / 股权 IRR），一律显式标注
 *     「规划中 · 当前走人工」，而非伪装成一键功能；
 *   - 「1 个工作日内联系」是**流程承诺**、非系统 SLA（与留资表单同一口径）。
 *
 * 纯展示：不查库、不依赖会话；`level` 只决定把「你现在所在档」高亮出来。可在服务端页与客户端沙盘内共用。
 */

type Level = "basic" | "full";

const FREE_ITEMS = [
  "全参数即时重算的决策沙盘（车队 / 桩 / 光储 / 电价 / 政策滑块）",
  "净现值 NPV、内部收益率 IRR、动态回收期、ROI、盈亏平衡充电单价",
  "风险敏感性最值排行（先核实哪个变量）",
  "关键假设与适用边界、风险提示与尽调复核清单",
  "逐条常驻免责 + 可复算声明（每个数字都能回溯到引擎）",
];

const PRO_ITEMS: Array<{ t: string; note?: "人工" | "规划中" }> = [
  { t: "企业专属视角：按你的画像（车队 / 运营商 / 园区 / 投资人）重排结论优先级" },
  { t: "逐内核版本审计明细 + 可一键导出、存档为方案的完整报告（登录）" },
  { t: "多方案情景并排对比（不同选址 / 配置比选）", note: "规划中" },
  { t: "融资口径测算：贷款现金流、DSCR 偿债覆盖、股权 IRR", note: "规划中" },
  { t: "产业可研级人工尽调、定价与合同（具备产业 / 财务 / 电力背景的顾问）", note: "人工" },
];

const NOTE_LABEL: Record<"人工" | "规划中", string> = {
  人工: "当前走人工",
  规划中: "规划中 · 当前走人工",
};

function CheckMark() {
  return (
    <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden>
      <path
        fill="currentColor"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7 7a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4l2.3 2.29 6.3-6.3a1 1 0 0 1 1.4 0Z"
      />
    </svg>
  );
}

export function SandboxUpgradePanel({
  level,
  contactAnchorHint = "下方「留个联系方式」",
}: {
  level: Level;
  /** 提示用户「人工对接」入口在哪（沙盘页=下方留资表单；首页=企业页/留资）。 */
  contactAnchorHint?: string;
}) {
  const onFree = level === "basic";
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">免费体验 与 专业完整交付</CardTitle>
            <CardDescription>
              免费即可算清并拿到带口径、假设与免责的完整可读报告；需要对企业专属视角、可存档交付物与人工尽调时再升级。
            </CardDescription>
          </div>
          <Badge variant={onFree ? "neutral" : "primary"} compact>
            {onFree ? "你正在看：基础报告（免费）" : "你正在看：完整报告（企业视角）"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* 免费档 */}
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">基础 · 免费</span>
              <Badge variant="success" compact>即时可用 · 无需注册</Badge>
            </div>
            <ul className="flex flex-col gap-1.5">
              {FREE_ITEMS.map((x) => (
                <li key={x} className="flex gap-2 text-[13px] leading-6 text-foreground/90">
                  <CheckMark />
                  <span>{x}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* 专业档 */}
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-900/15 bg-zinc-900/[0.03] p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">专业完整 · 企业 / 人工尽调</span>
              <Badge variant="primary" compact>人工对接交付</Badge>
            </div>
            <ul className="flex flex-col gap-1.5">
              {PRO_ITEMS.map((x) => (
                <li key={x.t} className="flex gap-2 text-[13px] leading-6 text-foreground/90">
                  <CheckMark />
                  <span>
                    {x.t}
                    {x.note ? (
                      <em className="ml-1 not-italic text-[11px] text-muted-foreground">（{NOTE_LABEL[x.note]}）</em>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* 最后一公里：下一步 / 怎么联系 / 为什么付费 */}
        <div className="rounded-xl border border-dashed border-border p-4">
          <p className="text-sm font-semibold text-foreground">下一步怎么走</p>
          <ol className="mt-2 flex flex-col gap-1.5 text-[13px] leading-6 text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">① 先免费算清：</span>
              拖动参数即时看投资与回报，拿一份带口径与免责的基础报告——不花一分钱、不用注册。
            </li>
            <li>
              <span className="font-medium text-foreground">② 想要企业专属视角：</span>
              <Link href="/enterprise" className="mx-1 text-primary underline-offset-2 hover:underline">
                选一个企业画像
              </Link>
              （车队 / 运营商 / 园区 / 投资人），报告即按你的关注点重排、并展开完整审计明细。
            </li>
            <li>
              <span className="font-medium text-foreground">③ 要可存档交付物 / 定价与人工尽调：</span>
              登录后「导出为方案」可存档自己的沙盘结论；正式可研、报价与合同由{contactAnchorHint}入口转人工，
              我们通常 1 个工作日内联系（流程承诺，非系统级 SLA）。
            </li>
          </ol>
          <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
            关于付费：付费买的是「把屏幕上的推演，变成可对外签字的企业专属视角报告 + 可存档交付物 + 具备产业 / 财务 /
            电力背景的顾问人工尽调」，而非又一个计算器。在线收款与具体价格由人工确认——本页不虚构在线支付、不展示未经核实的报价。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button href="/enterprise" variant="primary" size="sm">
            选企业画像 · 看完整报告 →
          </Button>
          <Button href="/sandbox" variant="secondary" size="sm">
            回沙盘继续算
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
