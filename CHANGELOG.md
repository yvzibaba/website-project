# CHANGELOG

记录规则（宪法第13条）：每次修改追加**版本号 + 时间 + 原因 + 内容 + 效果**；不得直接覆盖生产版本；必要时可回滚（Git revert 对应提交）。
时间时区：Asia/Shanghai。

## [0.4.1] - 2026-09-04 · Phase 4 里程碑 2：项目骨架 + 测试基线全绿

- 原因：DB 上线后立刻铺 V1-A 骨架，把 Next.js 16 约定、Prisma Client 单例、结构化日志、错误层级、env 校验、健康检查 API、Vitest 测试基线一次性打通（宪法第 4 条：先跑通再优化；总控 Phase 4 交付清单）。
- 内容：
  - **依赖**：新增 `zod ^4.5.4`（env 校验）；devDeps 新增 `vitest ^5.0.0`、`tsx ^4.23.13`；`@types/node` 升 `^20` → `^22.20.1`（vitest 5 peer 要求，运行时 Node v24.17 更贴合）。npm scripts 新增 `test` / `test:watch` / `test:unit` / `test:integration` / `typecheck`；`package.json` version 从 0.1.0 → 0.4.0。
  - **核心库** `src/lib/`：
    - `env.ts` — Zod 校验 `DATABASE_URL` / `NODE_ENV` / `LOG_LEVEL` / `NEXT_PUBLIC_SITE_URL`，惰性求值 + 单例缓存，失败时列出所有出错字段并给出 `.env.example` 提示。
    - `logger.ts` — 薄壳结构化 JSON 日志（不引 pino，减依赖面）；内置 21 个敏感字段脱敏（password / token / DATABASE_URL / api_key / cookie / credit_card 等），支持深层嵌套 + 数组 + Error cause + 循环引用 + BigInt / Date / Function 序列化；child(bindings) 派生子 logger；level 阈值 + silent 全静音；error/fatal 走 stderr。
    - `errors.ts` — `AppError` 基类 + 8 个子类（Validation / Unauthorized / Forbidden / NotFound / Conflict / RateLimited / DB / Upstream），code→HTTP 状态映射表；`isAppError` 跨 realm 安全判定；`toErrorResponse` 统一 API 错误出口，自动识别 Prisma P2002 / P2025 / P#### 码，生产环境屏蔽原始 message 防泄漏。
    - `prisma.ts` — Prisma Client 单例（globalThis 挂载避免 Next.js HMR 连接泄漏），按环境分级日志（dev: query+warn+error, test/prod: error only）。
  - **Next.js shell** `src/app/`：
    - `layout.tsx` — 更新 metadata（title template / description / metadataBase / robots noindex 开发期），添加中文导航（案例/方案/关于/health）+ 页脚。**去除 `next/font/google` Geist 依赖**（本机构建时 fonts.googleapis.com 不可达，build 会 fail），改为纯 CSS 系统字体栈。
    - `globals.css` — 定义 `--font-sans`（含 PingFang SC / Microsoft YaHei / Noto Sans SC 中英混排回落）+ `--font-mono`；Tailwind v4 `@theme inline` 接入。
    - `page.tsx` — 首页 Server Component，`force-dynamic`，查 `pg_stat_user_tables` 实时渲染 17 张业务表的行数卡片，DB 失败时显示红色错误面板。
    - `error.tsx` — 全局错误边界（Client Component），显示 message + digest + 重试按钮 + 回首页链接。
    - `not-found.tsx` — 404 页。
    - `api/health/route.ts` — GET `/api/health`，`force-dynamic`，跑 `SELECT 1` 测 DB 往返延迟，返回 `{ ok, service, version, node, uptime_sec, db: {ok, latency_ms}, timestamp }`；错误时经 `toErrorResponse` 统一响应。
  - **测试基线** `tests/`：
    - `vitest.config.ts` — node env、`@/*` 别名、30s 超时（跨太平洋连 Neon us-east-2）、forks pool（避免 Prisma Engine 在 worker_threads 里偶发段错误）。
    - `tests/unit/errors.test.ts` — 19 cases：状态码映射 / httpStatus 覆盖 / 未知 code 兜底 / toJSON 稳定性 / details 可选 / cause 保留 / isAppError 4 分支 / toErrorResponse Prisma P2002 P2025 P#### / prod 屏蔽 message / 非 Error 值处理。
    - `tests/unit/logger.test.ts` — 15 cases：JSON 单行输出 / level 阈值 / silent / stdout-stderr 分流 / 顶层脱敏 / 深层嵌套脱敏 / DATABASE_URL 脱敏 / Error 序列化 / 循环引用 / child 派生 / withLevel / __redact 边界（Date / BigInt / Function / 原始值）。
    - `tests/unit/env.test.ts` — 10 cases：postgresql:// / postgres:// / NODE_ENV / LOG_LEVEL / NEXT_PUBLIC_SITE_URL / 缓存单例 / DATABASE_URL 缺失 / 非 postgres 协议 / NODE_ENV 非法 / LOG_LEVEL 非法 / 多字段错误汇总 + Hint 提示。使用 `vi.stubEnv`（@types/node v22 把 NODE_ENV 声明为只读，直接赋值 TS 报错）。
    - `tests/integration/db-smoke.test.ts` — 5 cases，真连 Neon：SELECT 1 / Region 全 CRUD / 11 枚举存在性 / 17 表存在性 / `_prisma_migrations` 记录 `0_init` 已应用未回滚。afterAll 双兜底清理（by id + by name prefix）。DATABASE_URL 缺失时自动 skip 而非 fail。
  - **Next.js 16 类型**：跑 `next typegen` 生成 `.next/types/{routes,cache-life,root-params,validator}.d.ts`，让全局 `LayoutProps<'/'>` 助手在 tsc 中可见（.next/ 已被 gitignore）。
