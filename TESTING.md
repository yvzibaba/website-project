# TESTING — 测试策略与质量门禁

来源：总控 Prompt 第28–30、43–44 节；宪法第4/18/20 条。铁律：**没有测试就不宣布完成；禁止虚构"测试通过"**。

## 1. 测试层级（总控第28节）

| 类型 | 覆盖 | 工具（拟） |
|---|---|---|
| Unit | 纯函数：评分算法、财务计算、许可证判定、脱敏 | Vitest |
| Integration | 服务层 + DB：案例/方案/订单流程 | Vitest + Prisma（测试库） |
| API | Route Handlers / Server Actions 契约 | Vitest + supertest/next 测试工具 |
| Database | 迁移可应用、约束/索引/关系正确 | prisma migrate + 集成测试 |
| AI Workflow | 各 Agent 输入/输出 Schema 校验、重试、FAILED_REVIEW | Vitest + 模型 mock/录制回放 |
| Permission | 越权/隔离/角色/解锁鉴权 | 集成测试 |
| Security | 密钥不泄露、日志脱敏、IDOR、文件访问控制 | 集成测试 + npm audit |
| E2E | 第42节验收闭环 | Playwright |

## 2. 重点测试场景（总控第28节）

用户注册、登录、企业画像、文件上传、AI 任务、报告生成、订单、后台、权限、搜索、方案发布。

## 3. AI/Agent 测试（总控第29节）

每个 Agent 必须有：输入 Schema、输出 Schema、成功标准、失败处理、超时处理、Retry、日志。测试要点：
- LLM 输出**必须过 Schema Validation** 才算成功；不合规 → 重试（≤3 次）→ `FAILED_REVIEW`。
- 关键方案链路 Research→Bull→Bear→Judge→QA 的**门禁**：QA 低于阈值必须退回，测试须覆盖"退回"路径。
- 用**录制/回放或 mock** 降低对真实模型与网络的依赖，保证可重复、低成本（宪法第15条）。

## 4. 财务与数字测试（宪法第7条）

评分（100 分制各维度）与财务（ROI/IRR/回收期/敏感性）必须由**程序计算**并有单元测试固定用例（黄金样本），断言可复算；禁止用模型口算结果作为断言基准。

## 5. 质量门禁（Definition of Done）

一个 Phase/功能"完成"当且仅当：代码改完 → 相关测试通过 → 检查日志无异常 → 核心流程手动/自动验证 → 修复问题 → 更新文档（含 CHANGELOG）。任一不满足不得宣布完成，须如实报告（宪法第20条 / 总控第44节）。

## 6. 现状（诚实记录，随 Phase 更新）

