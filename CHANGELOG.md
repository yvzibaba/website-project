# CHANGELOG

记录规则（宪法第13条）：每次修改追加**版本号 + 时间 + 原因 + 内容 + 效果**；不得直接覆盖生产版本；必要时可回滚（Git revert 对应提交）。
时间时区：Asia/Shanghai。

## [0.4.2] - 2026-09-04 · Phase 4 里程碑 3：设计 tokens + 基础 UI 组件库 + API 客户端层 + Proxy 中间件

- 原因：里程碑 2 打通了"能跑能测"的后端骨架，但总控 Phase 4 交付清单里的「基础 UI」仍是空白；同时所有 API Route 需要的横切关注点（request-id 追踪、入参校验、统一 fetch、访问日志、安全头）尚未沉淀。本里程碑把这些一次性补齐，让 Phase 5 的 35 个页面可以"照抄即用"，避免每个页面各写一套样式/校验/错误处理（宪法第 4/5 条：先铺可复用地基；第 12 条：重复 >3 次的人工作业考虑自动化/标准化）。
- 内容：
  - **设计 tokens** `src/app/globals.css`：新增颜色（primary 产业蓝 / success / warning / danger / info / muted / border / ring + 各自 foreground）、圆角（sm/md/lg/xl）、阴影（sm/md/lg）三组 CSS 变量，亮/暗双模式（`prefers-color-scheme`）；经 Tailwind v4 `@theme inline` 暴露为工具类（`bg-primary` / `text-muted-foreground` / `rounded-lg` / `shadow-md` 等）。全局 `:focus-visible` 焦点环走 `--ring` 变量，键盘可达性优先。所有组件颜色一律走 token，零硬编码色值。
  - **className 工具** `src/lib/cn.ts`：零依赖版 `cn()`（不引 clsx + tailwind-merge，减 ~15KB gzip 与版本同步负担），支持 string / number / 数组嵌套 / 对象 truthy / falsy 过滤。
  - **基础 UI 组件库** `src/components/ui/`（11 个组件 + barrel `index.ts`，全部 Server Component 安全）：
    - `Button.tsx` — 5 变体（primary/secondary/ghost/danger/link）× 4 尺寸（sm/md/lg/icon）+ loading 态 + disabled；极简 polymorphic（传 `href` 渲染 `<a>`，否则 `<button>`），不引 Radix Slot。danger 变体满足宪法第 21 条"破坏性操作须视觉区分"。
    - `Card.tsx` — Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter，支持 `interactive`（悬停阴影 + 边框高亮）。
    - `Badge.tsx` — 7 变体（neutral/primary/success/warning/danger/info/outline）+ compact 模式，语义对齐业务（证据等级、审核状态、许可证风险、行业标签）。
    - `Input.tsx` — Input / Textarea / Label / FieldError / Field（表单字段容器，约定 `${htmlFor}-error` / `-help` 的 aria id）；invalid 态走 `aria-invalid` + 红框。
    - `Alert.tsx` — 4 变体（info/success/warning/danger）+ `role="alert"|"status"` 可及性；warning 变体承载宪法第 21 条"需要专业人工确认"高风险提示。
    - `Skeleton.tsx` — Skeleton（rect/circle/text 三变体，纯 CSS animate-pulse）+ Spinner（role="status" + aria-label，纯 CSS 旋转无 SVG 依赖）。
    - `Container.tsx` — Container（sm/md/lg/xl/full 五档最大宽度，lg 与 layout 导航 max-w-6xl 对齐）+ Separator（水平/垂直，装饰性时 aria-hidden）。
  - **API 客户端层** `src/lib/api-client.ts`：`ApiClient` 类统一 fetch（禁止业务裸 fetch）。baseUrl + path + query 自动拼接（跳过 null/undefined）；JSON body 自动序列化 + content-type；自动注入/透传 `x-request-id`；超时走 `AbortSignal.timeout`（默认 10s）；非 2xx 按状态码/上游 code 还原成对应 AppError 子类（400→Validation … 429→RateLimited，5xx→Upstream）；网络层错误（超时/DNS/连接重置）包成 UpstreamError 保留 cause；幂等方法（GET/HEAD/OPTIONS）可选指数退避重试（±20% 抖动防重试风暴，默认关闭，POST 永不重试）；get/post/put/patch/delete 快捷方法；导出浏览器内调本站 API 的默认单例 `apiClient`。
  - **校验 schema 集** `src/lib/validation.ts`（Zod v4）：ID 类（CuidSchema / UuidSchema / SlugSchema）；PaginationSchema（page 从 1、pageSize 默认 20 上限 100 防拉爆库、自动算 offset/limit、coerce 字符串查询参数）；makeSortSchema（字段白名单 + 自动生成 orderBy，防 SQL 注入/全字段排序）；SearchQuerySchema（trim + 去控制字符 + 1–100 限长）；**11 个业务枚举与 `prisma/schema.prisma` 一一对应**（Industry 7 / CaseStage 5 漏斗 / EvidenceType 事实假设推断预测 / Maturity 4 / LicenseType 11 / LicenseReviewStatus 4 / SolutionStatus 3 态 / Currency / BuyerType / OrderStatus / ChangeAction 含 ROLLBACK）；paginatedResponseSchema 泛型包装 + HealthResponseSchema（与 /api/health 同步）。
  - **request-id 工具** `src/lib/request-id.ts`：`generateRequestId`（node:crypto UUID v4）/ `isValidRequestId`（字符集 `[A-Za-z0-9-]` 长度 8–64，拒绝 CRLF 防日志注入）/ `extractOrGenerateRequestId`（客户端合法 id 才采纳）/ `sanitizeForLog`（去控制字符双保险）/ `REQUEST_ID_HEADER` 常量。
  - **Proxy 中间件** `src/proxy.ts`（Next.js 16：middleware 重命名为 proxy，导出函数名 `proxy`）：① 每个入站请求分配/透传 `x-request-id`，**同时注入下游请求头**（`NextResponse.next({ request: { headers } })`，让 Route Handler 即使客户端没传也能读到）+ 写回响应头；② 结构化访问日志（JSON 一行：requestId/fromClient/method/path/query/durationMs/ua 截断 200/ip/timestamp）；③ 基础安全头（X-Content-Type-Options nosniff / X-Frame-Options DENY / Referrer-Policy strict-origin-when-cross-origin；CSP 留 Phase 14 配 nonce 时再加）；④ matcher 排除静态资源 + 跳过 `/_next`、图片、字体等噪音。Edge 安全：request-id 生成优先用 Edge 原生 Web Crypto `randomUUID()`（与 node 版 UUID 格式一致），不依赖 node:crypto。
  - **/api/health 升级**：GET 接收 `NextRequest`，从请求头读回 request-id 放进 JSON body（`requestId` 字段），与响应头一致，方便前端/监控双向关联；logger 派生 `child({ requestId })`。
  - **/ui 演示页** `src/app/ui/page.tsx`：一页渲染全部组件（Button 全变体/尺寸/态、Badge 7 变体、Alert 4 变体、Card 静态+交互、表单 Field/Input/Textarea/错误态/禁用态、Spinner/Skeleton、设计 tokens 色板），build 后 HTTP 冒烟即可确认组件库无运行时错误；给零基础创始人一个"看得见"的设计系统参考（总控第 41 节）；robots noindex。layout 导航加 `ui` 入口。
  - **测试新增** `tests/unit/`：`cn.test.ts`（9 cases）、`request-id.test.ts`（12 cases：UUID 格式/万次唯一性/字符集校验/CRLF 拒绝/提取或生成/净化）、`validation.test.ts`（33 cases：ID/分页默认值与上限/排序白名单防注入/搜索净化/11 枚举成员数与值断言/响应包装/Health schema）、`api-client.test.ts`（27 cases：URL 构造/query 跳过空值/绝对路径/request-id 注入与透传与非法忽略/JSON 序列化/头合并/响应解析 JSON-text-204/6 种状态码→AppError 子类/5xx→Upstream/上游 code 还原/非 JSON 错误体/网络错误包装/幂等重试与非幂等不重试与重试耗尽与 429 与 404 不重试/AbortSignal 超时）。
