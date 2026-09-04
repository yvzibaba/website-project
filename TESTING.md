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
- **单元测试基线**（`tests/unit/`，44 cases，416ms）：
  - `errors.test.ts`（19）— AppError 状态码映射 / 序列化 / cause 保留 / isAppError 跨 realm / toErrorResponse Prisma P2002 P2025 P#### 映射 / 生产屏蔽原始 message。
  - `logger.test.ts`（15）— JSON 单行 / level 阈值 / silent / stdout-stderr 分流 / 敏感字段脱敏（顶层 + 深层嵌套 + 数组）/ Error 序列化 / 循环引用 / child bindings / __redact 边界（Date / BigInt / Function）。
  - `env.test.ts`（10）— Zod 校验 DATABASE_URL / NODE_ENV / LOG_LEVEL / NEXT_PUBLIC_SITE_URL / 缓存单例 / 各失败分支 / 多字段错误汇总。用 `vi.stubEnv`（@types/node v22 把 NODE_ENV 声明为只读）。
- **集成测试**（`tests/integration/db-smoke.test.ts`，5 cases，8.24s，真连 Neon）：SELECT 1 / Region 全 CRUD / 11 枚举存在性 / 17 表存在性 / `_prisma_migrations` 记录检查。afterAll 双兜底清理。DATABASE_URL 缺失时 `describe.skip` 而非 fail，允许 CI 无库跑单元测试。
- **构建验证**：`tsc --noEmit` 0 错误；`next build`（Turbopack）成功，产出 `ƒ /` / `○ /_not-found` / `ƒ /api/health` 三路由。
- **HTTP 端到端冒烟**：`next start -p 3111` 起服后 `GET /api/health` → 200 且 `db.ok:true`（首查 3.6s 含 Neon 冷启动）；`GET /` → 200，22129 字节含实时表计数；`GET /definitely-not-here` → 404 含中文提示。
- **仍未引入**：Playwright（E2E）、@testing-library/react（组件测试）、msw（HTTP mock）、testcontainers（本机无 Docker）。Phase 5 引入公共页面后补 React 组件测试；Phase 15 补 E2E。
