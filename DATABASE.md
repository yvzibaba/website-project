# DATABASE — 数据库 ER 设计

来源：总控 Prompt 第12节（数据表清单）、第10–11节（评分/证据等级）、第14节（许可证）、第15节（Prompt 库）、第31节（成本）；宪法第6/7/9/11/12/13 条。
现状：V1 核心 12 实体 + `ChangeLog` 已落在 [`prisma/schema.prisma`](./prisma/schema.prisma)（提交 `66fbec5`），设计说明见 [`docs/DATABASE_SCHEMA_V1.md`](./docs/DATABASE_SCHEMA_V1.md)。本文件给出**全量目标 ER + 分层落地计划**，并做两者的对齐与差异说明。

存储：PostgreSQL + Prisma。金额 `Decimal`，多值 `String[]`，结构化内容 `Json`，向量后续 `pgvector`。

## 1. 领域分组与表清单（对齐总控第12节，标注层级与当前状态）

层级：**V1-A** = 核心闭环先做；**V1-B** = 闭环稳定后紧接；**V2+** = 延后。状态：✅ 已在 prisma / 🟡 部分 / ⬜ 待建。

### A. 身份与组织
| 目标表(总控) | 本项目实体 | 层级 | 状态 | 说明 |
|---|---|---|---|---|
| users | `User` | V1-A | ⬜ | 下单需身份，最小认证 |
| user_profiles | `UserProfile` | V1-A | ⬜ | 昵称/偏好/收藏计数 |
| organizations | `Organization` | V1-B | ⬜ | 企业主体 |
| companies | `Company` | V1-B | ⬜ | 具体公司/工厂 |
| enterprise_profiles | `EnterpriseProfile` | V1-B | ⬜ | 企业资源画像（诊断输入） |

### B. 产业与案例
| 目标表 | 本项目实体 | 层级 | 状态 | 说明 |
|---|---|---|---|---|
| industries | `Industry`(枚举)+`IndustryPage` | V1-A | 🟡 | 六大行业；`IndustryPage` 存 SEO/落地页文案 |
| cases | `Case` | V1-A | ✅ | 漏斗 stage、评分、可信度 |
| case_sources | `Evidence` | V1-A | ✅ | 规则6：事实/假设/推断/预测 + 来源 + 置信 |
| case_modules | `CaseCapability`(连接) | V1-A | ✅ | 案例↔技术能力（拆解） |
| evidence_items | `Evidence` | V1-A | ✅ | 与 case_sources 合并为统一证据表（含证据等级 S/A/B/C/D，见 §3） |
| project_opportunities | `ProjectOpportunity` | V1-B | ⬜ | 项目机会池（等级 C/B/A/S，S 默认不公开，总控第35节） |
| project_status_logs | `ProjectStatusLog` | V2+ | ⬜ | 项目状态流转 |

### C. 技术与开源
| 目标表 | 本项目实体 | 层级 | 状态 | 说明 |
|---|---|---|---|---|
| technologies | `TechCapability` | V1-A | ✅ | 技术能力（AI/软件/算法/自动化/数据/硬件/工程） |
| technology_modules | `TechCapability`(category) | V1-A | 🟡 | 用 category 承载模块划分 |
| github_projects | `OpenSourceProject` | V1-A | ✅ | repo/license/stars/检查项 |
| github_project_versions | `OpenSourceProjectSnapshot` | V1-B | ⬜ | 项目元数据随时间快照（活跃度追踪） |
| licenses | `LicenseType`(枚举)+复核状态 | V1-A | ✅ | 规则11：UNKNOWN/GPL/AGPL→人工复核 |
| products | `Product` | V1-B | ⬜ | 商业软件/设备/产品目录 |

### D. 供应链与本土化
| 目标表 | 本项目实体 | 层级 | 状态 | 说明 |
|---|---|---|---|---|
| suppliers | `Supplier` | V1-A | ✅ | 中国供应商 |
| （本土化） | `Localization` + `LocalizationSupplier` | V1-A | ✅ | 本土化重构与供应商关联 |
| （地区/市场） | `Region` / `Market` | V1-A | ✅ | 参照数据 |

### E. 解决方案（可售商品）
| 目标表 | 本项目实体 | 层级 | 状态 | 说明 |
|---|---|---|---|---|
| solutions | `Solution` | V1-A | ✅ | slug、status、评分、可信度、风险标记 |
| solution_modules | `Solution.body`(Json 分节) | V1-A | 🟡 | 34 部分结构化分节，规范待定（§4 开放项1） |
| solution_sources | `Evidence`(polymorphic) 或 `SolutionSource` | V1-A | 🟡 | 方案级来源；V1 复用 Evidence 或新增关联表 |
| solution_versions | `SolutionVersion` | V1-A | ⬜ | 方案不可覆盖，每次改版留版本（规则13） |
| （财务） | `SolutionFinancial` | V1-A | ✅ | CAPEX/OPEX/ROI/IRR/回收期 + 假设 + calcRef |
| （未知变量） | `UnknownVariable` | V1-A | ✅ | 规则9 |

### F. 交易
| 目标表 | 本项目实体 | 层级 | 状态 | 说明 |
|---|---|---|---|---|
| orders | `Order` | V1-A | ✅ | 单份一次性购买 |
| order_items | `OrderItem` | V1-B | ⬜ | 多商品/多方案订单时启用；V1 单商品可暂并入 Order |
| payments | `Payment` | V1-A | ⬜ | 最简支付确认：支付说明/链接→后台确认→解锁；预留微信/支付宝/对公/发票 |

