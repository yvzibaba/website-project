# AI产业案例与解决方案引擎（website-project）

> 每天从全球发现高价值产业案例，把成功商业模式、技术路线、开源能力、中国供应链与本土条件进行 AI 重构，形成**可购买、可实施、可进一步定制**的产业解决方案。

这是一个面向**几乎零基础编程的个人创始人**、由 AI 团队工程化实现的产品。核心目标不是"做一个漂亮网站"，而是建立第一代 **AI 产业解决方案自动生产系统**，并从 V1 起保留向未来演化的接口。

## 治理文档（先读，按优先级）

1. [`PROJECT_RULES.md`](./PROJECT_RULES.md) — 文档索引与优先级说明
2. [`docs/PROJECT_RULES_V2.md`](./docs/PROJECT_RULES_V2.md) — **项目宪法 V2.0（最高优先级）**
3. [`docs/MASTER_PROMPT_V1.md`](./docs/MASTER_PROMPT_V1.md) — 全自动开发总控 Prompt V1.0
4. [`AGENTS.md`](./AGENTS.md) — AI Agent 工作约定

## 产品文档

- [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) — 产品定位、用户、页面信息架构、MVP 范围
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 技术选型与系统架构、Model Router
- [`DATABASE.md`](./DATABASE.md) — 数据库 ER 设计（全量目标 + V1 分层）
- [`AI_WORKFLOW.md`](./AI_WORKFLOW.md) — 12 个 Agent 与每日自动生产流水线
- [`SECURITY.md`](./SECURITY.md) — 隐私、密钥、权限、审计
- [`TESTING.md`](./TESTING.md) — 测试策略与质量门禁
- [`ROADMAP.md`](./ROADMAP.md) — Phase 0–18 任务树与 MVP 边界
- [`CHANGELOG.md`](./CHANGELOG.md) — 变更记录（每次修改追加）

## 技术栈（已定）

Next.js 16（App Router）+ React 19 + TypeScript · Tailwind CSS v4（+ 计划引入 shadcn/ui）· Prisma 6 + PostgreSQL（+ 计划 pgvector）· 统一 Model Router（核心模型 Qwen3.8-Max，禁止硬编码模型名）。

## 当前状态

- [x] 仓库与 Next.js 脚手架
- [x] 项目宪法 + 总控 Prompt 版本化入库
- [x] 产业能力数据库 V1 核心 schema（[`prisma/schema.prisma`](./prisma/schema.prisma)，12 实体 + ChangeLog）
- [x] Phase 0–3 基础文档集
- [x] 依赖安装 + `prisma validate` 通过 + 首迁移 `0_init/migration.sql` 离线生成（改用 npmmirror 源 + Prisma 引擎镜像，解除此前的下载卡顿阻塞）
- [x] **Phase 4 里程碑 1：数据库上线**——`DATABASE_URL`（Neon `us-east-2`）写入 `.env`（gitignored），`prisma migrate deploy` 成功建 17 张业务表 + 11 个枚举，`_prisma_migrations` 记录已落库（finished_at `2026-09-04T15:22:16.915Z`）
- [x] **Phase 4 里程碑 2：项目骨架 + 测试基线全绿**——`src/lib/{env,logger,errors,prisma}.ts` 核心库；`src/app/{layout,page,error,not-found}.tsx` + `api/health/route.ts` shell；`tests/unit/*` 44 cases + `tests/integration/db-smoke.test.ts` 5 cases（真连 Neon）全部通过；`tsc --noEmit` 0 错误；`next build` (Turbopack) 成功产出 3 路由；`next start` + HTTP 冒烟：`/api/health` 200 & `db.ok:true`，`/` 200 22129 字节含实时表计数，`/definitely-not-here` 404
- [x] **Phase 4 里程碑 3：设计 tokens + 基础 UI 组件库 + API 客户端层 + Proxy 中间件**——`globals.css` 颜色/圆角/阴影 tokens（亮暗双模式）；`src/components/ui/*` 11 个组件（Button/Card/Badge/Input+Field/Alert/Skeleton+Spinner/Container+Separator）+ `/ui` 演示页；`src/lib/{cn,api-client,validation,request-id}.ts`（统一 fetch + AppError 映射 + 重试、Zod 校验集含 11 个与 prisma 同步的业务枚举、request-id 追踪）；`src/proxy.ts`（Next.js 16 Proxy：request-id 注入下游 + 结构化访问日志 + 安全头）。`tests/unit/*` 扩到 **125 cases** + 集成 5 cases 全绿；`tsc --noEmit` 0 错误；`next build` 产出 **4 路由 + Proxy**；HTTP 冒烟：request-id 服务端生成/客户端透传/非法拒绝重生成全通过，`/ui` 200 全组件渲染
- [x] **Phase 4 完成**——总控 Phase 4 交付清单（Web 骨架 / 数据库连接 / 基础 UI / 环境变量 / 日志 / 错误处理 / 测试框架）全部达成
- [x] **Phase 5 里程碑 1：公共页面地基**——页面级布局组件 `src/components/page/*`（PageHeader/Breadcrumb/EmptyState）；行业数据层 `src/server/industries.ts`（枚举↔slug 映射 + `getIndustryCaseCounts` groupBy 计数 + DB 失败降级）；`/industries` 列表（force-dynamic 实时计数）、`/industries/[slug]` 详情（SSG + `dynamicParams=false` 保证真 404）、`/about` 关于、`/privacy`+`/terms` 结构化占位（明确标注待法务审定，宪法第 21 条）；根 `loading.tsx` Suspense 骨架；导航/页脚更新（移除死链）。`tests/unit` 扩到 **140 cases** + 集成 **7 cases** 全绿；`tsc`/`eslint` 0 错；`next build` 产出 **6 新路由**（含 7 个 SSG 行业页）；HTTP 冒烟 **9/9**（含 `/industries/not-a-real-one` 真 404）
- [ ] Phase 5 里程碑 2/3：DEMO 标注种子数据 + 案例列表/详情 + 方案列表/详情 + 分页；搜索 + 首页组装
- [ ] Phase 6+：用户系统、案例系统、方案系统…（按 ROADMAP 推进）

## 本地运行（待依赖与数据库就绪后）

```bash
npm install                 # 触发 prisma generate
cp .env.example .env.local  # 填入 DATABASE_URL 等，切勿提交真实密钥
npm run db:migrate          # 需要可连接的 PostgreSQL
npm run dev                 # http://localhost:3000
```

## 给创始人的一句话

网站、后台、代码都可以简单；但**产业案例质量、技术匹配质量、中国本土化质量、解决方案质量、证据质量和真实商业价值绝不能简单化**（宪法第28条）。
