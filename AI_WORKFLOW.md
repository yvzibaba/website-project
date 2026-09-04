# AI_WORKFLOW — Agent 架构与每日生产流水线

来源：总控 Prompt 第8、9、23–25、29–33 节；宪法第5、8、15、16 条。
定位（宪法第5条）：**AI 是产业研究系统，不是内容生成器**。工作范式：发现 → 研究 → 验证 → 重构 → 生成 → 审查。禁止"输入问题 → 单模型直接产出最终方案"作为生产流程。

## 1. 十二个 Agent（总控第8节）

| # | Agent | 职责 | 关键约束 |
|---|---|---|---|
| 1 | Case Discovery | 发现全球产业案例（六大行业各约10，共约60） | 关键词+语义+质量+来源可靠性综合，不能只靠关键词（总控第24节） |
| 2 | Case Screening | 初筛是否值得研究，60→20 | 评分维度：商业价值/真实性/可验证性/技术价值/可复制性/中国本土化价值 |
| 3 | Case Decomposer | 深度拆解，20→10 | 商业模式/技术/设备/供应链/成本/客户/收入/资本/政策/成功因素/失败因素 |
| 4 | Technology Matching | 把案例所需拆成 AI/软件/算法/自动化/数据/硬件/工程能力，匹配 GitHub/开源/商业软件/中国供应商 | 输出能力→候选技术/项目 |
| 5 | GitHub Scout | 发现开源项目 | 必查：用途/URL/许可证/商用限制/活跃度/更新/stars/fork/依赖/文档/部署难度/安全风险/SaaS 适用性；**禁止把"开源"等同"可自由商用"**（总控第23节）；禁止镜像整仓，只存必要元数据与合法引用 |
| 6 | China Localization | 国外案例→中国市场/供应链/技术/成本/政策/企业 | 产出本土化方案与约束 |
| 7 | Solution Builder | 案例+技术+开源+供应链+中国条件→完整方案 | 输出 34 分节结构化 JSON（PRODUCT_SPEC §3） |
| 8 | Finance | CAPEX/OPEX/收入/毛利/现金流/ROI/回收期/敏感性 | **重要计算必须由程序完成，不能只让模型口算**（宪法第7条/总控第8节） |
| 9 | Bull | 寻找支持方案成立的证据 | — |
| 10 | Bear | 主动找方案为何会失败，重点攻击 市场/技术/成本/政策/供应链/资金/实施周期 | 必须真找反证，不是走过场 |
| 11 | Judge | 综合 Bull/Bear/Evidence/Finance/Technology 形成结论 | — |
| 12 | QA | 检查 来源/数字/逻辑/假设/引用/许可证/事实-推断区分/前后矛盾/重复/幻觉 | 低于质量阈值**自动退回重新研究**（总控第8节） |

## 2. 每日自动流水线（总控第9节）

```
23:00 触发
  → Case Discovery（6 行业 × ~10 = 60 候选）
  → Screening（→20 重点）
  → Deep Research / Decomposer（→10 深度案例）
  → Technology Matching → GitHub Scout → License Check → China Localization
  → Solution Builder → Finance → Bull/Bear → Judge → QA
  → 生成 3 个候选解决方案
  → 最终 Quality Gate → 选出 1 个精品解决方案
  → 保存为 Draft
  → 等待管理员审核（人工批准后发布）
```

发布红线（总控第9节 / 宪法第10条）：**禁止 AI 自动公开发布**涉及重大投资、工程安全、法律、环保、金融或政策敏感的方案；此类方案标 `needsProfessionalReview=true`，必须管理员审核。

## 3. 质量机制（宪法第8条 / 总控第33节）

绝对禁止"一个 Agent 自搜 → 自结论 → 自证明 → 自发布"。关键方案必须经 **Research + Bull + Bear + Judge + QA** 多角色互检。QA 未过阈值 → 退回上游重研（不是直接发布）。

## 4. 可靠性与 Schema 校验（总控第29–30节）

每个 Agent 必须具备：输入 Schema、输出 Schema、成功标准、失败处理、超时处理、Retry、日志。LLM 输出一律经 **Schema Validation** 后才入库/下游消费，不直接信任模型返回。失败最多自动重试 **3 次**，仍失败进入 `FAILED_REVIEW`，禁止无限循环烧 API。

落地：`ai/schemas/*` 定义各 Agent 的 JSON Schema；`ai/agents/*` 每个 Agent 走 Router 的 `structuredOutput(req, schema)`；运行记录写 `agent_runs` / `ai_task_runs`。

## 5. Prompt 管理（总控第15节）

Prompt **不硬编码在业务代码**，存 `prompts` 表：`prompt_id / name / version / purpose / system_prompt / variables / model(能力等级而非写死型号) / temperature / tool_requirements / quality_threshold / created_at / updated_at`；支持 启用/禁用/版本回滚/A-B 测试。修改走 `prompt_versions`（宪法第13条）。

## 6. GitHub 能力自动化（总控第23节）

每日 GitHub Scout 扫描与六大行业相关的新项目/高价值项目，优先主题：Agent、RAG、Research、Browser、OCR、Vision、Optimization、Simulation、Computer Vision、Data Analysis、Knowledge Graph、MCP、Automation、Digital Twin、Industrial AI。
流程：搜索 → 去重 → 评分 → 许可证判断 → 技术匹配 → 保存（Repo URL/License/Stars/Forks/Last Update/Main Language/Use Case/Dependencies/Risk/Commercial Fit）。
许可证（总控第14节 / 宪法第11条）：AGPL / GPL / 未知 / 附加商业限制 → **Require Human Review**，不得自动认定适合商业 SaaS。

## 7. 成本控制（宪法第15条 / 总控第31–32节）

每个 AI 任务记录 `model / tokens / estimated_cost / latency / status`；后台展示 每日 AI 成本 / 每 Agent / 每案例 / 每方案 成本。成本路由：简单→低成本模型，普通→中等，复杂研究→Qwen3.8-Max，核心财务/项目判断→Qwen3.8-Max + 程序计算 + QA。

## 8. 自动化优先级（宪法第16条）

重复执行超过 3 次的人工作业优先考虑自动化，重点：案例搜索/筛选、数据提取、GitHub 搜索、许可证初筛、案例拆解、方案生成、内容生成、SEO、报告质量审查、任务调度、成本统计、日志分析。

## 9. 落地顺序（对应 ROADMAP）

Agent 系统属 Phase 9–10，**依赖** Phase 4（骨架/DB/日志/错误处理）与 Phase 7–8（案例/方案数据层）先就绪。在核心闭环数据层跑通前，不做 Agent 大规模编排（宪法第4条：先跑通再优化）。
