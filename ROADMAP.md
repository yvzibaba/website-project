# ROADMAP — Phase 0–18 任务树、MVP 边界、阻塞与开放决策

来源：总控 Prompt 第37–43 节；宪法第2/4/18/26 条。执行方式：**小步、逐 Phase**，每完成一个 Phase 必须 修改代码 → 运行测试 → 检查错误 → 修复 → 更新文档 → 汇报状态（总控第37节 / 宪法第18条）。禁止一次性重写整个系统。

## 1. Phase 任务树

| Phase | 名称 | 关键交付 | 依赖 | 状态 |
|---|---|---|---|---|
| 0 | 项目分析 | 环境检查、现状盘点 | — | ✅ 本次完成 |
| 1 | 需求与信息架构 | PRODUCT_SPEC（用户/页面 IA/MVP） | 0 | ✅ 本次完成 |
| 2 | 技术架构 | ARCHITECTURE（选型/分层/Model Router） | 1 | ✅ 本次完成 |
| 3 | 数据库设计 | DATABASE（ER）+ prisma V1 核心 schema | 2 | 🟡 V1 核心已建；全量表分层待逐 Phase 补 |
| 4 | 项目骨架 | 目录结构、DB 连接、基础 UI、env、日志、错误处理、测试框架 | 3 + Postgres/依赖 | ✅ **Phase 4 全部完成**（里程碑 1+2+3）：DB 上线（17 表 + 11 枚举）、`src/lib/{env,logger,errors,prisma}` 核心库、Next.js shell（layout/page/error/not-found + `/api/health`）；里程碑 3 补设计 tokens（颜色/圆角/阴影亮暗双模式）、`src/components/ui/*` 11 组件 + `/ui` 演示页、`src/lib/{cn,api-client,validation,request-id}`（统一 fetch + AppError 映射 + 重试、Zod 校验含 11 个与 prisma 同步枚举、request-id 追踪）、`src/proxy.ts`（request-id 注入下游 + 访问日志 + 安全头）。Vitest 单元 **125** + 集成 5 全绿、`tsc` 0 错、`next build` Turbopack 产出 **4 路由 + Proxy**、HTTP 冒烟：request-id 服务端生成/客户端透传/非法拒绝全通过、`/ui` 200 全组件渲染 |
| 5 | 公共页面 | 首页/行业/案例列表/方案列表/搜索/关于/隐私/协议 | 4 | ✅ **Phase 5 全部完成**（里程碑 1+2+3）：**M1**——页面级布局组件（PageHeader/Breadcrumb/EmptyState）、行业数据层 `src/server/industries.ts`、`/industries` 列表（force-dynamic + 实时计数）、`/industries/[slug]` 详情（SSG + `dynamicParams=false` 保证真 404）、`/about`、`/privacy`+`/terms` 结构化占位（标注待法务审定，宪法第 21 条）、导航/页脚更新。**M2**——DEMO 可见性层 `src/server/demo.ts`（默认排除、`?demo=1` 显式纳入并打角标）、DEMO 种子脚本 `prisma/seed.ts`（**仅 6 个标注【DEMO】的案例，按创始人裁决不种子任何方案**——方案涉及定价与购买闭环须走真实多角色流水线，宪法第 20 条禁伪造可售商品；生产环境拒跑）、案例数据层 `src/server/cases.ts`（列表 `$transaction[findMany,count]` + 行业筛选/分页/排序 + 详情含证据分层/能力关联/商业模式，公开阶段白名单 + DEMO 门控 → `not_found`）、方案数据层 `src/server/solutions.ts`（仅 PUBLISHED，金额两位小数精显）、`/cases`+`/cases/[id]`+`/solutions`+`/solutions/[id]` 四页（购买按钮占位 disabled，Phase 12 接入）。**关键修复**：删除根 `src/app/loading.tsx`——实测其 Suspense shell 会让 force-dynamic 详情页对无效 id 先 flush 200、`notFound()` 无法回退状态码（3 个无效 id 冒烟全返 200）；移除后无效 id 真 404，SSG 路由本就免疫。**M3**——搜索编排层 `src/server/search.ts`（`searchPublic` 并行案例+方案、聚合 ok/hits、DB 失败软降级）、cases/solutions 列表加关键词维度（`buildCaseWhere`/`buildSolutionWhere` 用 `{AND:[...]}` 容纳关键词 OR 片段与 DEMO OR 片段）、`/search` 页（无 JS 可用 GET 表单 + 行业 chips + 引导/非法/失败/空/结果 五态 + 深链"查看全部"）、首页 `src/app/page.tsx` 照总控 §6 重写为六段体验（Hero+内联搜索 / 今日案例 / 今日方案 / 企业诊断 V1-B 即将开放 / 六步工作流 / 按行业浏览，移除 Phase 4 pg_stat 调试面板）、`/cases`+`/solutions` 关键词回显条、导航加 `/search`。测试基线 **152 单元 + 18 集成**全绿、`tsc`/`eslint` 0 错、`next build` 产出 `ƒ /search`、HTTP 冒烟 **31/31**（含 2 个真 404 回归 + `?demo=1` 命中/默认不泄露种子标题）。V1-A「用户查看」入口层（发现→检索→详情）打通；"购买"仍 Phase 12 占位 |
| 6 | 用户系统 | 注册/登录/会话/最小权限（下单身份） | 4 | 🟡 **M1 完成**：认证方案经创始人裁决选定 **Auth.js 自建**（总控 §21）——`next-auth@5` Credentials（邮箱+密码）+ **JWT 会话**（`trustHost:true`，**不挂 Prisma Adapter**，依赖最少）；`prisma` 加 `enum UserRole{USER/REVIEWER/ADMIN}` + `model User`（email unique / passwordHash / role 默认 USER），`Order` 加可空 `userId`（`ON DELETE SET NULL`），迁移 `20260905000000_add_user_auth` **纯加性**已 `migrate deploy` 到 Neon（表 17→18、枚举 11→12）；口令哈希 `src/lib/password.ts` 用 **node:crypto scrypt**（自描述串 + `timingSafeEqual`，畸形/超长一律 false，**零额外依赖**、绝不存明文）；`src/lib/validation.ts` 加 Email/Password/Register/Login/UserRole schema（邮箱归一小写、注册 8–128 位、登录口令 min1 防枚举）；`src/server/users.ts`（registerUser 判别联合 + P2002 归一 email_taken、getAuthUserByEmail、getProfileUserById 排除 passwordHash）；`src/auth.ts` + `api/auth/[...nextauth]`（authorize 对账号不存在/密码错误一律返 null，防枚举；jwt/session 透传 id/role；JWT 类型增强打在 `@auth/core/jwt`）；`/login`·`/register`·`/account` 三页（`useActionState` 共用 `AuthForm` + `"use server"` actions，注册后自动登录，账号页无会话重定向 /login + 登出）。测试基线 **167 单元 + 23 集成**全绿、`tsc`/`eslint` 0 错、`next build` 产出 `ƒ /login`·`ƒ /register`·`ƒ /account`·`/api/auth/[...nextauth]`、**HTTP 认证冒烟 26/26**（csrf→callback→session→account→signout，错误口令/不存在邮箱无差别失败）。V1-A「购买」下单身份就绪（订单绑定 Phase 12）。**M2+ 待做**：角色/权限鉴权中间件 + `/admin` 门禁（SECURITY §4 / Phase 13） |
| 7 | 案例系统 | 案例 CRUD、证据、评分、行业关联、案例详情页 | 5,6 | 🟡 **M1 完成（评分内核）**：`src/server/scoring.ts` 纯函数把总控 §10「案例评分体系」落成可复算程序（宪法第 7 条：程序计算 > LLM 口算）——`OPPORTUNITY_DIMENSIONS` 10 维度权重**逐字照抄总控 §10**（满分恒 100，`reduce` 求和防失真），`竞争强度`/`实施难度` 标 **inverse** 反向极性（录入按直觉填负面强度、程序负责 `max-raw`，防填反方向）；`computeOpportunityScore` 经 Zod 逐维度校验、非法 → `{ok:false,issues}` **指名维度绝不静默截断**；`computeEvidenceConfidence`（类型权重 FACT1.0/ASSUMPTION0.5/INFERENCE0.4/PREDICTION0.3 + 无来源 0.6 折 + 缺省 confidence 50，`round(100·Σ(w·q·sf)/Σw)`，**总控只给示例值未给公式 → 标注为本项目 v1 假设、参数可调**）；`countKeyUnknowns`=非 FACT 证据数；`computeCaseScores` 一次出三件套 + `CaseScoresSchema` 供 M2 入库校验。`docs/SCORING_V1.md` 版本化公式文档（每个数字标注事实/假设/推断、两个可复算样例 机会→88 与总控示例交叉验证一致·证据→69、诚实记录缺口=总控 §11 证据等级 S/A/B/C/D 轴尚未建模 + 权重未经真实案例校准、变更流程 + 版本历史、重申"综合评分 ≠ 一定成功"规则 9）。`tests/unit/scoring.test.ts` **26 黄金样本**（最优100/全填max90/全填0 10/样例88/反向极性/越界拒绝/确定性/证据可信度精确Σ）。测试基线 **193 单元 + 23 集成**全绿、`tsc`/`eslint` 0 错、`next build` 全路由无回归（本里程碑不动 DB/页面，纯函数验证以单元黄金样本为准）、版本 **0.9.0**。**M2+ 待做**：评分持久化（`Case.scoreBreakdown` Json + 迁移 + 详情页拆解展示 + 历史重算脚本并标注旧版本号）、案例 CRUD、证据管理（含 §11 等级轴建模的开放决策）、行业关联 |
| 8 | 解决方案系统 | Solution.body 34 分节规范、方案详情、版本化、财务/未知变量 | 7 | ⬜ |
| 9 | AI Agent 系统 | Model Router、Agent 框架、Schema 校验、成本记录、评分算法程序 | 4,8 | ⬜ |
| 10 | GitHub Scout | 开源发现/去重/评分/许可证检查/技术匹配 | 9 | ⬜ |
| 11 | 企业诊断 | 企业画像、诊断会话、方案匹配、Top5、定制方案（V1-B） | 8,9 | ⬜ |
| 12 | 订单 | 下单、最简支付确认、后台确认、解锁；预留多渠道 | 6,8 | ⬜ |
| 13 | 后台 | 每日任务中心、各领域管理、审核发布、日志、成本看板 | 7–12 | ⬜ |
| 14 | SEO | 独立 URL、meta/OG/结构化数据/canonical、sitemap | 5,7,8 | ⬜ |
| 15 | 测试 | Unit/Integration/API/DB/AI Workflow/Permission/Security/E2E | 各 Phase | ⬜ 随 Phase 进行 |
| 16 | 部署 | Serverless/低运维上线、环境变量、域名 | 4–14 + **托管资源** | ⬜ 阻塞 |
| 17 | 每日自动任务 | 定时流水线编排（23:00）、重试、FAILED_REVIEW | 9,13 | ⬜ |
| 18 | 生产验证 | 端到端验收（总控第42节）、成本可查、文档完整 | 全部 | ⬜ |

