# ARCHITECTURE — 技术架构

来源：总控 Prompt 第7、16、17、31–32 节；受宪法第14（模型解耦）、15（成本）、27（更简单优先）约束。

## 1. 选型原则

优先：**简单、稳定、低成本、可维护、可扩展、适合个人开发者**（总控第7节）。当更先进方案明显增加开发/维护/运营复杂度时，选更简单的（宪法第1条）。禁止偷偷更换技术栈、禁止增加不必要依赖（总控第26节）。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | Next.js 16（App Router）+ React 19 + TypeScript | 已由 create-next-app 生成 |
| UI | Tailwind CSS v4 + shadcn/ui（计划引入） | 组件按需引入，避免重型 UI 库 |
| 后端 | Next.js Server Actions / Route Handlers（API） | 单体全栈，避免过早微服务（宪法第2条） |
| 数据库 | PostgreSQL + Prisma 6 ORM | 结构化数据（宪法第12条）；`String[]`/`Json` 依赖 PG |
| 向量 | pgvector（计划） | 语义搜索/去重/匹配；V1 先用 PG 全文检索，后增强 |
| 对象存储 | 兼容 S3 的对象存储（待定供应商） | 企业文件、导出 PDF、附件；须访问控制 |
| 认证 | 成熟托管方案（倾向 Auth.js 或托管 Auth，待创始人定） | 不自行造轮子（总控第7节） |
| 部署 | Serverless / 低运维优先（如 Vercel + 托管 PG） | 个人开发者可维护 |
| AI | 统一 **Model Router**，核心模型 Qwen3.8-Max | 见第4节 |

## 3. 系统分层（单体，模块化）

```
Next.js App (App Router)
├── app/                     # 路由与页面（公共 / 用户 / admin）
├── components/              # UI 组件（shadcn/ui + 业务组件）
├── server/
│   ├── db/                  # Prisma client、查询封装
│   ├── services/            # 业务服务（case/solution/order/diagnosis...）
│   ├── actions/             # Server Actions（表单/变更入口）
│   └── api/                 # Route Handlers（对外/回调/webhook）
├── ai/
│   ├── router/              # Model Router（唯一模型出入口）
│   ├── agents/              # 12 个 Agent（见 AI_WORKFLOW.md）
│   ├── prompts/             # Prompt 仓库（DB 驱动，不硬编码）
│   └── schemas/             # 各 Agent 输入/输出 JSON Schema（校验用）
├── jobs/                    # 每日流水线编排（发现→…→QA→Draft）
└── lib/                     # 工具：日志、错误、成本核算、许可证检查
```

原则：业务代码**只能**通过 Model Router 调模型，**不得**直接依赖具体模型（宪法第14条 / 总控第16节）。

## 4. Model Router（模型解耦）

统一接口（总控第16节）：

```ts
// ai/router/index.ts （示意，最终以代码为准）
interface ModelRouter {
  generateText(req: TextReq): Promise<TextRes>;
  structuredOutput<T>(req: StructuredReq, schema: JSONSchema<T>): Promise<T>; // 必须过 schema 校验
  research(req: ResearchReq): Promise<ResearchRes>;   // 带来源
  embedding(req: EmbedReq): Promise<number[]>;
  vision(req: VisionReq): Promise<VisionRes>;
  code(req: CodeReq): Promise<CodeRes>;
}
```

- 模型名/密钥只在 Router 与配置层出现，业务层通过"任务类型/能力等级"请求，不写死 `qwen3.8-max`（总控第7节明确禁止硬编码模型名）。
- 供应商可切换：Qwen / DeepSeek / GLM / Kimi / 其他兼容模型（宪法第14条）。
- **成本路由策略**（总控第32节）：简单任务→低成本模型；普通任务→中等模型；复杂研究→Qwen3.8-Max；核心财务/项目判断→Qwen3.8-Max + 程序计算 + QA。不要所有任务都用最贵模型。
- 每次调用记录 `model / tokens / estimated_cost / latency / status`（宪法第15条 / 总控第31节），后台可按 日/Agent/案例/方案 聚合成本。

## 5. 生成管线（结构化中间格式）

所有内容生成走：**结构化 JSON（中间格式）→ HTML → Web 页面**，后续可 HTML → PDF（总控第17节）。

```
Agent 输出(JSON, 过 Schema 校验) → 存入 DB(solutions.body 等) → 渲染层(JSON→React/HTML) → 页面 → (可选)导出 PDF
```

禁止让 LLM 直接产出整页 HTML 作为唯一数据源（否则不可校验、不可复用、不可版本化）。

## 6. AI 任务可靠性

- 每个 Agent 必须有：输入 Schema、输出 Schema、成功标准、失败处理、超时处理、Retry、日志（总控第29节）。
- LLM 输出一律做 **Schema Validation**，不直接信任模型返回（总控第29节 / 宪法第6条）。
- 失败重试**最多 3 次**，仍失败进入 `FAILED_REVIEW`，不无限循环烧 API（总控第30节）。
- 关键方案禁止"一个 Agent 自搜自证自发布"，必须走 Research + Bull + Bear + Judge + QA（宪法第8条 / 总控第33节）。

## 7. 数据与版本化

- 一切内容实体版本化：`version / created_at / created_by / change_summary`，方案不得被直接覆盖（宪法第13条 / 总控第12节）。落地见 DATABASE.md 的 `*_versions` 与 `audit_logs`（`ChangeLog`）。
- 关键数字（成本/ROI/IRR/回收期等）由**程序计算**，LLM 不口算；结果附来源、公式引用、可修改假设（宪法第7条）。

## 8. 安全与密钥（详见 SECURITY.md）

API Key 全部走环境变量，禁止进前端、禁止进 Git；用户/企业数据隔离；企业文件访问控制；后台权限控制；管理员操作写 Audit Log；日志禁止打印密钥/密码/敏感企业资料（总控第13节）。

## 9. 环境现状与架构约束（诚实记录，宪法第20条）

- 本机**无 PostgreSQL、无 Docker**；`npm` 可达但重型依赖（如 Prisma 引擎）下载会 stall；命令行**无法访问 `github.com`**（仅 `api.github.com` 可用，推送经 API 完成）。
- 因此：架构文档与 schema 可离线完成；但 Phase 4 起的"装依赖 / 连库 / 迁移 / 本地跑 dev / 部署"需要相应资源与网络，见 ROADMAP「阻塞与所需资源」。
- 部署若选 Serverless（如 Vercel），注意文件系统只读 → 不能用 SQLite，须用托管 Postgres（这也是选 PG 的原因之一）。
