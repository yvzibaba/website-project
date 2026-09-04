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
- [ ] Phase 4+ 编码（**仅剩数据库阻塞**：本机无 Postgres/Docker，`prisma migrate deploy` 与连库测试需托管库 `DATABASE_URL`；详见 [`ROADMAP.md`](./ROADMAP.md) 的"阻塞与所需资源"）

## 本地运行（待依赖与数据库就绪后）

```bash
npm install                 # 触发 prisma generate
cp .env.example .env.local  # 填入 DATABASE_URL 等，切勿提交真实密钥
npm run db:migrate          # 需要可连接的 PostgreSQL
npm run dev                 # http://localhost:3000
```

## 给创始人的一句话

网站、后台、代码都可以简单；但**产业案例质量、技术匹配质量、中国本土化质量、解决方案质量、证据质量和真实商业价值绝不能简单化**（宪法第28条）。
