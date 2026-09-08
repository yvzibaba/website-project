import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Container, Card, CardContent, Badge, Alert } from "@/components/ui";
import { PageHeader, Breadcrumb, EmptyState } from "@/components/page";
import { getCurrentUser } from "@/server/authz";
import { listSandboxProjects, type SandboxProjectListItem } from "@/server/sandbox-projects";
import { ProjectCopyButton } from "@/components/account/ProjectCopyButton";

/**
 * /account/projects — 我的项目（Phase 4 模块 B，创始人总指令 §四「用户项目」）。
 *
 * 受保护：无会话 → redirect /login（携 callbackUrl 回本页）。数据只取**当前会话用户自己**的
 * 沙盘项目（listSandboxProjects 以会话 user.id 为 owner 过滤，绝无他人项目）。
 * 每张卡给到：名称、地区、落库状态、模型版本、基线情景 NPV/IRR/回收期/ROI 摘要（服务端引擎现算列，
 * 非页面数字）与更新时间；操作：「在沙盘打开」（/sandbox?project=id，按参数快照还原）与「复制」
 * （服务端现算重跑落新项目）。历史版本与回滚仍在沙盘保存面板内（不被本页静默覆盖）。
 * force-dynamic（依赖会话 + 实时数据）+ noindex。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的项目",
  robots: { index: false, follow: false },
};

function fmtMoneyWan(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 万`;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtYears(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)} 年`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

function ProjectCard({ p }: { p: SandboxProjectListItem }) {
  const b = p.baseline;
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">{p.name}</h2>
          <Badge variant={b?.calcStatus === "ok" ? "success" : "neutral"} compact>
            {b?.calcStatus === "ok" ? "已算入库" : (b?.calcStatus ?? "未算")}
          </Badge>
          {p.status !== "DRAFT" ? <Badge variant="outline" compact>{p.status}</Badge> : null}
          <span className="ml-auto text-[11px] text-muted-foreground">
            更新于 {fmtDate(p.updatedAt)}
          </span>
        </div>

        {p.description ? (
          <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{p.description}</p>
        ) : null}

        {b ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="NPV" value={fmtMoneyWan(b.npv)} />
            <Metric label="IRR" value={fmtPct(b.irrPct)} />
            <Metric label="回收期" value={fmtYears(b.paybackYears)} />
            <Metric label="ROI" value={fmtPct(b.roiRatio)} />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>地区：{p.regionName ?? "未记录地区包"}</span>
          <span>基线情景 v{b?.version ?? "—"}</span>
          {b?.calcRef ? (
            <span className="font-mono">
              模型 <code>{b.calcRef}</code>
            </span>
          ) : null}
          <span>创建 {fmtDate(p.createdAt)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/sandbox?project=${encodeURIComponent(p.id)}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            在沙盘打开 →
          </Link>
          <ProjectCopyButton projectId={p.id} />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

export default async function AccountProjectsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?callbackUrl=%2Faccount%2Fprojects");

  const res = await listSandboxProjects({ user });
  const projects = res.status === "ok" ? res.projects : [];

  return (
    <Container size="md" className="py-10 flex flex-col gap-6">
      <PageHeader
        title="我的项目"
        description="你在决策沙盘中保存的项目：参数快照、模型版本与结果一并留存，可随时重开、复制或继续重算。"
        breadcrumb={
          <Breadcrumb
            items={[{ label: "首页", href: "/" }, { label: "我的账号", href: "/account" }, { label: "我的项目" }]}
          />
        }
      />

      <div className="text-sm">
        <Link href="/account" className="text-muted-foreground hover:underline">
          ← 返回我的账号
        </Link>
      </div>

      {res.status !== "ok" ? (
        <Alert variant="warning" title="项目列表暂不可用">
          {res.status === "invalid" ? "入参校验未通过" : (res.error ?? "查询失败")}
          （数据库可能正在冷启动），请稍后刷新重试。
        </Alert>
      ) : projects.length === 0 ? (
        <>
          <EmptyState
            title="还没有保存任何沙盘项目"
            description="进入决策沙盘：选地区、改参数、看结果，然后把当前情景「保存为项目」——参数快照、模型版本与结果会一并留存到这里。"
          />
          <div className="flex justify-center">
            <a
              href="/sandbox"
              className="rounded-full border border-border px-5 py-2 text-sm font-medium transition-colors hover:border-ring"
            >
              去体验决策沙盘 →
            </a>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
          <p className="text-[11px] leading-5 text-muted-foreground">
            诚实说明：卡片中的 NPV / IRR / 回收期 / ROI 为保存时服务端引擎**现算落库**的基线情景摘要，
            重开项目以参数快照重算为准；内核升级时旧结果会自动冻结为历史版本，绝不被静默覆盖。
            全部数字继承「占位假设 + 需专业人工确认」边界。
          </p>
        </div>
      )}
    </Container>
  );
}
