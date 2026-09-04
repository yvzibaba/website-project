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

## 6. 现状（诚实记录）

- **测试框架尚未引入**：脚手架未含 Vitest/Playwright，本仓库当前仍无可运行测试；Phase 4 将引入测试框架与首个冒烟测试。
- **依赖与 schema 校验已跑通**：`npm install` 成功（npmmirror 源 + Prisma 引擎镜像，393 包）；`prisma validate` 通过（`The schema at prisma\schema.prisma is valid`）；`prisma migrate diff --from-empty` 已离线生成首迁移 `0_init/migration.sql`。
- 其余已完成的"验证"：远端文件存在性/提交历史（经 api.github.com 核对）、schema 人工结构复核。
- **仍阻塞**：`prisma migrate deploy` 与任何连库集成测试需要可连接的 PostgreSQL（本机无 Postgres/Docker），待托管库 `DATABASE_URL` 就绪。
