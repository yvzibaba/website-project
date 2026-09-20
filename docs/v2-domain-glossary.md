# V2 领域术语表（Domain Glossary）

> 本文件是 **V2 产品语义的单一术语源**。P1 起，所有新增代码、用户可见文案、文档、报告一律以本表为准。
> 本表**只做语义定义与引用治理**，不授权任何全仓库机械替换。

- 版本：`1.0.0`（P1 起始冻结）
- 生效范围：`kernel/`、`src/`（新代码与新文案）、`docs/`（新文档）
- 治理原则：**英文标识符按域语义命名；中文用户文案用 V2 标准语义；历史资产按下列 A–F 分类分别处置**

---

## 1. 术语映射（权威表）

| 旧语义（V1） | V2 标准语义 | 英文代码语义 | 历史保留 |
| --- | --- | --- | --- |
| 沙盘 | 项目决策工作台 | `ProjectWorkbench` / `DecisionWorkbench` | 仅历史 |
| 沙盘模型 | 项目决策计算模型 | `ProjectModel` / `DecisionEngine` | 仅历史 |
| 沙盘场景 | 项目情景 | `Scenario` | 仅历史 |
| 沙盘报告 | 决策报告 | `DecisionReport` | 仅历史 |
| 沙盘项目 | 项目 | `Project` | 仅历史 |
| 沙盘计算 | 项目计算 | `Calculation` | 仅历史 |
| 沙盘参数 | 项目参数 / 情景输入 | `ScenarioInput` / `ProjectParams` | 仅历史 |
| 沙盘结论 | 决策结论 | `Decision` | 仅历史 |
| 沙盘版本 | 项目版本 | `ProjectVersion` | 仅历史 |

### V2 新增核心术语（P1 起为规范用语）

| V2 术语 | 英文 | 含义 |
| --- | --- | --- |
| 项目 | `Project` | 一个真实场站项目的容器（选址 + 需求 + 配置 + 决策） |
| 情景 | `Scenario` | 一组**可复算的输入假设**（`ScenarioInput`），不是页面上的数字 |
| 情景定义 | `ScenarioDefinition` | 声明式组合（PV/BESS/Grid/Charging/Swap/Tariff/TruckDemand），**不硬编码场景名** |
| 计算 | `Calculation` | 生产计算引擎跑一次输入得到的确定性结果 |
| 计算引擎 | `CalculationEngine` | 唯一生产计算核心（纯函数、确定性、可复算、可版本化） |
| 重卡需求 | `TruckDemand` | 由车队参数推导的能源需求（日/月/年 + 15 分钟充电负荷） |
| 充电需求 | `ChargingDemand` | 由重卡需求与充电策略推导的站点负荷曲线 |
| 充换电方案 | `ChargingSolution` | 充电 / 换电 / 混合的设施配置与运行参数 |
| 能源配置 | `EnergySystem` | 光伏 + 储能 + 电网的组合配置 |
| 能量平衡 | `EnergyBalance` | 逐时段（15 分钟）的能量守恒结果 |
| 能量守恒不变量 | `EnergyBalanceInvariant` | 每时段必须成立的守恒校验 |
| 项目经济性 | `ProjectEconomics` | CAPEX / OPEX / 现金流 / NPV / IRR / 回收期 |
| 决策 | `Decision` | 可行性 + 推荐配置 + 经济结果 + 关键驱动 + 敏感性 + 风险 + 关键假设 + 解释 |
| 决策报告 | `DecisionReport` | 可审计、可复算、可留档的报告 |
| 基准参数 | `Benchmark` | 行业/地区基准（带来源、时点、置信度、区间） |
| 实测数据 | `Actuals` | 项目落地后的真实运行/投资数据回流 |
| 未知 | `Unknown` | 未核实且不得偷填的参数状态 |

---

## 2. 引用治理分类（A–F）

处置所有权：**A/B 是本阶段（P1）的责任；C/D/E/F 本阶段不动。**

### A. 用户可见 V2 产品文案 → **使用新术语**
- 新建页面、面板、报告、按钮、提示、错误信息一律使用 V2 术语（项目 / 情景 / 决策 / 报告 / 工作台）。
- 不得在一级导航出现「沙盘」。
- 须通过 `tests/unit/de-jargon-guard.test.ts`（公开界面不得出现内部黑话）。

### B. 新代码命名 → **使用新术语**
- 模块名、类型名、函数名、常量名、路由、JSON 字段一律按上表英文语义命名。
- 统一时间粒度常量只允许一处定义（`kernel/src/engine/time.ts`）。
- 生产计算入口只允许一处（`kernel/src/engine/engine.ts`）。

### C. 历史测试 / 审计 / 兼容数据 → **暂时保留**
- `tests/**` 中针对 V1 内核（`projectModel` / `tech` / `storageValue` 等）的既有断言与夹具**保持原样**。
- `docs/**` 中已归档的审计/验收报告保持原样（改写历史记录 = 造假）。
- 历史 fixture 中的 `model@1.0.0` / `sandboxSource` 等**取值**不得改动。

### D. 数据库存量值 → **本阶段不得擅自修改**
- `Project` / `ProjectScenario` / `ProjectVersion` 既有行的 `paramLayers` / `calcResult` 等 JSON 存量内容不迁移、不回填、不改写。
- 新增列一律**可空**，旧行保持 `NULL`（读侧按「无 V2 情景输入」处理，绝不臆造）。

### E. 历史 migration → **永久不改**
- `prisma/migrations/20260905140000_add_sandbox_project/` 目录名、文件名、内容永久冻结。
- 新增 schema 变化一律走**新 migration**，绝不编辑已部署迁移。

### F. `schema.prisma` 已失真的旧注释 → **本阶段记录，不单独清理**
- 已知残留：`ProjectScenario.paramLayers` / `paramSnapshot` / `calcResult` 注释中提到的 `resolveSandbox` / `runSandboxModel`。
- 处置：**随 P1 实际修改该 model 时顺手更新**（本阶段会新增列，故一并更新这三行注释）；
  不为纯注释清理制造无业务价值的独立迁移。

---

## 3. 与「沙盘」历史中文词的关系

- **不做事后全仓库中文替换**。理由：中文「沙盘」大量出现在历史审计文档、已归档报告、V1 组件内部注释中；
  机械替换会污染历史记录且无法审计。
- 中文「沙盘」的清理范围仅限 **A 类**（用户可见 V2 产品文案）。
- 面向用户的 V1 页面若在 P4 被淘汰，其文案随淘汰一并消失，无需单独清洗。

---

## 4. 强制约束（引用本表即可断言）

1. 任何新增的**生产计算**只能在 `kernel/src/engine/` 内实现，且只能通过 `runCalculation()` 暴露。
2. UI / API / 报告 **不得**自行实现公式；只允许调用生产引擎并渲染其结果。
3. 参数必须区分五类值域：`BENCHMARK` / `SCENARIO` / `DERIVED` / `ACTUAL` / `UNKNOWN`（见 `kernel/src/engine/benchmark.ts`）。
4. 关键参数缺失时**标 UNKNOWN 并诚实声明**，不得以 0 / 全国平均 / 历史旧值偷填。
5. 统一时间粒度：**15 分钟**（`TIME_STEP_MINUTES = 15`），所有模块共用同一时间轴。