- 验证（宪法第 5/18/20 条：可验证 + 每 Phase 必测 + 诚实汇报）：
  - `tsc --noEmit`：0 错误。
  - `vitest run tests/unit`：**44/44 全绿**，416ms。
  - `node --env-file=.env vitest run tests/integration`：**5/5 全绿**，8.24s（真连 Neon us-east-2）。
  - `next build`（Turbopack）：**编译成功**，671ms 编译 + 3.3s TS + 790ms 静态生成；产出 3 条路由：`ƒ /`（动态 Server Component）/ `○ /_not-found`（静态）/ `ƒ /api/health`（动态）。
  - **HTTP 端到端冒烟**（`next start -p 3111` + node http.get）：
    - `GET /api/health` → **200**，body `{"ok":true,"service":"website-project","version":"0.4.0","node":"v24.17.0","uptime_sec":4,"db":{"ok":true,"latency_ms":3660},"timestamp":"2026-09-04T15:36:39.858Z"}`（首查 3.6s 含 Neon 冷启动唤醒，热起来 ~200ms）。
    - `GET /` → **200**，22129 字节 HTML，包含"数据库实时状态"、"Phase 4"、"Region" 卡片。
    - `GET /definitely-not-here` → **404**，包含"404"、"页面不存在"。
- 效果：**Phase 4 里程碑 2 达成**——项目骨架完整可运行可测试。ROADMAP 阻塞清单 #1 #2 均已解除，剩余 #3 github.com CLI（走 API 绕过中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。可开工 Phase 5（公共页面）与 Phase 6（用户系统）。

## [0.4.0] - 2026-09-04 · Phase 4 里程碑 1：数据库上线

- 原因：创始人提供了 Neon 免费托管 Postgres 的 `DATABASE_URL`，Phase 4 唯一硬阻塞解除。
- 内容：
  - 写入 `website-project/.env`（已被 `.gitignore` 的 `.env*` 规则排除，验证：`git check-ignore -v .env` → `.gitignore:38:.env*`）。文件仅存本机，**永不入 Git**。
  - `prisma migrate status`：连接成功，识别 1 条待应用迁移 `0_init`。
  - `prisma migrate deploy`：将 `prisma/migrations/0_init/migration.sql`（17 张 CREATE TABLE、391 行）应用到 Neon 数据库 `neondb`（region `us-east-2`）。输出："All migrations have been successfully applied."
  - 验证查询（`PrismaClient.$queryRawUnsafe` 读 `information_schema` 与 `pg_enum`）：
    - **表总数 18**：17 张业务表（BusinessModel / CapabilityProject / Case / CaseCapability / ChangeLog / Evidence / Localization / LocalizationSupplier / Market / OpenSourceProject / Order / Region / Solution / SolutionFinancial / Supplier / TechCapability / UnknownVariable）+ 1 张 `_prisma_migrations`。
    - **`_prisma_migrations` 记录**：`0_init`，applied_steps_count=1，finished_at=`2026-09-04T15:22:16.915Z`，rolled_back_at=NULL。
    - **11 个枚举全部就位**（值与 schema.prisma 一致）：Industry(7) / CaseStage(5) / EvidenceType(4) / Maturity(4) / LicenseType(11) / LicenseReviewStatus(4) / SolutionStatus(3) / Currency(2) / BuyerType(2) / OrderStatus(4) / ChangeAction(4)。
