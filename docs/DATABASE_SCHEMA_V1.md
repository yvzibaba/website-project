# 产业能力数据库 V1 — Schema 设计说明

> 本文档是 [`prisma/schema.prisma`](../prisma/schema.prisma) 的设计依据与决策记录。
> 严格遵循项目宪法 [`docs/PROJECT_RULES_V2.md`](./PROJECT_RULES_V2.md)。
> 版本：v1.0　创建时间：2026-09-04　状态：待人工确认关键假设后进入实现。

## 1. 目标与范围

本数据库不是"内容网站的文章库"，而是**结构化的产业能力数据库**（宪法第12条）。V1 只覆盖核心商业闭环所需的最小实体集：

案例发现 → 案例拆解 → 技术能力拆解 → 开源/GitHub 匹配 → 中国本土化重构 → 产业解决方案 → 查看 → 购买。

按宪法第2/26条（MVP、不提前复杂化），以下**明确延后到 V2+，V1 不建表**：企业适配（V2）、POC（V3）、项目机会发现与项目结果（V4+）、社区/融资/交易/会员/App/知识图谱。

## 2. 技术选型（已确认决策）

- **ORM / 存储**：Prisma + PostgreSQL。选 Postgres 是因为需要原生数组 `String[]` 与 `Json` 字段来结构化保存（宪法第12条），且生产可部署（Vercel/Neon/自建），本地开发亦可连本地 Postgres。
- **购买模型**：单份解决方案**一次性购买**（`Order` 实体最小实现，支付渠道字段先预留，V1 不接真实支付网关也可跑通闭环的"下单"环节）。
- **实体范围**：12 个 V1 核心实体 + 1 张 `ChangeLog` 审计表。

## 3. 实体与关系

参照数据：`Region`（地区）、`Market`（市场）。

核心链路：

- `Case`（案例）：漏斗状态 `stage` 对应宪法第22条 60→20→10→3→1；带 `opportunityScore` / `evidenceConfidence`（第9条）。
- `Evidence`（证据）：每条重要结论一行，`type` 严格区分 **FACT/ASSUMPTION/INFERENCE/PREDICTION**（第6条），带 `sourceUrl` + `confidence`。
- `BusinessModel`（商业模式）：`revenueStreams` / `costStructure`。
- `TechCapability`（技术能力）↔ `Case` 多对多（`CaseCapability`，带 `relevance`）——技术能力拆解。
- `OpenSourceProject`（开源项目）↔ `TechCapability` 多对多（`CapabilityProject`，带 `fitScore`）——开源匹配。含 `licenseType` + `licenseReviewStatus`（第11条：UNKNOWN/GPL/AGPL/PROPRIETARY 默认 `NEEDS_HUMAN_REVIEW`）、`dependencyChecked`/`securityChecked`/`tested`。
- `Localization`（中国本土化）：关联 `Case` + `TechCapability`，`adaptations`/`constraints`；通过 `LocalizationSupplier` 关联 `Supplier`（中国供应商）。
- `Solution`（产业解决方案，可售）：`slug` 唯一、`body` 为 `Json` 结构化正文、`status` 草稿/人工审核/已发布；带 `opportunityScore`/`evidenceConfidence`/`unknownVariableCount`（第9条）、`riskDomains`/`needsProfessionalReview`（第10条"需要专业人工确认"）。
- `SolutionFinancial`（财务）：CAPEX/OPEX/收入/ROI/IRR/回收期，**全部配 `assumptions`(Json) + `calcRef` + `sourceUrl`**（第7条：来源可追溯、公式可复算、假设可改、程序计算 > 口算）。
- `UnknownVariable`（关键未知变量）：`name`/`impact`/`howToResolve`/`severity`（第9条：禁止高评分掩盖高不确定性）。
- `Order`（购买订单）：`amount`/`currency`/`status`/`buyerType`，支付字段预留。

跨实体版本化（第13条）：所有内容实体带 `version` + `createdAt` + `updatedAt`；`ChangeLog` 记录 `entityType/entityId/action/changedBy/reason/before/after`，支持审计与回滚。**约定：任何对生产数据的修改不得直接覆盖，须写 ChangeLog。**

## 4. 字段级设计原则映射

| 宪法条款 | 落地字段 |
|---|---|
| 第6条 事实/假设/推断/预测 | `Evidence.type` |
| 第7条 数字可复算 | `SolutionFinancial.assumptions/calcRef/sourceUrl`、`Market.sizeEstimate/sourceUrl/confidence` |
| 第9条 不确定性 | `Case/Solution.opportunityScore + evidenceConfidence`、`UnknownVariable` |
| 第10条 高风险人工确认 | `Solution.riskDomains + needsProfessionalReview` |
| 第11条 许可证复核 | `OpenSourceProject.licenseType + licenseReviewStatus + *Checked + tested` |
| 第12条 结构化 | `Solution.body:Json`、各处 `String[]`、实体拆分而非长文 |
| 第13条 版本化 | 全实体 `version` + `ChangeLog` |

## 5. 假设（Assumptions，可被推翻）

- **币种**：默认 `CNY`，`Currency` 枚举预留 `USD`。
- **语言**：中文优先；标题/摘要预留 `titleEn/summaryEn` 双语列，正文双语暂不拆分。
- **地区**：`Region.country` 默认 `CN`（本土化聚焦中国），但案例来源可为全球。
- **金额精度**：`Decimal(12,2)`；CAPEX/OPEX 用 `Decimal(14,2)`；比率 `Decimal(8,4)`。
- **ID**：统一 `cuid()` 字符串主键（对 URL/日志友好，避免自增暴露业务量）。

## 6. 关键未知变量（Unknowns，需人确认——第9条）

1. **正文结构**：`Solution.body` 的 Json 分节 schema 尚未定义（需先定"解决方案生产原则"第23条那 14 个问题的固定小节结构）。影响前端渲染与 QA 校验。
2. **多币种/汇率**：是否需要自动汇率换算与多币种定价，还是仅人工录入。
3. **权限与多租户**：V1 是否有后台多用户/角色（AI 写入 vs 人工审核 vs 客户查看），当前 schema 未含 User/Role/Session。
4. **评分算法**：`opportunityScore` / `evidenceConfidence` 的计算口径未定（应由程序计算，非模型口算——第7条），需要单独的评分脚本与公式文档。
5. **Prisma 版本**：`package.json` 暂锁 `^6`；若环境最新为 v7，需相应升级并复验 schema。

## 7. 如何运行（下一步，尚未执行）

```bash
# 1. 安装依赖（会触发 postinstall: prisma generate）
npm install
# 2. 准备 Postgres 并设置环境变量
export DATABASE_URL="postgresql://user:pass@host:5432/industry_db?schema=public"
# 3. 生成迁移并应用到数据库
npm run db:migrate      # 开发环境
# 或 npm run db:push    # 快速同步（无迁移历史）
# 4. 可视化查看
npm run db:studio
```

> 注意：本机命令行当前无法访问 `github.com`（详见会话记录），但可访问 `api.github.com` 与 npm 源；`npm install` 与 Postgres 连接需在具备相应网络/数据库的环境执行。

## 8. 变更记录

- v1.0（2026-09-04）：初版 V1 数据模型，12 核心实体 + ChangeLog，Prisma + Postgres，单份购买模型。等待人工确认第6节未知变量后进入迁移实现。