- **测试框架已就位**：`vitest ^5.0.0` + `tsx ^4.23.13`（devDeps）；`vitest.config.ts` 定义 node env、`@/*` 路径别名、30s 超时（跨太平洋连 Neon）、forks pool（避免 Prisma Engine 在 worker_threads 里偶发段错误）。npm scripts：`test` / `test:watch` / `test:unit` / `test:integration` / `typecheck`。
- **单元测试基线**（`tests/unit/`，**147 cases**，~0.6s）：
  - `errors.test.ts`（19）— AppError 状态码映射 / 序列化 / cause 保留 / isAppError 跨 realm / toErrorResponse Prisma P2002 P2025 P#### 映射 / 生产屏蔽原始 message。
  - `logger.test.ts`（15）— JSON 单行 / level 阈值 / silent / stdout-stderr 分流 / 敏感字段脱敏（顶层 + 深层嵌套 + 数组）/ Error 序列化 / 循环引用 / child bindings / __redact 边界（Date / BigInt / Function）。
  - `env.test.ts`（10）— Zod 校验 DATABASE_URL / NODE_ENV / LOG_LEVEL / NEXT_PUBLIC_SITE_URL / 缓存单例 / 各失败分支 / 多字段错误汇总。用 `vi.stubEnv`（@types/node v22 把 NODE_ENV 声明为只读）。
  - `cn.test.ts`（9）— className 合并：字符串拼接 / falsy 过滤 / 数字 0 保留 / 条件表达式 / 嵌套数组扁平 / 对象 truthy / 空白裁剪 / 空输入 / 混合类型。
  - `request-id.test.ts`（12）— UUID 格式 / 万次生成唯一性 / 字符集校验（8–64 `[A-Za-z0-9-]`）/ 过短过长拒绝 / null-undefined 拒绝 / CRLF 与控制字符拒绝（日志注入防护）/ 客户端合法 id 采纳 / 非法 id 重新生成 / sanitizeForLog 净化。
  - `validation.test.ts`（33）— Cuid/Uuid/Slug 校验 / Pagination 默认值与 pageSize 上限 100 与 offset 计算与 coerce / makeSortSchema 字段白名单（防 SQL 注入）与 orderBy 生成 / SearchQuery trim 与去控制字符与限长 / **11 个业务枚举成员数与值断言（与 prisma/schema.prisma 同步兜底）** / paginatedResponseSchema / HealthResponseSchema。
  - `api-client.test.ts`（27）— URL 构造（baseUrl + path + query 跳过空值 + 绝对路径）/ request-id 注入与透传与非法忽略 / JSON body 序列化 + content-type / defaultHeaders 与单次 headers 合并 / 响应解析（JSON / text / 204）/ 6 种状态码 → 对应 AppError 子类 / 5xx → UpstreamError / 上游 code 还原 + details 透传 / 非 JSON 错误体兜底 / 网络错误包装 / 幂等 GET 重试与非幂等 POST 不重试与重试耗尽与 429 重试与 404 不重试 / AbortSignal 超时传递。用 `vi.stubGlobal("fetch", ...)` mock。
  - `industries.test.ts`（15）— 行业数据层纯函数与常量守护：INDUSTRIES 数量与 IndustrySchema 对齐 / 枚举无重复无遗漏 / slug 合法（SlugSchema）且唯一 / 中英文名·简介·图标非空 / OTHER 兜底在最后 / PUBLIC_CASE_STAGES 只含 DEEP_CASE 及以后 / getIndustryBySlug·ByEnum·getIndustrySlug·isValidIndustrySlug 正常与未知输入（含枚举名≠slug、未知枚举回落 other）/ slug↔enum 双向自洽。
  - `demo.test.ts`（7）— DEMO 可见性纯函数：DEMO_SOURCE_TYPE / DEMO_TITLE_PREFIX 常量守护 / isDemoEntity 对匹配·不匹配·null·undefined 的判定 / caseDemoVisibility(true)→空片段、(false)→`OR:[{sourceType:null},{sourceType:{not:DEMO}}]`（规避 Prisma `{not}` 连带排除 NULL 真实行的陷阱）/ solutionDemoVisibility 把门控包裹到关联 `case` 上。
