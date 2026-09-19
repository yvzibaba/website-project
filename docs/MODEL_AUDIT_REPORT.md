# MODEL_AUDIT_REPORT — 沙盘经济模型全面代码审计（阶段4 · 第一阶段）

> 生成日期：2026-09-09（Asia/Shanghai）
> 审计范围：内核技术经济与决策模块（`kernel/src/server/**`、`kernel/src/lib/**`）、`src/app/api/workbench/**`、相关 UI 组件。
> 审计纪律：**只报告，不修改核心模型**（开发原则第 1 条）。本报告未触碰任何引擎代码、版本号、黄金样本或迁移。
> 实证方式：临时审计探针 `tests/unit/audit-probe-temp.test.ts`（独立复算 E1–E8 + 假联动实证 + 角点扫描 + 储能寿命 + 龙卷风呈现 + 信任边界，共 **64 项断言全绿**），跑完已按回收站纪律删除，不入库。所有结论均可复现。
> 前置基线：本报告是 `docs/MODEL_CAUSALITY_AUDIT_V1.md`（2026-09-08 因果审计）的**深化与实证确认**，并对 R9.0（储能价值引擎 v0.59.0）之后的当前状态（v0.64.1）重新盘点。

> **阶段4 处置进展补记（2026-09-14，随代码更新滚动维护）**：
> - ✅ **F-2c（需量电价未计入）已接线** —— v0.65.0 经创始人批准"先接需量电价·口径A(装机×利用率)·V1不做削峰"，`region.demandCharge` 进入 E4 购电成本（需量费单列 `demandChargeY1`），MODEL_VERSION 1.1.0→1.2.0，黄金样本有意重录。详见 CHANGELOG [0.65.0]。
> - ✅ **F-2a（chargerUtilization 假联动）已接线** —— 作为口径 A 计费需量的乘数（计费需量=装机总功率×利用率），同批解锁为真实敏感杠杆。
> - ✅ **F-6/F-7 呈现层（龙卷风西方隐喻）已中国化** —— v0.64.3 B1-1：用户可见文案改「关键因素影响力排行」；扫描集已补 demandCharge/chargerUtilization（13 参数）。F-7 剩余项（feedInTariff/carbonPrice/loanRate 入扫描集）待批次3 余项。
> - ⏳ **仍未处置**：F-1/F-1b（layers 未校验·FACT 可伪造，批次1 B1-5）、F-2h（includeStorage 布尔被忽略，批次2）、F-3（TRANSIT 画像矛盾，批次2）、F-2d/e/f/g（landRent/carbonPrice/equityRatio/loanRate 假联动，批次3 余项）、F-4（储能超日历寿命）、F-8（负谷价）、F-11（UI 硬编码）——均待创始人逐项放行。

---

## 0. 一句话结论

**经济模型的数学是正确的**（独立复算逐位吻合，唯一残差是"舍入顺序"这一 P3 口径问题，非计算错误）；**真正的风险不在算错，而在"算了不该算的 / 没算该算的 / 呈现与实际不符 / 入参信任边界过宽"**——即 **8 个参数是假联动（改了不影响结果）**、**1 处企业画像自相矛盾**、**储能超寿命仍计价值**、**龙卷风图呈现值与实际裁剪值不符且扫描集缺中国关键参数**、**layers 入参几乎未校验（客户端可伪造 FACT 来源、可注入时钟）**。这些多为 P1/P2，且**多数属"接线/呈现/校验"改动而非"改经济公式"**，符合"小步提交、不破坏冻结模块"的修复路径。

---

## 1. 输入参数全景（沙盘到底吃哪些参数）

参数单一真源 = `src/server/project-params.ts` 的 `PARAMETER_SPECS`（`PARAMS_VERSION=1.2.0`）：**46 个数值参数 + 1 个布尔（`project.includeStorage`）+ 3 个派生（derived）**。按层分：

