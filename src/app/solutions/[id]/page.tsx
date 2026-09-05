import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container, Badge, Alert, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { PageHeader, Breadcrumb } from "@/components/page";
import { BuyButton } from "@/components/solutions/BuyButton";
import { getPublishedSolutionById } from "@/server/solutions";
import { getCurrentUser } from "@/server/authz";
import { hasPaidEntitlement } from "@/server/orders";
import { describeSandboxLineage } from "@/lib/sandbox-solution-lineage";
import type { ParsedSolutionBody } from "@/server/solution-body";
import { seoMetadata } from "@/lib/site";

/**
 * /solutions/[id] — 方案详情页（V1-A，PRODUCT_SPEC §5，含购买入口）。
 *
 * 展示：方案摘要、定价、机会评分/证据可信度、关键未知变量、财务模型、风险领域，
 * 以及购买入口（V1 购买闭环在 Phase 12 接入，此处为占位）。
 * 高风险领域 / 需专业人工确认的方案，顶部醒目标注（宪法第 10/21 条）。
 *
 * 里程碑 2 不种子方案，故当前任何 id 都会 notFound()（诚实空态）；本页为 Phase 8/12 预铺。
 */

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const sp = await searchParams;
  const includeDemo = first(sp.demo) === "1";
  const res = await getPublishedSolutionById(id, includeDemo);
  if (res.status !== "found") return { title: "方案未找到", robots: { index: false, follow: false } };
  const description = res.data.summary?.slice(0, 120) ?? "产业解决方案详情";
  return {
    title: res.data.title,
    description,
    ...seoMetadata({ title: res.data.title, description, path: `/solutions/${id}`, type: "article" }),
    // DEMO 视图（?demo=1）非真实产出 → 永不收录（宪法第 20 条）。
    ...(includeDemo ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function SolutionDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const includeDemo = first(sp.demo) === "1";

  const res = await getPublishedSolutionById(id, includeDemo);
  if (res.status === "not_found") notFound();
  if (res.status === "error") throw new Error(`方案查询失败：${res.error}`);
  const s = res.data;

  // 解锁门控（Phase 12 M3，V1 假设）：只有「付费(price>0) 且 非 DEMO 展示件」的方案才锁正文；
  // 免费方案与 DEMO 示例正文恒开放。判定在服务端完成（getCurrentUser 只读会话、hasPaidEntitlement 数 PAID 单），
  // 前端拿不到「未解锁的正文」，杜绝绕过（宪法第 7/20 条：程序判定 > 前端臆断；SECURITY：正文是付费交付物）。
  const user = await getCurrentUser();
  const entitled = s.isFree || s.isDemo ? true : await hasPaidEntitlement(s.id, { userId: user?.id, email: user?.email });
  const locked = !entitled;
  const loginHref = `/login?callbackUrl=${encodeURIComponent(`/solutions/${s.id}${includeDemo ? "?demo=1" : ""}`)}`;
  // 沙盘来源识别（R8.3）：只读已落库财务的溯源指纹，不重算——决定是否为买家额外挂一条诚实声明。
  const lineage = describeSandboxLineage(s.financials);

  return (
    <Container size="lg" className="py-10 flex flex-col gap-8">
      <PageHeader
        title={s.title}
        description={s.summary ?? undefined}
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "首页", href: "/" },
              { label: "方案", href: "/solutions" },
              { label: s.title.slice(0, 24) + "…" },
            ]}
          />
        }
      >
        <div className="flex flex-wrap gap-2">
          <Link href={`/industries/${s.industrySlug}`}>
            <Badge variant="outline">{s.industryName}</Badge>
          </Link>
          {lineage ? <Badge variant="info">沙盘推演生成</Badge> : null}
          {s.isDemo ? <Badge variant="warning">DEMO 数据</Badge> : null}
        </div>
      </PageHeader>

      {s.needsProfessionalReview ? (
        <Alert variant="danger" title="需要专业人工确认">
          本方案涉及高风险领域
          {s.riskDomains.length > 0 ? `（${s.riskDomains.join("、")}）` : ""}
          ，依据宪法第 10/21 条，投资、法律、工程安全、环保、能源、医疗、政策等决策
          <strong>必须由具备资质的专业人士复核</strong>后再执行，切勿仅凭本页内容决策。
        </Alert>
      ) : s.riskDomains.length > 0 ? (
        <Alert variant="warning" title="风险提示">
          涉及领域：{s.riskDomains.join("、")}。请结合关键未知变量谨慎评估。
        </Alert>
      ) : null}

      {s.isDemo ? (
        <Alert variant="warning" title="这是 DEMO 示例数据">
          本方案关联的案例为 DEMO 示例，<strong>不是可购买的真实方案</strong>。
        </Alert>
      ) : null}

      {lineage ? (
        <Alert variant="info" title="本方案由产业决策沙盘推演生成">
          下方所有关键数字（CAPEX/OPEX/NPV/IRR/回收期/ROI 等）均由确定性沙盘模型
          {lineage.engineCalcRef ? <code className="mx-1 font-mono text-xs">{lineage.engineCalcRef}</code> : null}
          （方案生成口径 <code className="mx-1 font-mono text-xs">{lineage.solutionCalcRef}</code>
          {lineage.regionName ? <>，地区「{lineage.regionName}」</> : null}
          {lineage.profileName ? <>，画像「{lineage.profileName}」</> : null}）计算并原样搬运，非二次换算。
          其入参目前仍为<strong>示例占位假设（{lineage.evidenceKind ?? "ASSUMPTION"}）</strong>，
          须以来源可追溯的真实电价、光照、补贴、造价、负荷等数据替换并经专业人员复核后方可作投资依据
          （宪法第 16/20/21 条）。
          {lineage.npvNonPositive ? (
            <span className="mt-1 block text-danger">
              注意：按当前参数 NPV 为非正，商业决策前须重点复核。
            </span>
          ) : null}
        </Alert>
      ) : null}

      {/* 购买区 */}
      <Card>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">单份方案一次性购买</span>
            <span className="text-3xl font-semibold tabular-nums text-foreground">{s.priceDisplay ?? "定价待定"}</span>
            <span className="text-xs text-muted-foreground">
              机会评分 {s.opportunityScore ?? "—"}/100 · 证据可信度 {s.evidenceConfidence ?? "—"}/100 · 关键未知变量 {s.unknowns.length} 项
            </span>
          </div>
          <PurchaseAction
            isFree={s.isFree}
            isDemo={s.isDemo}
            locked={locked}
            loggedIn={Boolean(user)}
            loginHref={loginHref}
            solutionId={s.id}
            solutionTitle={s.title}
          />
        </CardContent>
      </Card>

      {/* 关联案例 */}
      <section className="text-sm">
        <span className="text-muted-foreground">源自案例：</span>
        <Link href={`/cases/${s.caseId}${includeDemo ? "?demo=1" : ""}`} className="text-primary underline">
          {s.caseTitle}
        </Link>
      </section>

      {/* 财务模型 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">财务模型</h2>
        {s.financials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无结构化财务模型。关键数字须来源可追溯、公式可复算、假设可改（宪法第 7 条），将在方案生成阶段补齐。
          </p>
        ) : (
          s.financials.map((f) => (
            <Card key={f.id}>
              <CardHeader>
                <CardTitle className="text-base">财务测算（{f.currency}）</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Fin label="CAPEX" value={f.capex} />
                  <Fin label="年 OPEX" value={f.opexAnnual} />
                  <Fin label="年收入" value={f.revenueAnnual} />
                  <Fin label="ROI" value={f.roiPct} suffix="%" />
                  <Fin label="IRR" value={f.irrPct} suffix="%" />
                  <Fin label="回收期" value={f.paybackYears} suffix=" 年" />
                </div>
                {f.calcRef ? (
                  <p className="text-xs text-muted-foreground">
                    计算引用：<code className="font-mono">{f.calcRef}</code>（程序计算 &gt; 口算）
                  </p>
                ) : null}
                {f.sourceUrl ? (
                  <p className="text-xs text-muted-foreground">
                    来源：<a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{f.sourceUrl}</a>
                  </p>
                ) : null}
                {f.note ? <p className="text-xs text-muted-foreground">{f.note}</p> : null}
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {/* 关键未知变量 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">关键未知变量</h2>
        <p className="text-xs text-muted-foreground">
          依据宪法第 9 条，禁止用高评分掩盖高不确定性；以下变量会显著影响结论，需优先验证。
        </p>
        {s.unknowns.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无登记的关键未知变量。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {s.unknowns.map((u) => (
              <li key={u.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{u.name}</span>
                  {typeof u.severity === "number" ? <Badge variant="warning" compact>严重度 {u.severity}</Badge> : null}
                </div>
                {u.impact ? <p className="mt-1 text-xs text-muted-foreground">影响：{u.impact}</p> : null}
                {u.howToResolve ? <p className="mt-1 text-xs text-muted-foreground">验证方式：{u.howToResolve}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 方案正文（34 分节，总控 §3 Solution Package；规则 12 结构化保存）。
          付费未解锁时 locked=true：正文由服务端拒渲染（前端拿不到未解锁内容），仅显示解锁引导。 */}
      <SolutionBodySection body={s.body} locked={locked} loginHref={loginHref} loggedIn={Boolean(user)} solutionId={s.id} solutionTitle={s.title} />
    </Container>
  );
}