## 2. MVP 边界（宪法第2/24/26条）

- **V1-A（必须真正跑通）**：免费案例 → 标准方案 → 购买（含最小用户/登录）。对应 Phase 4–8 + 12 + 必要后台。
- **V1-B（闭环稳定后紧接）**：企业画像 + 企业诊断 + 方案适配（Phase 11）。
- **V2+ 延后**：POC、项目库、孵化、联合投资、实体运营；复杂社交/社区/融资交易/投资商城/供应商市场/知识图谱/微服务/K8s/模型训练/原生 App/小程序/复杂 CRM-ERP。

## 3. 阻塞与所需资源（总控第40节"停止条件"，诚实记录 — 宪法第20条）

进入 Phase 4 前必须由创始人提供/决策，否则无法真实"可运行/可测试"：

1. ~~**数据库**：本机无 PostgreSQL、无 Docker。~~ **已解除**：创始人提供 Neon 免费托管 Postgres `DATABASE_URL`（region `us-east-2`），已写入本地 `.env`（gitignored），`prisma migrate deploy` 成功建 17 表 + 11 枚举。
2. ~~**依赖安装网络**：npm 可达但重型依赖（Prisma 引擎等）下载 stall。~~ **已解除**：改用 npmmirror 源 + `PRISMA_ENGINES_MIRROR`，`npm install`（393 包）与 `prisma validate` 均跑通，首迁移已离线生成。
3. **代码推送**：命令行无法访问 `github.com`（仅 `api.github.com`）。目前经 API 提交；若要走正常 `git push`/CI，需要系统级/TUN 代理。
4. **模型密钥**：Model Router 需要 Qwen3.8-Max 等模型的 API Key（走环境变量，禁止入 Git）。→ 属"需要付费资源授权"。
5. **部署与支付**：Serverless 部署目标、域名、以及支付渠道（V1 可先"支付说明+后台确认"，但需确定收款方式）。→ 属"付费资源/业务决策"。
6. **对象存储**：企业文件/PDF 导出所需的对象存储供应商与凭证。