| 层 | 代表参数 | 数量级 | 是否进入 E 层计算 |
|---|---|---|---|
| `project.*`（项目规模） | trucksPerDay, chargePerTruck, operatingDays, pvCapacity, storageEnergy, storagePower, chargerCount, chargerUnitPower, chargingPrice | 多数 | **是**（核心） |
| `region.*`（地区/电价） | elecPrice, peakValleySpread, pvEquivalentHours, feedInTariff(政策侧) | — | elecPrice/spread/pvEqHours **是**；**demandCharge / landRent 否** |
| `tech.*`（技术经济） | pvCapex, storageCapex, chargerCapex, 各 OM, 效率, SOC 窗口, 循环/日历寿命, 衰减 | 多 | **是** |
| `policy.*`（政策） | constructionSubsidy, operationSubsidy, feedInTariff | — | construction/operationSubsidy **是**；**carbonPrice 否** |
| `finance.*`（财务） | discountRate, projectLife, inflation, taxRate, residualValue | — | **是**；**equityRatio / loanRate 否** |
| 布尔 | `project.includeStorage`（默认 1） | 1 | **否（致命假联动，见 F-2）** |
| 派生 | dailyChargeEnergy, chargerTotalPower, storageDuration | 3 | 派生量，供展示/约束 |

参数解析优先级（`parameter-engine.ts` `resolveParameters`）：`user`（裁剪到 bounds）> `policy`（仅当 `now` 在生效窗内）> `region` > `spec.defaultValue`；`derived` 最后计算。越界数值**裁剪（clamp）而非拒绝**，并置 `clamped=true` 标记（探针 C 实证：trucksPerDay=-10→1、chargingPrice=99→3.0）。

---

## 2. 参数是否真正进入计算链（真联动 vs 假联动）

**方法**：把某参数单独拉到极值，观察 NPV / CAPEX.net / revenueY1.gross 是否变化。变化=真联动；三者全不变=假联动。探针 B 组 7+1 项实证。

### ✅ 真联动（已确认进入 E1–E8）
`pvCapacity, storageEnergy, storagePower, chargerCount, chargerUnitPower, trucksPerDay, chargePerTruck, operatingDays, chargingPrice, elecPrice, peakValleySpread, pvEquivalentHours, constructionSubsidy, operationSubsidy, feedInTariff（当 exp0>0）` 及全部 `tech.*` / `finance.{discountRate,projectLife,inflation,taxRate,residualValue}`。独立复算 A 组逐位吻合，证明这些参数**确实**驱动结果。

### ❌ 假联动（8 项，改了 NPV/CAPEX/收入分文不动 — 探针 B 实证）

| # | 参数 | 默认值 | 单位 | 极值测试 | 后果 |
|---|---|---|---|---|---|
| F-2a | `project.chargerUtilization` | 35 | % | 90 | 桩利用率对收入/约束零影响（P1-1，前审计已记，仍未接线） |
| F-2b | `project.gridCapacity` | 2000 | kW | 100 | 电网容量不做功率约束，拉低也不报"容量不足"（P1-3） |
| F-2c | `region.demandCharge` | 40 | 元/kW·月 | 80 | **需量电价完全未计入购电成本**（中国工商业电费大头，见 §7） |
| F-2d | `region.landRent` | 800 | 元/亩·年 | 5000 | 土地租金未计入 OPEX |
| F-2e | `policy.carbonPrice` | 80 | 元/tCO₂ | 500 | 碳价/碳收益未计入（绿电环境价值缺失） |
| F-2f | `finance.equityRatio` | 30 | % | 100 | 资本金比例不影响任何现金流/回报（无融资结构） |
| F-2g | `finance.loanRate` | 4.5 | % | 15 | 贷款利率不产生利息、不影响 IRR/NPV |
| **F-2h** | **`project.includeStorage`（布尔）** | **1** | — | **0** | **"是否配储能"开关被彻底忽略**：置 0 后储能 CAPEX 与套利收入照算（见 F-3） |

> ⚠️ F-2h 是最隐蔽的假联动：`project-model.ts` 判定 `hasStorage = storageEnergy>0 && storagePower>0 && tech.storageIncluded`，**从不读 `project.includeStorage` 这个用户可见的布尔开关**。用户以为关掉了储能，账上却仍有一整套储能投资与收益。

---

