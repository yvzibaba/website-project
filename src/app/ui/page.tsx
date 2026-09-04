import type { Metadata } from "next";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Container,
  Field,
  Input,
  Label,
  Separator,
  Skeleton,
  Spinner,
  Textarea,
} from "@/components/ui";

/**
 * /ui — 设计系统演示页（Phase 4 里程碑 3 视觉验证用）。
 *
 * 目的：
 *   1. 一页渲染所有基础 UI 组件，build 后 HTTP 冒烟即可确认组件库无运行时错误；
 *   2. 给创始人/后续开发者一个"看得见"的设计系统参考（零基础交付规则，总控第 41 节）；
 *   3. Phase 5 做公共页面时直接照抄这里的用法。
 *
 * 这是 Server Component（无交互），表单控件仅展示样式，不绑定 onSubmit。
 * robots noindex：演示页不应被搜索引擎收录。
 */

export const metadata: Metadata = {
  title: "UI 组件库",
  description: "产业案例引擎基础 UI 组件演示（Phase 4 里程碑 3）。",
  robots: { index: false, follow: false },
};

export default function UiPage() {
  return (
    <Container size="lg" className="py-10 flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">UI 组件库</h1>
        <p className="text-sm text-muted-foreground">
          Phase 4 里程碑 3 · 基础组件视觉验证 · 所有颜色/圆角/阴影走 globals.css 设计 tokens
        </p>
      </header>

      {/* ── Button ─────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Button 按钮</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">主要操作</Button>
          <Button variant="secondary">次要操作</Button>
          <Button variant="ghost">幽灵按钮</Button>
          <Button variant="danger">危险操作</Button>
          <Button variant="link">链接样式</Button>
          <Button variant="primary" loading>
            提交中
          </Button>
          <Button variant="primary" disabled>
            禁用
          </Button>
          <Button href="/api/health" variant="secondary">
            作为链接
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">小</Button>
          <Button size="md">中</Button>
          <Button size="lg">大</Button>
          <Button size="icon" aria-label="设置">
            ⚙
          </Button>
        </div>
      </section>

      <Separator />

      {/* ── Badge ─────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Badge 徽章</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="neutral">中性</Badge>
          <Badge variant="primary">今日推荐</Badge>
          <Badge variant="success">已验证 · 证据 A</Badge>
          <Badge variant="warning">待人工确认</Badge>
          <Badge variant="danger">许可证冲突</Badge>
          <Badge variant="info">新能源</Badge>
          <Badge variant="outline">元数据</Badge>
          <Badge variant="success" compact>
            紧凑
          </Badge>
        </div>
      </section>

      <Separator />

      {/* ── Alert ─────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Alert 提示条</h2>
        <div className="flex flex-col gap-3">
          <Alert variant="info" title="信息">
            案例评分由程序计算，非模型口算（宪法第 7 条）。
          </Alert>
          <Alert variant="success" title="审核通过">
            方案已通过 QA Agent 检查，可以发布。
          </Alert>
          <Alert variant="warning" title="需要专业人工确认">
            本方案涉及电力/能源高风险领域，落地前须由持证工程师复核（宪法第 21 条）。
          </Alert>
          <Alert variant="danger" title="许可证风险">
            匹配到的开源模块为 AGPL，商用需人工复核许可证。
          </Alert>
        </div>
      </section>

      <Separator />

      {/* ── Card ─────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Card 卡片</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>静态卡片</CardTitle>
              <CardDescription>用于展示案例/方案摘要</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              卡片正文区域，可放评分、证据等级、行业标签等结构化信息。
            </CardContent>
            <CardFooter>
              <Button size="sm" variant="primary">
                查看详情
              </Button>
              <Button size="sm" variant="ghost">
                收藏
              </Button>
            </CardFooter>
          </Card>
          <Card interactive>
            <CardHeader>
              <CardTitle>可交互卡片</CardTitle>
              <CardDescription>悬停有阴影 + 边框高亮</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              整卡可点击的场景（列表页卡片跳转详情）。
            </CardContent>
          </Card>
        </div>
      </section>

      <Separator />

      {/* ── Form ─────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">表单控件</h2>
        <Card>
          <CardContent className="flex flex-col gap-4 pt-5">
            <Field
              label="企业邮箱"
              htmlFor="demo-email"
              required
              help="我们只用于发送方案交付通知"
            >
              <Input id="demo-email" type="email" placeholder="you@company.com" />
            </Field>

            <Field
              label="搜索关键词"
              htmlFor="demo-search"
              error="关键词不能全是控制字符"
            >
              <Input
                id="demo-search"
                aria-describedby="demo-search-error"
                invalid
                placeholder="例如：沼气 甲醇"
              />
            </Field>

            <Field label="企业资源描述" htmlFor="demo-textarea">
              <Textarea
                id="demo-textarea"
                placeholder="描述您的场地、资金、团队、现有设备……"
                rows={4}
              />
            </Field>

            <div className="flex items-center gap-2">
              <Label htmlFor="demo-disabled">禁用输入</Label>
              <Input id="demo-disabled" disabled value="不可编辑" className="max-w-xs" />
            </div>
          </CardContent>
        </Card>
      </section>

      <Separator />

      {/* ── Loading ─────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">加载态</h2>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Spinner />
            <span className="text-sm text-muted-foreground">Spinner（默认 16px）</span>
            <Spinner size={24} label="正在生成方案" />
            <span className="text-sm text-muted-foreground">Spinner（24px）</span>
          </div>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-64" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton variant="text" lines={3} />
              <div className="flex gap-3">
                <Skeleton variant="circle" size={40} />
                <Skeleton variant="circle" size={40} />
                <Skeleton className="h-10 w-32" />
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <Separator />

      {/* ── Container / 设计 tokens ─────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">设计 tokens 色板</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Swatch name="primary" className="bg-primary text-primary-foreground" />
          <Swatch name="success" className="bg-success text-success-foreground" />
          <Swatch name="warning" className="bg-warning text-warning-foreground" />
          <Swatch name="danger" className="bg-danger text-danger-foreground" />
          <Swatch name="info" className="bg-info text-info-foreground" />
          <Swatch name="muted" className="bg-muted text-muted-foreground" />
          <Swatch name="foreground" className="bg-foreground text-background" />
          <Swatch name="border" className="bg-border text-foreground" />
        </div>
      </section>
    </Container>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className={`rounded-md p-3 text-xs font-mono shadow-sm ${className}`}>
      {name}
    </div>
  );
}