- **集成测试**（`tests/integration/`，**15 cases**，~39s，真连 Neon）：`db-smoke.test.ts`（5）— SELECT 1 / Region 全 CRUD / 11 枚举存在性 / 17 表存在性 / `_prisma_migrations` 记录检查，afterAll 双兜底清理；`industries-count.test.ts`（2）— `getIndustryCaseCounts()` 返回 ok 且每个行业 slug 有非负整数计数 / counts 键恰好等于 7 个 slug，含 Neon 冷启动预热重试；`cases-solutions.test.ts`（8）— 自建 realCase(DEEP_CASE)/demoCase(DEMO_FIXTURE)/candidateCase(CANDIDATE 内部态) + publishedSolution(PUBLISHED,price 1999.00,riskDomains,needsProfessionalReview,财务+未知变量)/draftSolution(DRAFT) 全生命周期夹具，afterAll 按 Restrict 外键顺序（先 solution 后 case）清理 + runId 兜底：`listPublicCases` 默认排除 DEMO 与内部阶段但含真实公开案例 / includeDemo=true 纳入并标记 isDemo / 行业筛选生效；`getPublicCaseById` 返回完整详情（证据分层+能力关联+商业模式）/ DEMO 门控（默认 not_found、includeDemo 时 found）/ 内部阶段与不存在 id 均 not_found；`listPublishedSolutions` 只含 PUBLISHED 排除 DRAFT 且 priceDisplay="¥1999.00"；`getPublishedSolutionById` 返回财务与未知变量 / DRAFT 与不存在 id → not_found。DATABASE_URL 缺失时 `describe.skip` 而非 fail，允许 CI 无库跑单元测试。
- **构建验证**：`tsc --noEmit` 0 错误；`eslint .` 0 问题；`next build`（Turbopack）成功，产出 `ƒ /` / `○ /_not-found` / `○ /about` / `○ /privacy` / `○ /terms` / `○ /ui` / `ƒ /api/health` / `ƒ /industries` / `● /industries/[slug]`（SSG 预渲染 7 个 slug）/ `ƒ /cases` / `ƒ /cases/[id]` / `ƒ /solutions` / `ƒ /solutions/[id]` + `ƒ Proxy (Middleware)`。
- **HTTP 端到端冒烟**：里程碑 2 起 `next start -p 3116`，**14 项全过** —— 列表页 `/cases`（默认空态）·`/cases?demo=1`（含种子案例标题 + DEMO Alert）·`/cases?industry=…&demo=1`（行业筛选）·`/cases?demo=1&page=1`（分页）·`/solutions`（空态）·`/solutions?demo=1`（"不种子任何方案"声明）均 200；详情 `/cases/demo_case_biogas?demo=1` 200 含"证据与判断分层"；**404 语义**：`/cases/demo_case_biogas`（DEMO 未带 demo=1）·`/cases/nonexistent-zzz-9999`·`/solutions/nonexistent-zzz-9999` 均 **404**；回归 `/industries` 200·`/industries/new-energy` 200·`/industries/not-a-real-one` 404·`/api/health` 200。（里程碑 1 的 9/9 冒烟在 `-p 3111`，含 `/industries/not-a-real-one` 真 404 验证 `dynamicParams=false`。）
- **已知环境行为（非 bug）**：① Neon 免费库闲置挂起后首次连接可能 5s 超时返 500（health 正确报 `db.ok:false` 并记录日志），第二次唤醒后恢复——冒烟脚本已加预热重试；② CRLF 头注入在 undici 客户端层即被拒（`Headers.append: invalid header value`），到不了服务端，Proxy 的 `sanitizeForLog` 为纵深防御；③ **根 `loading.tsx`（Suspense）与"运行时 DB 查找 + notFound()"的动态详情页冲突**：Suspense 边界会先 flush 200 响应头 + 骨架 shell，等异步页面组件里 `notFound()` resolve 时状态码已无法回退成 404（里程碑 2 首轮冒烟实测 `/cases/[id]`·`/solutions/[id]` 无效 id 全返 200，渲染了 not-found UI 但状态码错，会被 SEO 误收录）。SSG 路由（`generateStaticParams` + `dynamicParams=false`，如 `/industries/[slug]`）在路由器层先判、**免疫**。对取值来自任意 DB id、无法预渲染的详情页，解法是**移除制造提前 flush 的根 `loading.tsx`**（里程碑 2 已删除，重建后无效 id 真 404）；若日后要恢复骨架屏，应改用不覆盖详情段的分段级 loading 或在页内内联骨架，勿放回根级。
- **仍未引入**：Playwright（E2E）、@testing-library/react（组件测试）、msw（HTTP mock）、testcontainers（本机无 Docker）。Phase 5 引入公共页面后补 React 组件测试；Phase 15 补 E2E。
