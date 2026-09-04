# SCORING_V1 — 案例评分体系公式与版本记录

> 版本：**1.0.0**（对应 `src/server/scoring.ts` 的 `SCORING_RUBRIC_VERSION`）
> 状态：Phase 7 M1 已实现为纯函数内核 + 26 条黄金样本单元测试锁定；持久化/详情页拆解见 M2。
> 归属：本文档是评分口径的**单一事实源**。改任何权重/系数/公式，必须先改这里、升版本号、同步改黄金样本测试（宪法第 13 条：版本化 + 可回滚）。

## 0. 为什么有这份文档（宪法第 6 / 7 条）

在此之前，`Case.opportunityScore`、`Case.evidenceConfidence`、`Solution.unknownVariableCount` 只是几个手填/种子写入的 `Int?` **魔数**：无法复算、无法审计、假设变了也不知道影响了谁。宪法第 7 条要求"关键数字须来源可追溯 + 公式可复算 + 假设可改，程序计算 > LLM 口算"。本模块把总控 Prompt §10「案例评分体系」落成**可复算程序**，并在本文档里把每个数字明确标注为下列四类之一（宪法第 6 条）：

- **【事实】**：直接照抄总控 Prompt / 数据库设计的既有规定，不是我发明的。
- **【假设】**：本项目 v1 的设计选择，总控未给死，可调，改动须升版本。
- **【推断】**：由事实/假设推导出的结论。
- **【预测】**：对未来的估计。

铁律（总控 §10 原文 / 规则 9）：**禁止把"综合评分"理解成"项目一定成功"**。评分只表达"机会相对优先级 + 证据强度"，必须与 `evidenceConfidence`、`unknownVariableCount` 一起呈现，任何页面/方案都不得单独拿高分当成功承诺。

---

## 1. 机会评分（Opportunity Score，0–100）

### 1.1 维度与权重【事实 — 照抄总控 Prompt §10】

总控 §10 原文规定"建立 100 分评分系统"，10 个维度权重如下（`OPPORTUNITY_DIMENSIONS` 逐字实现，max 之和恰为 100，用 `reduce` 计算而非硬编码，防维度改动后失真）：

| # | key | 维度 | max | 极性 |
|---|---|---|---|---|
| 1 | commercialValue | 商业价值 | 20 | positive |
| 2 | marketDemand | 市场需求 | 15 | positive |
| 3 | techMaturity | 技术成熟度 | 15 | positive |
| 4 | localizationSpace | 中国本土化空间 | 10 | positive |
| 5 | costAdvantage | 成本优势 | 10 | positive |
| 6 | replicability | 可复制性 | 10 | positive |
| 7 | supplyChainMaturity | 供应链成熟度 | 5 | positive |
| 8 | competitionIntensity | 竞争强度 | 5 | **inverse** |
| 9 | policyEnvironment | 政策环境 | 5 | positive |
| 10 | implementationDifficulty | 实施难度 | 5 | **inverse** |

**权重本身是【事实】**（照抄总控）。**"哪两个维度是反向"是【假设/设计】**（总控只列了权重，没规定录入方向）——见 1.2。

### 1.2 反向极性设计【假设 — 本项目设计选择，可调】

`竞争强度` 与 `实施难度` 本质是"负面强度"：竞争越激烈、实施越难 → 机会越低。若按正向录入，人工极易把方向填反（把"竞争白热化"误填成高分反而拉高机会）。因此本模块约定：

- **录入者按直觉填原始分**：竞争强度 `0=无竞争 … 5=白热化`；实施难度 `0=极易 … 5=极难`；正向维度 `0=最差 … max=最好`。
- **程序负责反向**：`inverse` 维度的贡献 `contribution = max - raw`；`positive` 维度 `contribution = raw`。

由此推出三条**必须记住的边界**（已被黄金样本测试锁定）：

- 最优（正向=max、反向=0）→ **100**
- 全维度都填 max（含反向也填 max）→ **90**（两个反向维度贡献归零，**不是 100**）
- 全维度都填 0 → **10**（仅两个反向维度各贡献其 max=5）