- 效果：**Phase 4 里程碑 1 达成**——V1 核心闭环数据结构在真实 Postgres 上跑通、可读写。ROADMAP 阻塞清单 #1（数据库）已消除。剩余 Phase 4 工作：目录结构、Prisma Client 单例、日志、错误处理、Vitest 测试框架 + 首个冒烟测试、基础 UI shell。

## [0.3.2] - 2026-09-04

- 原因：Phase 4 唯一硬阻塞是"没有可连接的 Postgres"；创始人零编码背景，需要一份可自助照做的托管数据库注册指引，避免注册过程中反复问答（宪法第2条 MVP 优先）。
- 内容：新增 `docs/SETUP_NEON_DATABASE.md`——Neon 免费 Postgres 分步指引（注册 → 创建项目 → 复制 URI → 回传），含区域选择建议（新加坡 `ap-southeast-1` 优先）、Free 计划额度、7 条 FAQ、安全须知（URL 泄漏后如何 reset）。
- 效果：创始人可在 ~10 分钟内自助拿到 `DATABASE_URL`；一旦回传，我即执行 `prisma migrate deploy` → seed → 进入 Phase 4 骨架搭建。

## [0.3.1] - 2026-09-04

- 原因：解除 Phase 4 的"依赖下载卡顿"阻塞（创始人批准使用国内镜像源）。
- 内容：
  - npm 源切至 npmmirror，并设 `PRISMA_ENGINES_MIRROR` 指向 npmmirror 的 Prisma 二进制镜像。
  - `npm install` 成功：1 分钟装完 393 个包；`postinstall` 的 `prisma generate` 成功生成 Prisma Client v6.19.3。
  - **`prisma validate` 通过**：`The schema at prisma\schema.prisma is valid`（此前 0.2.0/0.3.0 记录的"未跑通"已解除）。
  - 用 `prisma migrate diff --from-empty` 离线生成初始迁移 `prisma/migrations/0_init/migration.sql`（17 张表、391 行，无报错）+ `migration_lock.toml`；提交 `package-lock.json` 锁定依赖版本。
  - 保持 Prisma 6.19.3 stable，不升级到 8.0.0-rc（宪法：稳定优先、不追新）。
- 效果：schema 已通过官方校验且能生成合法 Postgres DDL；依赖链就绪。**仍待**：一个可连接的 Postgres 以执行 `prisma migrate deploy`（本机无 DB，创始人将提供免费托管连接串）。

## [0.3.0] - 2026-09-04

- 原因：接收《全自动开发总控 Prompt V1.0》，执行其第一阶段（Phase 0–3：环境检查 + 基础文档），暂不写业务代码（总控第37–39节）。
- 内容：
  - 总控 Prompt 版本化入库 `docs/MASTER_PROMPT_V1.md`。
  - 新增文档集：`README.md`、`PROJECT_RULES.md`（索引+优先级+冲突裁决）、`PRODUCT_SPEC.md`、`ARCHITECTURE.md`、`DATABASE.md`、`AI_WORKFLOW.md`、`SECURITY.md`、`TESTING.md`、`ROADMAP.md`、`CHANGELOG.md`、`.env.example`。
  - 环境检查：Node v24.17 / npm 11.13 / git 2.52 / gh 2.100；本机无 Postgres、无 Docker；npm 重型依赖下载 stall；命令行不可达 github.com（仅 api.github.com）。
- 效果：项目具备完整 Phase 0–3 设计基线与治理文档；明确 V1-A/V1-B 分层与 5 项开放决策、6 项进入 Phase 4 的阻塞资源。**未编写业务代码，未跑通 prisma validate/migrate（环境阻塞，已如实记录）。**

## [0.2.0] - 2026-09-04

- 原因：定义产业能力数据库 V1（宪法第12/13条）。
- 内容：新增 `prisma/schema.prisma`（12 核心实体 + ChangeLog，Postgres），`docs/DATABASE_SCHEMA_V1.md` 设计说明；`package.json` 接入 prisma ^6 / @prisma/client 与 db:* 脚本。
- 效果：核心闭环数据结构就绪（提交 `66fbec5`）；待 Postgres 与依赖就绪后 `prisma validate/migrate`。

## [0.1.1] - 2026-09-04

- 原因：确立项目宪法为最高优先级并版本化（宪法第13条）。
- 内容：新增 `docs/PROJECT_RULES_V2.md`（宪法全文），`AGENTS.md` 顶部加指针（保留 Next.js 自动块）。
- 效果：治理基线入库（提交 `d056391`）。

## [0.1.0] - 2026-09-04

- 原因：项目启动。
- 内容：create-next-app 生成 Next.js 16 + TS + Tailwind + ESLint 脚手架；创建公开仓库 `yvzibaba/website-project`。
- 效果：可开发的空项目基线（提交 `17ad619`）。