- 验证（宪法第 5/18/20 条）：
  - `tsc --noEmit`：**0 错误**（修复 AlertProps 与 div `title` 冲突 → Omit、RequestOptions 重新声明 `body`、测试 `err` unknown → `captureError` 助手）。
  - `vitest run tests/unit`：**125/125 全绿**（原 44 + 新增 81），432ms。
  - `node --env-file=.env vitest run tests/integration`：**5/5 全绿**，8.86s（真连 Neon us-east-2，无回归）。
  - `next build`（Turbopack）：**编译成功**，1333ms 编译 + 3.6s TS + 静态生成；产出 **4 条路由 + Proxy(Middleware)**：`ƒ /` / `○ /_not-found` / `ƒ /api/health` / `○ /ui`（预渲染静态）。
  - **HTTP 端到端冒烟**（`next start -p 3114`）：DB 预热 1 次成功（lat 3706ms 冷启动）；`/api/health` 无客户端 id → **200** 服务端生成 UUID 且 **header 与 body.requestId 一致（match=true，证明 request-id 已透传到 Route Handler）**；带合法 client id → **echo=true**；带非法 id（过短 "abc"）→ **rejected=true regenerated=true**；安全头三件齐全；`/ui` → **200** 44631 字节，Button/Badge/Alert/Spinner 全部渲染；`/` → **200** 22371 字节含"数据库实时状态"；`/definitely-not-here` → **404** 带 request-id。
  - 冒烟中发现并修复 2 个真问题：① proxy 原来只写响应头不注入下游请求头 → Route Handler 读不到（auto-rid 时 body.requestId 为 undefined）；② `edgeGenerateRequestId` 原产出带下划线的 `req_x_y` 过不了自己的 `isValidRequestId`（字符集不含下划线）→ 改用 Web Crypto UUID + 连字符兜底。另记录：CRLF 头注入在 undici 客户端层即被拒（`Headers.append invalid`），服务端净化为纵深防御。
- 效果：**Phase 4 里程碑 3 达成**——总控 Phase 4 交付清单（Web 骨架 / 数据库连接 / 基础 UI / 环境变量 / 日志 / 错误处理 / 测试框架）**全部完成**。设计系统 + API 客户端 + 校验 + 追踪 + 安全头地基就绪，Phase 5（35 公共/用户/后台页面）可直接复用。测试基线扩到 130（125 单元 + 5 集成）。ROADMAP 阻塞剩余 #3 github.com CLI（API 绕行中）、#4 模型 API Key、#5 部署/支付、#6 对象存储。

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