### 1.3 公式【推断 — 由 1.1 事实 + 1.2 假设推导】

```
contribution_i = (polarity_i == inverse) ? (max_i - raw_i) : raw_i
opportunityScore = Σ contribution_i        # 恒在 0..100
```

入参经 `OpportunityInputSchema`（Zod）校验：每个维度必须是 `0..max` 的**整数**。非法（缺维度/越界/非整数）→ 返回 `{ok:false, issues:[...]}` 并**逐条指名维度**，绝不静默截断（诚实优先，宪法第 20 条）。

### 1.4 工作样例 → 88【推断 — 可复算】

| 维度 | raw | 极性 | contribution |
|---|---|---|---|
| 商业价值 | 19 | positive | 19 |
| 市场需求 | 14 | positive | 14 |
| 技术成熟度 | 13 | positive | 13 |
| 中国本土化空间 | 9 | positive | 9 |
| 成本优势 | 9 | positive | 9 |
| 可复制性 | 9 | positive | 9 |
| 供应链成熟度 | 4 | positive | 4 |
| 竞争强度 | 1 | inverse | 5-1 = 4 |
| 政策环境 | 3 | positive | 3 |
| 实施难度 | 1 | inverse | 5-1 = 4 |
| **合计** | | | **88** |

**交叉验证【事实】**：总控 §10 给的示例"综合价值：88/100"与本样例结果一致——说明本公式能复现总控作者的示范数值（这是选这组 raw 的原因）。

---

## 2. 证据可信度（Evidence Confidence，0–100）

### 2.1 重要前提【事实 + 假设标注】

总控 §10 **只给了示例值**（"证据可信度：72/100"）**没有给公式**。因此本节的整套算法是**本项目 v1 假设**，非总控硬性规定。所有系数集中在 `EVIDENCE_TYPE_WEIGHTS` / `EVIDENCE_CONFIDENCE_PARAMS` 两处常量，可调；改动须升 `SCORING_RUBRIC_VERSION` 并在 §6 记录原因。**不声称 72 是可复现目标**——那是总控的一个示例数字，本公式产出的是"结构一致、可复算、可校准"的可信度，具体数值取决于证据集。

### 2.2 证据类型权重【假设 — v1，呼应宪法第 6 条分层】

证据的 `type` 取自 prisma `EvidenceType` 枚举（FACT / ASSUMPTION / INFERENCE / PREDICTION）。类型权重体现"事实最强、预测最弱"：

| type | 权重 w |
|---|---|
| FACT | 1.0 |
| ASSUMPTION | 0.5 |
| INFERENCE | 0.4 |
| PREDICTION | 0.3 |

### 2.3 其他系数【假设 — v1】

- `unsourcedFactor = 0.6`：证据无 `sourceUrl` 时打 0.6 折（无来源的结论更不可信，呼应总控 §11「D 级=AI 推断不得当已确认事实」的精神）。
- `defaultConfidence = 50`：证据未填 `confidence` 时的缺省可信度（中性偏低）。

### 2.4 公式【假设 — v1】

对每条**合法类型**的证据 i：

```
w_i  = 类型权重（2.2）
q_i  = clamp(confidence_i ?? defaultConfidence, 0, 100) / 100
sf_i = (sourceUrl 非空) ? 1 : unsourcedFactor

evidenceConfidence = round( 100 · Σ(w_i · q_i · sf_i) / Σ(w_i) )
证据为空 → 0            # 诚实：没有证据就没有可信度
未知 type → 跳过        # 防御脏数据，绝不静默当 FACT
```

**性质【推断】**：单条证据时类型权重 w 在分子分母中约掉，结果只由 `q·sf` 决定（黄金样本已锁定：单条 FACT conf=100 无来源 = 单条 PREDICTION conf=100 无来源 = 60）。类型权重只在**多条混合**时才拉开差距。

### 2.5 工作样例 → 69【推断 — 可复算】

证据集：`FACT/90/有源`、`FACT/70/有源`、`ASSUMPTION/50/有源`、`PREDICTION/50/无源`。