## 3. 数学正确性（独立复算 E1–E8）

**探针 A 组**：不 import 引擎内部，纯用参数快照 `base` 手算 E1 CAPEX → E2 OPEX → E3 收入（含 SVE Δ_sto 独立复算套利腿）→ E4 购电 → E5 通胀+光伏衰减 → E6 税 → E7 残值 → E8 折现 NPV，与引擎输出对比。

| 环节 | 公式 | 独立复算 vs 引擎 |
|---|---|---|
| E1 CAPEX | pv(kWp×1000×元/W) + storage(kWh×1000×元/Wh) + charger(桩数×单桩kW×元/kW) − constructionSubsidy% | ✅ `toBeCloseTo(_,0)` |
| E2 OPEX | pvOM+storageOM+chargerOM+depotFixedOpex | ✅ |
| E3 收入 | 充电服务费 + 余电上网 + 运营补贴 + **SVE Δ_sto（套利腿 marginArb=p−p_valley/η, p_valley=p−spread/2）** | ✅ |
| E4 购电 | Imp0 × elecPrice（平价，未分时） | ✅ |
| E5–E8 | 逐年通胀、光伏 (1−deg)^(y−1)、储能 (1−δ)^(y−1)、正净额征税、末年加残值、Σ/(1+rate)^t | ✅ NPV 吻合 |

**结论：E1–E8 数学正确，无公式错误。** 唯一残差见 F-9（舍入顺序）。IRR（二分法）、回收期（线性插值）、ROI（inflow/capex 倍数）数学亦经 `finance.ts` 审阅确认正确，且对无解/多解/不回本诚实返回（no_sign_change / multipleRootsPossible / null）。

---

## 4. 单位一致性

审阅各层量纲，**未发现单位错误**（延续前审计结论并复核）：
- CAPEX：pv 用 `kWp×1000×元/W`（=元）、storage 用 `kWh×1000×元/Wh`（=元）、charger 用 `kW×元/kW`（=元）——量纲统一到"元"✅。
- 能量：kWh 全链一致；`acLoadFromDelivered = delivered/(eff/100)` ✅。
- 电价/价差：元/kWh；`p_valley = p − spread/2` 量纲一致 ✅。
- 效率/衰减/SOC：百分数入参，内部 `/100` ✅。
- 需量电价单位 `元/kW·月`、土地租金 `元/亩·年`、碳价 `元/tCO₂`——**单位本身没错，但这些参数根本没被消费**（假联动 F-2c/d/e），所以谈不上"算错单位"，是"没算"。

---

## 5. 极端输入鲁棒性（角点扫描）

**探针 C 组**：对全部可编辑数值参数逐一取 `min`/`max`，再全参数同时取 min、同时取 max。

- ✅ **无 Infinity 泄漏**：所有 `annualCashFlow` 项 `Number.isFinite`；NPV 要么有限要么诚实 NaN。
- ✅ **无崩溃**：不可解时返回显式 `reason ∈ {tech_error, missing_econ_inputs, invalid_econ_inputs}`，绝不吐脏数字。
- ✅ **裁剪生效**：越界被 clamp 到边界（trucksPerDay=-10→1、chargingPrice=99→3.0）。
- ✅ 折现率 0%/30%、通胀 −5%、计算期 5/30 年：数值稳定。
- ⚠️ **F-8 经济语义待裁决**：`peakValleySpread` 拉满 1.8 → `p_valley = 0.7 − 0.9 = −0.2 元/kWh`（**负谷价**）。引擎不崩、套利腿仍开、储能价值反而升高。负电价在中国现货试点确有先例，但"谷价恒为负仍无限套利"的语义需创始人裁决是否加地板（见 §7 待决）。

---

## 6. 页面展示 vs 计算结果一致性