/** 把一节内容渲染成可读块：字符串成段、数组列点、对象转键值、标量直显。 */
function renderSectionContent(content: unknown) {
  if (typeof content === "string") {
    return (
      <div className="whitespace-pre-wrap text-sm text-foreground">{content}</div>
    );
  }
  if (typeof content === "number" || typeof content === "boolean") {
    return <div className="text-sm tabular-nums text-foreground">{String(content)}</div>;
  }
  if (Array.isArray(content)) {
    return (
      <ul className="flex flex-col gap-1 text-sm text-foreground">
        {content.map((item, i) => (
          <li key={i} className="list-disc pl-4 marker:text-muted-foreground">
            {typeof item === "string" || typeof item === "number" || typeof item === "boolean"
              ? String(item)
              : renderSectionContent(item)}
          </li>
        ))}
      </ul>
    );
  }
  if (content && typeof content === "object") {
    const entries = Object.entries(content as Record<string, unknown>);
    return (
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="text-foreground">
              {v && typeof v === "object" ? renderSectionContent(v) : String(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}

function SolutionBodySection({
  body,
  locked,
  loginHref,
  loggedIn,
  solutionId,
  solutionTitle,
}: {
  body: ParsedSolutionBody;
  locked: boolean;
  loginHref: string;
  loggedIn: boolean;
  solutionId: string;
  solutionTitle: string;
}) {
  // 付费未解锁：正文是付费交付物，服务端根本不渲染任何分节内容（前端无从绕过，宪法第 7/20 条）。
  if (locked) {
    return (
      <section id="solution-body" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">方案正文</h2>
        <div className="rounded-lg border border-dashed border-border p-6">
          <div className="flex flex-col items-start gap-3">
            <Badge variant="warning" compact>
              正文未解锁
            </Badge>
            <p className="text-sm text-muted-foreground">
              这是付费方案，完整 34 分节正文（研究→Bull→Bear→Judge→QA 产出、人工审核）在订单确认到账后解锁。
              购买流程：下单 → 按支付说明完成站外付款 → 管理员确认 → 本页自动展示完整正文。
            </p>
            <LockedCta loginHref={loginHref} loggedIn={loggedIn} solutionId={solutionId} solutionTitle={solutionTitle} />
          </div>
        </div>
      </section>
    );
  }

  // 空 body：诚实占位，不渲染半截分节（与 Phase 7 M3 scoreBreakdown=null 同构）。
  if (body.empty) {
    return (
      <section id="solution-body" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">方案正文</h2>
        <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          本方案尚未填充 34 分节结构化正文（<code className="font-mono">Solution.body</code>，总控 §3
          「Solution Package」）。正文须由多角色流水线（研究→Bull→Bear→Judge→QA）产出、人工审核后写入，
          禁止单模型直出充数（宪法第 20 条）。
        </p>
      </section>
    );
  }

  const pct = Math.round((body.filledCount / body.totalCount) * 100);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">方案正文</h2>
        <Badge variant={body.filledCount === body.totalCount ? "success" : "outline"} compact>
          分节完成度 {body.filledCount}/{body.totalCount}（{pct}%）
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        按总控 §3「Solution Package」34 分节结构化呈现；标注「待补充」的分节表示流水线尚未产出，
        不代表方案已完整可售（宪法第 9/20 条）。
      </p>
      <div className="flex flex-col gap-3">
        {body.sections.map((sec) => (
          <Card key={sec.key}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <span>{sec.title}</span>
                {!sec.filled ? <Badge variant="outline" compact>待补充</Badge> : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sec.filled ? (
                renderSectionContent(sec.content)
              ) : (
                <p className="text-sm text-muted-foreground">该分节尚未填充。</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {body.extras.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          另有 {body.extras.length} 个未归入 34 分节的字段（{body.extras.map((e) => e.key).join("、")}），
          已在正文契约外保留以便审计（不静默丢弃）。
        </p>
      ) : null}
    </section>
  );
}

/** 购买卡右侧动作：按「免费/DEMO · 已解锁 · 待购买(登录) · 待登录(游客)」四态渲染。 */
function PurchaseAction({
  isFree,
  isDemo,
  locked,
  loggedIn,
  loginHref,
  solutionId,
  solutionTitle,
}: {
  isFree: boolean;
  isDemo: boolean;
  locked: boolean;
  loggedIn: boolean;
  loginHref: string;
  solutionId: string;
  solutionTitle: string;
}) {
  if (isFree || isDemo) {
    return (
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <Badge variant="success" compact>
          正文开放 · 无需购买
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          {isDemo ? "DEMO 示例数据，仅供演示，非可售真实方案。" : "免费方案，完整正文即时开放。"}
        </span>
      </div>
    );
  }
  if (!locked) {
    // 已拥有：给出直达正文锚点的解锁态，不再重复售卖。
    return (
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <Badge variant="success" compact>
          已解锁
        </Badge>
        <a href="#solution-body" className="text-sm font-medium text-primary hover:underline">
          查看完整正文 →
        </a>
      </div>
    );
  }
  if (loggedIn) {
    return <BuyButton solutionId={solutionId} solutionTitle={solutionTitle} />;
  }
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button variant="primary" size="lg" href={loginHref}>
        登录后可购买
      </Button>
      <span className="text-[11px] text-muted-foreground">下单 → 支付说明 → 后台确认 → 解锁，需先登录。</span>
    </div>
  );
}

/** 正文锁面板里的行动号召：登录→BuyButton；游客→登录引导。 */
function LockedCta({
  loggedIn,
  loginHref,
  solutionId,
  solutionTitle,
}: {
  loggedIn: boolean;
  loginHref: string;
  solutionId: string;
  solutionTitle: string;
}) {
  if (loggedIn) {
    return <BuyButton solutionId={solutionId} solutionTitle={solutionTitle} />;
  }
  return (
    <Button variant="primary" href={loginHref}>
      登录后购买并解锁正文
    </Button>
  );
}

function Fin({ label, value, suffix }: { label: string; value: string | null; suffix?: string }) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-foreground">{value ? `${value}${suffix ?? ""}` : "—"}</div>
    </div>
  );
}