| 证据 | w | q | sf | w·q·sf |
|---|---|---|---|---|
| FACT 90 有源 | 1.0 | 0.90 | 1.0 | 0.900 |
| FACT 70 有源 | 1.0 | 0.70 | 1.0 | 0.700 |
| ASSUMPTION 50 有源 | 0.5 | 0.50 | 1.0 | 0.250 |
| PREDICTION 50 无源 | 0.3 | 0.50 | 0.6 | 0.090 |
| **Σ** | **2.8** | | | **1.940** |

`evidenceConfidence = round(100 · 1.94 / 2.8) = round(69.2857) = 69`

---

## 3. 关键未知变量数（unknownVariableCount）

**【假设 — v1】** `= 非 FACT 证据条数`（ASSUMPTION / INFERENCE / PREDICTION 都是"尚未被事实确证"的变量）。呼应宪法第 6 条：把不确定的东西**显式计数、显式暴露**，而不是藏进一个综合分里。总控 §10 示例给"关键未知变量：4 项"，本口径下即"该案例有 4 条非事实型证据"。

---

## 4. 已知缺口 / 待决（诚实记录，宪法第 20 条）

1. **总控 §11 的证据"等级"轴（S/A/B/C/D）— 已建为元数据，暂未并入打分（M4，2026-09-05 创始人裁决「只记录 + 标签，不动分数」）**。§11 按**来源权威性**分级（S=政府/法规/原始论文/审计；A=权威机构/年报/专业库；B=行业媒体/报告；C=普通二手；D=AI 推断），与 §2 的证据**类型**轴（FACT/ASSUMPTION/…）正交。现 prisma `Evidence` 已加可空 `grade EvidenceGrade?` 枚举、`getPublicCaseById` 随证据透出、详情页按等级打标签，且对「D 级」及「被标为事实却仅由 D 级支撑」给出复核告警（呼应 §11「D 级不得表述为已确认事实」）。**但 v1 可信度公式仍不使用 grade**——故 `SCORING_RUBRIC_VERSION` 维持 1.0.0，历史 `scoreBreakdown` 仍有效解析、无需重算。→ **后续待决**：是否把 sf（来源折）从"有无 sourceUrl"升级为按 S/A/B/C/D 取值；若做，属公式形态变更，须走 §5（major/minor 升版 + 黄金样本改 + 历史数据标旧版）。
2. **权重/系数为初始假设，未经真实案例校准**。上线后应用真实案例回测（例如让审核人对若干案例打主观分，与本公式对比），再决定是否调参。调参走 §5 流程。
3. **机会评分的 raw 目前仍需人工/Agent 录入**，本模块只保证"给定 raw → 分数可复算"，不解决"raw 本身是否客观"。raw 的产生（Case Screening / Decomposer Agent）属 Phase 9，须自带证据链接。

---

## 5. 如何修改评分口径（变更流程，宪法第 13 条）

1. 改本文档（写清新值 + **原因** + 影响的样例）。
2. 升 `src/server/scoring.ts` 的 `SCORING_RUBRIC_VERSION`（semver：调系数=patch/minor，改维度结构/公式形态=major）。
3. 同步改 `tests/unit/scoring.test.ts` 的黄金样本期望值（测试是防无声回归的锁）。
4. 跑 `npm run test:unit` 全绿；若已持久化（M2 后）须提供**重算脚本**并对历史数据标注旧版本号，禁止就地覆盖旧分数而不留版本。
5. 在 §6 追加一行版本历史。

---

## 6. 版本历史

| 版本 | 日期 | 变更 | 原因 |
|---|---|---|---|
| 1.0.0 | 2026-09-05 | 首版：机会评分 10 维度（权重照抄总控 §10）+ 反向极性设计 + 证据可信度 v1 公式（类型权重/来源折/缺省值）+ 关键未知变量数。纯函数内核 + 26 黄金样本测试。 | Phase 7 M1：把评分从魔数变成可复算程序（宪法第 7 条）。 |