- ✅ **视图层 `decision-view.ts` 零重算**：所有卡片值直接投影自 `CalcResult`；`formatMoney/formatPct/formatYears`（null→"从不回本"）；NaN/null 诚实显示 "—"。
- ✅ **报告层 `decision-report.ts` 零重算**：只重排/引用指标卡值，绝不重算 NPV/IRR/回收期/ROI（§16 单一真源遵守）。
- ❌ **F-6 龙卷风图呈现与实际不符（P2）**：`sensitivity.ts` 的 `TornadoRow.highInput/lowInput = baseInput×(1±delta)` **未裁剪**，但实际 `runProjectModel` 会裁剪。探针 E 实证：chargingPrice 基线 2.9、+15% 显示 `highInput=3.335`，而引擎实际按上限 **3.0** 计算——**图上标的扰动值 ≠ 真正跑的扰动值**，读者会被误导。
- ⚠️ **F-11 UI 硬编码默认值重复（P3）**：`DemoProjectPanel.tsx:276` 写死 `(0.7)` 作电价默认提示、`ProjectWorkbench.tsx:173` 写死 `?? 8` 作折现率兜底。二者当前与引擎默认（0.7 / 8）一致，但是**字面量副本**，一旦引擎默认变更即漂移。应改为从参数目录单一真源读取。

---

## 7. 发现清单（按严重度 P0–P3）

> 严重度定义：**P0** 会产生错误投资决策/数据造假；**P1** 用户可见的自相矛盾或安全/信任漏洞；**P2** 呈现误导或维护性风险；**P3** 口径/整洁性观察。
> 修复列标注该问题属"**呈现/接线/校验**"（不动经济公式，可小步改）还是"**改经济模型**"（须创始人逐项批准，开发原则第 1 条）。