## 4. 开放决策（需创始人拍板 — 总控第40节"必须由人工决定的业务规则"）

1. **V1 范围**：企业诊断/适配放 V1-A 还是 V1-B？（本文档集默认 V1-B，理由见 PROJECT_RULES.md「已知冲突」）
2. ~~**认证方案**：Auth.js（自托管、免费、需自己配）vs 托管认证（Clerk/NextAuth 云等，省事但可能付费）。~~ **已决策**：创始人选定 **Auth.js 自建**（Credentials + JWT，用户表留自有 Neon 库、零厂商锁定），已于 Phase 6 M1 落地。
3. **数据库/部署供应商**与预算上限（影响成本路由与 Serverless 选择）。
4. **定价与币种**：标准方案定价区间、是否多币种（默认 CNY）。
5. **`Solution.body` 34 分节的最终 JSON 结构**（Phase 8 前定稿；我可先出草案供你改）。

## 5. 验收标准（总控第42–43节，Phase 18）

用户侧闭环可真实运行：访问首页 → 浏览案例 → 打开方案 → 注册 → （企业诊断 → 生成推荐）→ 查看方案 → 提交订单 → 管理员后台确认 → 用户解锁内容。
管理侧：查看每日任务 → 60 候选 → 筛选结果 → Agent 过程 → 3 个方案 → 审核 1 个 → 发布。
质量门槛：核心流程正常、AI 输出结构稳定、关键数据可追溯、无密钥泄露、DB 无结构性错误、普通用户能完成主流程、管理员能管理系统、可在生产运行、能查看 AI 成本、开发文档完整 —— 全部满足才可宣布 **V1.0 READY**。禁止虚构"已完成/测试通过/API 可用/许可证允许商用"（总控第44节）。