### G. 企业诊断（V1-B）
| 目标表 | 本项目实体 | 层级 | 状态 |
|---|---|---|---|
| diagnosis_sessions | `DiagnosisSession` | V1-B | ⬜ |
| diagnosis_inputs | `DiagnosisInput` | V1-B | ⬜ |
| diagnosis_results | `DiagnosisResult` | V1-B | ⬜ |

### H. AI 运营与治理
| 目标表 | 本项目实体 | 层级 | 状态 | 说明 |
|---|---|---|---|---|
| ai_tasks | `AiTask` | V1-A | ⬜ | 任务：类型/状态/成本/重试 |
| ai_task_runs | `AiTaskRun` | V1-A | ⬜ | 每次运行：model/tokens/cost/latency/status |
| agents | `Agent` | V1-A | ⬜ | Agent 定义与配置 |
| agent_runs | `AgentRun` | V1-A | ⬜ | Agent 执行记录（输入/输出/日志） |
| prompts | `Prompt` | V1-A | ⬜ | Prompt 库（总控第15节字段） |
| prompt_versions | `PromptVersion` | V1-A | ⬜ | 版本/回滚/A-B |
| quality_reviews | `QualityReview` | V1-A | ⬜ | QA 结果与门禁（低于阈值退回） |
| audit_logs | `ChangeLog`(审计) + `AuditLog`(管理员操作) | V1-A | 🟡 | 现有 ChangeLog 覆盖数据变更；管理员操作审计待补 `AuditLog` |
| system_settings | `SystemSetting` | V1-A | ⬜ | 阈值、开关、调度时间等 |

> 说明：总控第12节要求"至少"这些表；本项目按宪法 MVP 原则**分层落地**，不一次性建满 37 张空表（宪法第2条：不为"看起来像大平台"而开发）。V1-A 集合足以跑通"案例→方案→购买 + AI 生产治理"。

## 2. 核心关系（V1-A）

```
IndustryPage 1─N Case
Case 1─N Evidence(事实/假设/推断/预测, 证据等级 S/A/B/C/D)
Case N─N TechCapability        (CaseCapability, relevance)
TechCapability N─N OpenSourceProject (CapabilityProject, fitScore; 含 license 复核)
Case 1─N Localization ─N Supplier (LocalizationSupplier)
Case 1─N Solution
Solution 1─N SolutionFinancial / UnknownVariable / SolutionVersion
Solution 1─N Order 1─N Payment
User 1─N Order
AiTask 1─N AiTaskRun ; Agent 1─N AgentRun ; Prompt 1─N PromptVersion
QualityReview ─1 Solution/Draft
ChangeLog / AuditLog：多态记录(entityType, entityId, before, after, action, changedBy, reason)
```

## 3. 证据等级与评分（总控第10–11节，规则6/9）

- **证据等级**（`Evidence.grade`，待补字段）：S 政府/法规/原始论文/企业原始披露/审计；A 权威机构/上市年报/专业库；B 行业媒体/报告；C 普通二手；D AI 推断。**仅 D 级不得表述为已确认事实，必须标"AI 推断/待验证"。**
- **案例评分 100 分**（`Case.opportunityScore` 的构成，程序计算）：商业价值20 + 市场需求15 + 技术成熟度15 + 中国本土化空间10 + 成本优势10 + 可复制性10 + 供应链成熟度5 + 竞争强度5 + 政策环境5 + 实施难度5。
- 同时输出 **Evidence Confidence**（`evidenceConfidence`）与 **关键未知变量数**（`unknownVariableCount`）。禁止把"综合评分"当成"一定成功"（规则9）。
- 评分算法须落为**可复算程序 + 公式文档**，不得模型口算（规则7）。→ 见 ROADMAP Phase 9 交付物 `scoring/`。

## 4. 开放项（需决策/后续 Phase 定义）

1. **`Solution.body` 34 分节的 JSON schema**（PRODUCT_SPEC §3 列出 34 项）——Phase 8 前必须定稿，它决定渲染与 QA 校验。当前为最大未完成设计。
2. `Evidence.grade`（S/A/B/C/D）字段补入 schema（小改，Phase 7 一并做）。
3. `SolutionVersion` / `Prompt(+Version)` / `AiTask(+Run)` / `Agent(+Run)` / `QualityReview` / `Payment` / `User` / `SystemSetting` / `AuditLog` 的列级设计——按 Phase 逐步补入 prisma，不在本轮一次建满。
4. 多态 `ChangeLog` 是否够用，或每个核心实体各建 `*_versions` 表（倾向：内容实体用 `*_versions` 存全量快照，`ChangeLog` 存轻量审计）。

## 5. 迁移与运行（尚未执行，环境阻塞）

```bash
npm install                                   # 需网络（当前重型依赖下载会 stall）
export DATABASE_URL="postgresql://user:pass@host:5432/industry_db?schema=public"
npx prisma validate                           # 语法/关系校验（本机因引擎下载受阻未跑通）
npm run db:migrate                            # 生成并应用迁移
```

> 诚实状态（宪法第20条）：截至本次提交，`prisma validate` **未在本机跑通**（Prisma 引擎下载 stall），已完成人工结构复核；`db:migrate` 需要可用的 PostgreSQL（本机未安装）。这两项在进入 Phase 4 前必须解决。