| ID | 严重度 | 问题 | 证据（file:line） | 修复性质 | 建议 |
|---|---|---|---|---|---|
| **F-1** | **P1** | `layers` 入参几乎未校验：`z.record(z.string(), z.any())`，客户端可注入任意 region/policy 层与 `now` 时钟 | `src/server/project-service.ts`（layersSchema）；`src/server/project-store.ts` `toEngineLayers` | **校验** | 服务端对 layers 做 schema 白名单校验；`now` 强制服务端时钟，不接受客户端传入 |
| **F-1b** | **P1** | R8.7 诚实闸门只验 URL **格式**（`^https?://` + 无空格），**不验真伪**：客户端可把任意 ASSUMPTION 自封 `evidenceKind=FACT` + 伪造 https 链接即被承认 | `src/server/parameter-engine.ts` `usableHttpUrl`；探针 F 实证 | **校验** | FACT 来源须走服务端可信白名单/人工核实；客户端提交的 evidenceKind 一律降级为 ASSUMPTION 待核 |
| **F-2h** | **P1** | `project.includeStorage` 布尔开关被彻底忽略：置 0 后储能 CAPEX+套利收入照算 | `src/server/project-model.ts` `hasStorage`（不读该布尔）；探针 B | **接线** | `hasStorage` 应 `&& project.includeStorage===1`；或从 UI 移除该开关避免误导 |
| **F-3** | **P1** | 公交/市政画像声明 `includeStorage=0`（"场站多依谷电、未必配储能"），但 presetValues **未归零** storageEnergy/storagePower → 全局默认 400kWh/200kW 仍生效，账上有整套储能且还在赚套利 | `src/server/profiles.ts` TRANSIT_PROFILE（presetValues）；探针 B 实证 `capex.storage>0 && storageValue>0` | **接线/数据** | TRANSIT presetValues 补 `storageEnergy:0, storagePower:0`；或依赖 F-2h 修好后由 includeStorage=0 生效 |
| **F-2c** | **P2** | 需量电价 `region.demandCharge`（40 元/kW·月）完全未计入购电成本——中国工商业电费的**大头**缺失，导致购电成本低估、NPV 偏乐观 | `project-params.ts`；E4 只用 `Imp0×elecPrice`（平价）；探针 B 实证 | **改经济模型** | 需创始人批准后接入 E4（需量费 = 峰值需量 kW × demandCharge × 12）；同时把 E4 从平价升级为分时（配合 spread） |
| **F-2e** | **P2** | 碳价 `policy.carbonPrice`（80 元/tCO₂）未计入——绿电/储能的环境价值（碳收益）缺失，对"新能源"项目是核心卖点却没算 | 同上；探针 B | **改经济模型** | 批准后接入 E3（碳收益 = 替代火电量 × 排放因子 × carbonPrice） |
| **F-2f/g** | **P2** | 融资结构缺失：`equityRatio`/`loanRate` 不产生利息、不影响 IRR/NPV/资本金回报——投资类用户（INVESTOR 画像设了 equityRatio）看不到杠杆效果 | `project-model.ts` E5–E8 无融资腿；探针 B | **改经济模型** | 批准后新增融资腿（利息税盾 + Equity IRR）；高风险，须创始人拍板口径（已记 R8.8b 遗留） |
| **F-2a/b/d** | **P3** | chargerUtilization / gridCapacity / landRent 未接线（前审计 P1-1/P1-3 遗留） | `project-params.ts`；探针 B | **接线/改模型** | gridCapacity 建议接功率约束校验（超限报错）；landRent 接 OPEX；chargerUtilization 若 V1 不接则从 UI 隐藏避免误导 |
| **F-4** | **P2** | 储能超日历寿命仍计价值：`annualCycles` 上限 = cycleLife/calendarLife 只限**每年**循环数，不限**总年限**；计算期 20 年 / 日历寿命 10 年时，第 11–20 年"死电池"仍产出套利价值且**无更换 CAPEX** | `storage-value.ts`；探针 D 实证 laterDelta>0 | **改经济模型** | 批准后：超日历寿命年 either 归零储能价值 or 计入更换 CAPEX；口径须创始人定 |
| **F-6** | **P2** | 龙卷风图 `highInput/lowInput` 显示未裁剪值，实际按裁剪值计算，呈现≠事实 | `sensitivity.ts` `computeTornado`；探针 E 实证 | **呈现** | row 记录实际生效（裁剪后）值，或标注"已裁剪至上限"；纯呈现层修复，不动模型 |
| **F-7** | **P2** | 敏感性默认扫描集**缺中国关键参数**：feedInTariff（上网电价）、demandCharge（需量）、carbonPrice（碳价）、loanRate（融资）均缺席；且沿用"龙卷风图"西方咨询隐喻 | `sensitivity.ts` `DEFAULT_SENSITIVITY_PARAMS`；探针 E 实证 | **呈现 + 接线** | 见 §8 创始人裁决与 `PRODUCT_V2_DESIGN.md` 中国化重构方案 |
| **F-9** | **P3** | 舍入顺序：技术层 `firstYear.*` 全部 `round(x,0)`（0 位小数）后才被经济循环消费，独立复算若不镜像此舍入会差 2.23 元 NPV。**非计算错误**，是口径观察 | `tech.ts` firstYear；`project-model.ts` 年度循环；探针 A 修正后逐位吻合 | **口径** | 建议技术层保留更高精度、仅在展示层舍入；或明确文档化"引擎按 0 位小数舍入后再折现"。改动会影响黄金样本，须谨慎 |
| **F-10** | **P3** | `feedInTariff` 只在 `exp0>0`（光伏余电上网）时进入收入；基线 pvCapacity=500 下 acLoad>pvGen，exp0=0，故上网电价腿在基线不激活（正确，但需文档说明避免"以为没用"） | `project-model.ts` E3；探针 A | **口径/文档** | 无需改代码，报告/文档标注"余电上网腿仅在光伏>负荷时激活" |
| **F-11** | **P3** | UI 硬编码默认值重复（0.7 / 8），漂移风险 | `DemoProjectPanel.tsx:276`、`ProjectWorkbench.tsx:173` | **呈现** | 改从参数目录单一真源读取默认值 |

**未发现**：P0 级问题（无数据造假、无导致错误决策的数学错误）。经济内核数学与单位均正确。

---

## 8. 创始人裁决记录：龙卷风图（F-7 相关）

> **裁决原文（2026-09-09）**："中国极少龙卷风可以把这个删掉，合理结合中国的实际情况加入重要的影响参数。"

