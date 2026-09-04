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

Next.js 16（App Router）+ React 19 + TypeScript · Tailwind CSS v4（+ 计划引入 shadcn/ui）· Prisma 6 + PostgreSQL（+ 计划 pgvector）· **Auth.js v5（next-auth beta）Credentials + JWT 会话 + node:crypto scrypt 口令哈希（零额外依赖）** · 统一 Model Router（核心模型 Qwen3.8-Max，禁止硬编码模型名）。

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
- [x] **Phase 5 里程碑 1：公共页面地基**——页面级布局组件 `src/components/page/*`（PageHeader/Breadcrumb/EmptyState）；行业数据层 `src/server/industries.ts`（枚举↔slug 映射 + `getIndustryCaseCounts` groupBy 计数 + DB 失败降级）；`/industries` 列表（force-dynamic 实时计数）、`/industries/[slug]` 详情（SSG + `dynamicParams=false` 保证真 404）、`/about` 关于、`/privacy`+`/terms` 结构化占位（明确标注待法务审定，宪法第 21 条）；导航/页脚更新（移除死链）。`tests/unit` 扩到 **140 cases** + 集成 **7 cases** 全绿；`tsc`/`eslint` 0 错；`next build` 产出 **6 新路由**（含 7 个 SSG 行业页）；HTTP 冒烟 **9/9**（含 `/industries/not-a-real-one` 真 404）。（本里程碑曾引入的根 `loading.tsx` Suspense 骨架已在里程碑 2 移除，见下）
- [x] **Phase 5 里程碑 2：案例/方案公共页 + DEMO 标注种子 + 真 404 修复**——DEMO 可见性层 `src/server/demo.ts`（默认排除、`?demo=1` 显式纳入并打角标，规避 Prisma `{not}` NULL 陷阱）；DEMO 种子脚本 `prisma/seed.ts`（`npm run db:seed`，**仅 6 个标注【DEMO】的案例，按创始人裁决不种子任何方案**——方案涉及定价/购买闭环须走真实多角色流水线，宪法第 20 条；生产环境拒跑、幂等清理重建）；案例数据层 `src/server/cases.ts` + 方案数据层 `src/server/solutions.ts`（`$transaction[findMany,count]` + 行业筛选/分页/排序 + DEMO 门控 + 详情含证据分层/能力关联/财务/未知变量，金额两位小数精显）；`/cases`+`/cases/[id]`+`/solutions`+`/solutions/[id]` 四页（购买按钮 disabled 占位，Phase 12 接入）；导航重新加回案例/方案链接。**关键修复：删除根 `src/app/loading.tsx`**——实测其 Suspense shell 会让 force-dynamic 详情页对无效 id 先 flush 200、`notFound()` 无法回退状态码（会导致无效 URL 被 SEO 误收录），移除后无效 id 真 404（SSG 路由本就免疫）。`tests/unit` 扩到 **147 cases** + 集成 **15 cases** 全绿；`tsc`/`eslint` 0 错；`next build` 产出 **4 新动态路由**；HTTP 冒烟 **14/14**（含 3 个真 404 + `?demo=1` 种子可见/默认隐藏）
- [x] **Phase 5 里程碑 3：搜索系统 + 首页组装（Phase 5 收官）**——搜索编排层 `src/server/search.ts`（`searchPublic` 用 `Promise.all` 并行案例 + 方案、聚合 `ok`/`hits`、DB 失败软降级为 `ok:false`）；`src/server/{cases,solutions}.ts` 列表新增可选关键词维度 `q`，重构出 `buildCaseWhere`/`buildSolutionWhere` 用 `{AND:[...]}` 容纳"关键词 OR 片段"与"DEMO OR 片段"（兄弟 OR 键不能并列）；`/search` 页（无 JS 可用的 GET 表单 + 行业 chips + 引导/非法/失败/空/结果 五态分离 + "查看全部 N 个"深链到 `/cases?q=`·`/solutions?q=`）；首页 `src/app/page.tsx` 照总控 §6 从 Phase 4 骨架整体重写为六段体验（Hero + 内联搜索 / 今日全球产业案例 / 今日产业解决方案 / 企业 AI 产业诊断 V1-B 即将开放 / 我们如何工作六步 / 按行业浏览），移除 Phase 4 遗留的 pg_stat 调试面板；`/cases`+`/solutions` 加关键词回显条；导航/页脚加 `/search`。V1 为关键词匹配（标题+摘要 ILIKE），语义搜索按宪法第 4 条 MVP 延后。`tests/unit` 扩到 **152 cases** + 集成 **18 cases** 全绿；`tsc`/`eslint` 0 错；`next build` 产出 `ƒ /search`；HTTP 冒烟 **31/31**（含 2 个真 404 回归 + `?demo=1` 命中种子标题/默认不泄露）
- [x] **Phase 5 完成**——总控 Phase 5「公共页面」交付清单（首页/行业/案例列表/方案列表/搜索/关于/隐私/协议）全部达成；V1-A 商业闭环的"用户查看"入口层（发现 → 检索 → 详情）打通，"购买"仍为 Phase 12 占位
- [x] **Phase 6 里程碑 1：用户系统最小闭环（注册 / 登录 / 会话 / 账号页）**——认证方案经创始人裁决选定 **Auth.js 自建**（总控 §21「用成熟现成方案」）；`prisma/schema.prisma` 新增 `enum UserRole{USER/REVIEWER/ADMIN}` + `model User`（email unique / passwordHash / role 默认 USER），`Order` 加可空 `userId` 关系（`ON DELETE SET NULL`），迁移 `20260905000000_add_user_auth` 纯加性并已 `migrate deploy` 到 Neon（表 17→18、枚举 11→12）；口令哈希 `src/lib/password.ts` 用 **node:crypto scrypt**（N=16384,r=8,p=1，自描述串 `scrypt$N$r$p$salt$hash`，`timingSafeEqual` 定长比较，畸形/超长一律 false，**零额外依赖**、绝不存明文）；`src/lib/validation.ts` 加 Email/Password/Register/Login/UserRole schema（邮箱归一小写、注册强制 8–128 位、登录口令只要求非空防账号枚举）；`src/server/users.ts`（registerUser 判别联合 + P2002 归一 email_taken、getAuthUserByEmail、getProfileUserById 排除 passwordHash）；`src/auth.ts`（Credentials + JWT 会话，jwt/session 回调透传 id/role，`trustHost:true`，**不挂 Prisma Adapter**，JWT 类型增强打在 `@auth/core/jwt`）+ `api/auth/[...nextauth]` handler；`/login`·`/register`·`/account` 三页（`useActionState` 驱动的共用 `AuthForm` + `"use server"` actions：注册后自动登录、登录失败统一"邮箱或密码不正确"、账号页无会话重定向 /login + 登出）；导航/页脚加登录/注册/我的账号；`.env` 加 `AUTH_SECRET`、`.env.example` 认证段改写。`tests/unit` 扩到 **167 cases**（+password 8 +认证 schema 7）+ 集成 **23 cases**（+users 5）全绿；`tsc`/`eslint` 0 错；`next build` 产出 `ƒ /login`·`ƒ /register`·`ƒ /account` + `/api/auth/[...nextauth]`；**HTTP 认证冒烟 26/26**（csrf → callback/credentials → session(email/role/id, 不含 passwordHash) → 登录后 /account 200 → 错误口令/不存在邮箱无差别失败 → signout 清 cookie → /account 重定向）
- [x] **Phase 7 里程碑 1：案例评分内核（可复算公式 + 黄金样本 + 版本化文档）**——`src/server/scoring.ts` 纯函数内核把总控 §10「案例评分体系」落成可复算程序：`OPPORTUNITY_DIMENSIONS` 10 维度权重**逐字照抄总控 §10**（满分恒 100，`reduce` 求和防硬编码失真），`竞争强度`/`实施难度` 标为 **inverse** 反向极性（录入按直觉填负面强度、程序负责 `max-raw`，防人工填反方向），`computeOpportunityScore` 经 Zod 逐维度校验、非法 → `{ok:false,issues}` **指名维度绝不静默截断**；`computeEvidenceConfidence` 用类型权重（FACT 1.0/ASSUMPTION 0.5/INFERENCE 0.4/PREDICTION 0.3）+ 无来源打 0.6 折 + 缺省 confidence 50，`value=round(100·Σ(w·q·sf)/Σw)`（**总控只给示例值未给公式，故标注为本项目 v1 假设、参数可调**）；`countKeyUnknowns`=非 FACT 证据数；`computeCaseScores` 一次出三件套 + `CaseScoresSchema` 供 M2 持久化校验。`docs/SCORING_V1.md` 把每个数字标注为事实/假设/推断（宪法第 6 条），含两个逐维度可复算样例（机会 →88 与总控示例交叉验证一致、证据 →69）、**诚实记录已知缺口**（总控 §11 证据等级 S/A/B/C/D 轴尚未建模、权重未经真实案例校准），重申"综合评分 ≠ 项目一定成功"（规则 9）。`tests/unit/scoring.test.ts` **26 黄金样本**锁定（最优 100/全填 max 90/全填 0 10/样例 88/反向极性/越界拒绝/确定性/证据可信度精确 Σ）。`tests/unit` 扩到 **193 cases** + 集成 **23 cases**（无回归，本里程碑不动 DB/页面）全绿；`tsc`/`eslint` 0 错；`next build` 全路由无回归；版本 **0.9.0**
- [ ] Phase 6 里程碑 2+ / Phase 7 里程碑 2+：角色/权限中间件（SECURITY §4，**有意延后到 Phase 13**——`/admin` 尚不存在，此刻建门禁违反宪法第 2/4 条 MVP 优先；`UserRole` 枚举已在库就绪）；评分持久化（`Case.scoreBreakdown` + 详情页拆解 + 历史重算脚本）；随后案例 CRUD/证据管理、Phase 8+ 方案系统、AI Agent、GitHub Scout…（按 ROADMAP 推进）

## 本地运行（待依赖与数据库就绪后）

```bash
npm install                 # 触发 prisma generate
cp .env.example .env.local  # 填入 DATABASE_URL 等，切勿提交真实密钥
npm run db:migrate          # 需要可连接的 PostgreSQL
npm run dev                 # http://localhost:3000
```

## 给创始人的一句话

网站、后台、代码都可以简单；但**产业案例质量、技术匹配质量、中国本土化质量、解决方案质量、证据质量和真实商业价值绝不能简单化**（宪法第28条）。