**解读与落地边界**：
1. **删除"龙卷风图"这一西方咨询隐喻的呈现**——中国读者不熟悉 tornado chart，改为中国工商业投资决策语境下的敏感性呈现（如"关键因素影响力排行 / 盈亏平衡敏感度 / 逐项±摆动对回本的影响"条形榜单）。**这属呈现层重命名/重排，不动经济模型，可立即小步实施**（列入首批修改方案第 1 项）。
2. **补齐中国关键影响参数**——`demandCharge`（需量电价，工商业电费大头）、`carbonPrice`（碳价/绿电环境价值）、`loanRate`+`equityRatio`（融资结构，决定资本金回报）、`feedInTariff`（上网电价）。**其中 demandCharge/carbonPrice/融资结构目前根本没接入 E 层（F-2c/e/f/g），"加入敏感性扫描"的前提是先接线——这属改经济模型，须创始人逐项批准口径后方可实施**，本报告只登记不擅自接线。
3. **技术约束**：`sensitivity.ts` 内部函数名 `computeTornado` / 类型 `TornadoRow` / 常量 `SENSITIVITY_VERSION` 属**已冻结的溯源口径**（V1_FREEZE 未直接冻结此文件，但改函数名会牵动 calcRef 与黄金样本）。建议**保留内部标识符**（避免破坏溯源），**仅改用户可见文案与图表形态**——即"内核叫 tornado 无所谓，用户看到的必须是中国话"。

---

## 9. 与前次审计（MODEL_CAUSALITY_AUDIT_V1）的关系

- 前审计已记 P1-1（chargerUtilization 假联动）、P1-3（gridCapacity 不约束）、P2-6（demandCharge/landRent/carbonPrice/equityRatio/loanRate 未消费）——**本次探针实证确认这些仍未接线**（F-2a/b/c/d/e/f/g）。
- 前审计 P1-2（储能无收入）已由 **R9.0 储能价值引擎（v0.59.0）关闭**——本次确认 SVE Δ_sto 已正确接入 E3b 且独立复算吻合（F 无此遗留）。
- **本次新增确认**：F-1/F-1b（layers 未校验 + FACT 可伪造）、F-2h（includeStorage 布尔被忽略）、F-3（TRANSIT 画像自相矛盾）、F-4（储能超寿命仍计价值）、F-6（龙卷风呈现≠事实）、F-7（扫描集缺中国参数 + 隐喻问题）、F-9（舍入顺序）、F-11（UI 硬编码重复）。

---

## 10. 审计边界声明（诚实）

- 本审计**未运行真实浏览器 E2E**（沿用 v0.64.1 已验证的四链路结论），聚焦**计算内核 + 入参信任边界 + 呈现一致性**的源码级实证。
- 本审计**未修改任何代码/模型/公式/迁移/版本号/黄金样本**（开发原则第 1、4 条）。探针为临时只读脚本，已按回收站纪律删除。
- 所有"改经济模型"性质的发现（F-2c/e/f/g、F-4、F-8）**仅登记，等待创始人逐项批准口径**，绝不擅自接线。
- 负谷价（F-8）、储能超寿命口径（F-4）、需量/碳价/融资接入公式（F-2c/e/f/g）均属**高风险财务内核口径**，按 USER 决策风格须创始人拍板。

---

## 附：问题优先级速览（供第二阶段修改计划引用）

**P1（用户可见矛盾 / 信任漏洞，应优先）**：F-1 layers 未校验、F-1b FACT 可伪造、F-2h includeStorage 被忽略、F-3 TRANSIT 画像矛盾。
**P2（呈现误导 / 中国语境缺失 / 经济完整性）**：F-2c 需量电价、F-2e 碳价、F-2f/g 融资结构、F-4 储能超寿命、F-6 龙卷风呈现、F-7 扫描集+隐喻。
**P3（口径 / 整洁性）**：F-2a/b/d 次要假联动、F-9 舍入顺序、F-10 上网腿激活条件、F-11 UI 硬编码重复。

> 下一步见 `docs/PRODUCT_V2_DESIGN.md`（第二~五阶段：用户路径 / 三级沙盘 / UI / 商业化 / 龙卷风中国化重构）与最终四项输出（问题优先级列表、V2 产品架构、修改计划、首批代码修改方案）。
