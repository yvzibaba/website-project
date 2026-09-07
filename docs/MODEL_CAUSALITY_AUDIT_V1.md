# 沙盘模型全链路因果审计（TASK 1 · 2026-09-08 夜）

> 只读审计，不改口径、不 bump `MODEL_VERSION`、不动 R8.7 / R8.8a 既有语义。
> 追踪链路：`重卡数 → 单车年里程 → 车辆百公里电耗 → 单车日均充电量 → 年充电量 → 光伏出力 → 储能吞吐 → 电价 → 购电成本 → CAPEX/OPEX → 现金流 → NPV/IRR/ROI/回收期`。
> 目的：判定「因果是否合理」而非「数字是否会变」；产出 P0/P1/P2/P3 清单，为后续 TASK 2/3 测试与最小修复定靶。

---

## 一、链路端到端确认（每段是否真的走通）

| 段 | 上游 → 下游 | 是否贯通 | 依据（file:line） |
|---|---|---|---|
| A1 | 车队 `truckCount × mileage × energyPer100km` → `chargePerTruck` | ✅ 通过 R8.8a 映射层 | `sandbox-demo.ts:253 fleetChargePerTruckDaily` |
| A2 | `trucksPerDay × chargePerTruck` → `derived.dailyChargeEnergy` | ✅ | `sandbox-params.ts:174` |
| A3 | `dailyChargeEnergy × operatingDays` → 年电池侧充电量 | ✅ | `sandbox-tech.ts:96` |
| A4 | 电池侧 ÷ 充电效率 → 交流侧负荷 | ✅ | `sandbox-tech.ts:105` |
| A5 | 光伏 `kWp × eqHours × PR` → 首年 PV 能量 | ✅ | `sandbox-tech.ts:75` |
| A6 | 逐年 PV 衰减 `(1−deg)^(y−1)` → 重平衡自用/上网/下网 | ✅ | `sandbox-model.ts:244–247` |
| A7 | 储能容量 → 年吞吐上界（cycles × kWh × rte） | ⚠️ **算出但未回灌经济层** → F2 P1 | `sandbox-tech.ts:150` 与 `sandbox-model.ts` 通读 |
| A8 | 收入 = 电池侧电量 × 充电价 + 上网 × 上网价 + 电池侧 × 补贴 | ✅ | `sandbox-model.ts:222–226` |
| A9 | 购电成本 = 下网 × 电价 | ✅ | `sandbox-model.ts:227` |
| A10 | OPEX = PV+储能+桩运维+固定 | ✅ | `sandbox-model.ts:215–219` |
| A11 | CAPEX = PV kWp×1000×元/W + 储能 kWh×1000×元/Wh + 桩 kW×元/kW，减建设补贴 | ✅ | `sandbox-model.ts:207–212` |
| A12 | 逐年 税后净现金流 + 末年残值 → flows | ✅ | `sandbox-model.ts:241–259` |
| A13 | flows → NPV / IRR / 回收期 / ROI | ✅ | `sandbox-finance.ts` 全程 |

单位一致性：kWp↔元/W、kWh↔元/Wh、kW↔元/kW、kWh↔元/kWh 全部按 1000 系数桥接一致；年/日/月口径统一（`operatingDays` 只在 A3 出现一次）；无重复乘除。

---

## 二、Findings（按优先级）

### P0（阻断使用 / 明显错误）

**无。** 主链 12 段端到端跑通、量纲正确、无 NaN/Infinity/负能量硬缺陷。基线 NPV 正值可复算，黄金样本 `sandbox-model.test.ts` 已焊死。

### P1（直接影响使用 · 因果断裂 · 假联动）

- **P1-1 · 「车辆利用率」滑块改了但计算完全不动**
  键 `project.chargerUtilization`（默认 35%，advanced 露出）在 `SANDBOX_PARAMS` 有声明、在参数面板可拖，但**未被任何 tech / finance / model 公式读取**（grep 全仓无消费方）。用户拖动即"改了个数字，NPV/IRR 一点不变" —— 正是 TASK 3 创始人点名的"假联动"反模式。
  根因：V1 采用"年能量平衡法"，直接用 `trucksPerDay × chargePerTruck × operatingDays` 定义需求，`chargerUtilization` 语义上冗余（要么定义"日均服务重卡数"要么定义"桩利用率"，不能同时定义）。
  处置：**不改口径原则下不能接线**（会改 E3 收入 / E1 CAPEX 定义），故 TASK 2 显式加"利用率扰动 → NPV 不变"回归测试**把它作为已知缺陷钉住**；建议后续把该参数从面板摘除或降为 `editable:false` + 注明"V1 未接入 · 待 S1 逐时曲线"（**留给创始人**，属"改参数暴露面"的语义决定）。

- **P1-2 · 「储能」只有成本没有收益，参数改动永远让 NPV 变差**
  `storageAnnualThroughput` 在 tech 层被算出（`annualDischargeThroughputKwh`），但 `sandbox-model.ts` 的 E3/E4 **完全没读它** —— 储能只在 CAPEX/OPEX 里出现，从不参与"削峰填谷套利的钱在财务/编排层结算"。文件头注释说"钱在 E 层结算"，实际**未在 E 层结算**。
  结果：拖动 `storageEnergy` → CAPEX↑ OPEX↑ → NPV↓；不存在"加储能 → 靠峰谷价差挣钱 → NPV↑"的因果。这既违反物理直觉（储能的核心经济意义就是套利），也违反 TASK 1「因果关系是否合理」的检验意图。
  处置：修复需引入 `region.peakValleySpread` 到 E3/E4 或新增峰谷套利现金流，属**改变经济口径 · 高风险** → 记 P1，**留给创始人**（对应 R8.8b 债务/DSCR/Equity IRR 同一批准闸口）。TASK 2 显式加"加储能 NPV 单调恶化"回归测试钉住当前行为，防止"以为储能会正贡献"的假象。

- **P1-3 · 「并网报装容量」`project.gridCapacity` 未参与任何功率约束**
  声明 2000 kW，但 tech 层无功率上限校验：即便 `derived.chargerTotalPower`（桩总装机）大于并网容量，模型不会警告也不会裁剪。
  处置：属"容量瓶颈"缺失，需引入 E 层功率校验或至少 note 提醒 → **改计算/加参数**，非本轮允许范围。TASK 2 加"桩功率超过并网容量 → 目前无差异"回归；**留给创始人**。

### P2（小缺陷 / 语义模糊 / 已文档化的简化）

- **P2-1 · 里程并非直接参数，`chargePerTruck` 是"车·次"不是"车·日"**
  引擎默认假设"每车每日约充一次"（DEMO 文件头已声明），因此 `trucksPerDay × chargePerTruck` 隐含"次/日 = 车/日"。用户若理解成"次/日 ≠ 车/日"（例如双班制一天两充）会误估年电量。属参数命名可改进，非计算错误。

- **P2-2 · DEMO 映射的 `DEMO_OPERATING_DAYS=350` 是硬编码常量，用户改 `project.operatingDays` 会破坏年电量守恒**
  `chargePerTruck = energyPer100km/100 × mileage / DEMO_OPERATING_DAYS`；若用户到高级面板改 `project.operatingDays=300`，则 `trucksPerDay × chargePerTruck × operatingDays` 不再等于"车队年里程 × 百公里电耗"。默认态（operatingDays=350）无碍，但 DEMO 与高级面板的口径联动有隐藏耦合。
  处置：TASK 3 显式加"DEMO 里程/电耗改后，若高级面板动 operatingDays，年电量守恒被打破"回归测试记录行为。

- **P2-3 · 残值 `capexGross × residualValue%` 未按通胀折算、不扣补贴**
  文件头 E7 已明示"残值取名义常数"。属已知简化，无需修复。

- **P2-4 · 建设补贴按 `capexGross × %` 抵扣、不按应税收入处理**
  E1 简化。真实财税处理补贴可能应税。文件头已声明"非可研/财税级"，属已知简化。

- **P2-5 · `trucksPerDay` 与 `chargePerTruck` 在派生网关上数学等价**
  敏感性里两者 ±X% 摆幅对 NPV 影响完全一样（都线性缩放 `dailyChargeEnergy`），会挤占 tornado 表格空间。已在 TASK 5 计划里通过"新增 `chargePerTruck` 作为里程×电耗的合并代理"来兑现"年里程"这一项需求。

- **P2-6 · 政策过期与地区层 bounds 已在 parameter-engine 正确实现，但 `region.landRent / demandCharge / peakValleySpread / carbonPrice`、`finance.equityRatio / loanRate / project.includeStorage` 均未接入 E 层**
  与 P1-1 同源，只是这些参数是 `pro` 档，普通用户看不到，故降为 P2。**留给创始人**（R8.8b 债务/DSCR 会接 `equityRatio`+`loanRate`；碳收益接 `carbonPrice`；需量电费接 `demandCharge`；峰谷套利接 `peakValleySpread`）。

### P3（已声明的简化 / 不修）

- **P3-1** 无 8760h 逐时曲线（S1）、无 SOH/温度/弃电（S5）、无充电需求增长曲线：文件头已明示，属 V1 有意留白。
- **P3-2** 无折旧抵税 shield（E6）：偏保守，已 notes 提示。
- **P3-3** IRR 多解只报其中一根（区间二分法）：已 `multipleRootsPossible=true` 示警。
- **P3-4** ROI 是全周期简单比率（未年化）：已在 sandbox-finance 文件头声明，UI 显示"投资回报率"未强推年化解读。

---

## 三、单位与量纲复核（逐段核）

| 段 | 表达式 | 单位验算 |
|---|---|---|
| CAPEX.pv | `kWp × 1000 × 元/W = 元` | ✅ kWp→Wp 通过 ×1000 |
| CAPEX.storage | `kWh × 1000 × 元/Wh = 元` | ✅ kWh→Wh 通过 ×1000 |
| CAPEX.charger | `kW × 元/kW = 元` | ✅ 无 1000 桥 |
| OPEX.pv | `kWp × 元/kWp·年 = 元/年` | ✅ |
| OPEX.storage | `kWh × 元/kWh·年 = 元/年` | ✅ |
| OPEX.charger | `台 × 元/台·年 = 元/年` | ✅ |
| 收入.charging | `kWh/年 × 元/kWh = 元/年` | ✅（电池侧 delivered） |
| 收入.export | `kWh/年 × 元/kWh = 元/年` | ✅ |
| 成本.grid | `kWh/年 × 元/kWh = 元/年` | ✅ |
| PV 年能量 | `kWp × h × 无量纲 = kWh` | ✅ |
| AC 负荷 | `kWh ÷ (百分比÷100) = kWh` | ✅ |
| 储能吞吐 | `kWh × (rte/100) × 无量纲 = kWh/年` | ✅（但下游未消费，见 P1-2） |
| NPV | `Σ 元 / 无量纲折现` | ✅ |
| IRR | 使 NPV=0 的 `rate`（小数），UI ×100 显示 | ✅ |

日期口径：`operatingDays`（350）只在 A3 出现一次；无"月度电价 × 12"这类二次乘除；建设补贴在 t=0 抵扣（E1）；OPEX/收入 E5 全按"年"通胀；无日/月/年混用。

---

## 四、下一步 TASK 的落点

- **TASK 2（真实性网格测试）**：加 `tests/unit/sandbox-causality.test.ts` 显式测 (a) 车辆/里程/电耗/光伏/电价 5 轴单调性与量级；(b) 无 NaN/Infinity；(c) 无"参数变→结果不变"（除已明确 P1-1/P1-2/P1-3 未接线项，用反向断言钉住现状）；(d) 光伏>负荷时上网量正向；(e) 桩功率>储能功率时的因果边界。
- **TASK 3（DEMO 10 参数真联动）**：加 `tests/unit/sandbox-demo-linkage.test.ts` 遍历 `DEMO_HEADLINE_SPECS` 8 个可操作字段，逐一 touched → `resolved.numeric` 有对应键变化 → `calc.capex.gross` 或 `calc.metrics.npv` 变化 → `vm.cards` 至少一张 value 字符串变化 → `report.sections` 有对应段落值变化。
- **TASK 4（动态报告）**：加 `tests/unit/sandbox-report-dynamic.test.ts`，跑 3 组显著不同参数（基线 / 车队×5 / 高光伏+高电价），断言 4 张核心卡 NPV/IRR/回收期/ROI 值字符串至少 3 张互不相同，且报告"投资结构 / 敏感性 / 假设"节都反映新数字。
- **TASK 5（敏感性 TOP5）**：现有 8 项默认集不含储能 CAPEX 与里程代理；最小扩展加 `tech.storageCapex`（deltaPct 20%）与 `project.chargePerTruck`（deltaPct 20%，作里程代理）。校验既有"最敏感=充电单价"仍成立，否则收窄新项 delta 或降位。

---

## 五、留给创始人的（不自动执行）

1. **储能货币化（P1-2）**：需要"峰谷套利 E 层结算"设计，属改经济口径 → 与 R8.8b 债务/DSCR 同批人工裁决。
2. **功率/容量瓶颈校验（P1-3）**：并网容量 / 变压器功率是否作为 E 层硬约束，属模型严肃性升级 → 人工裁决。
3. **车辆利用率是否应从面板摘除（P1-1）**：或改 `editable:false` 或补 S1 逐时曲线；语义决定 → 人工裁决。
4. **`equityRatio`/`loanRate`/`demandCharge`/`landRent`/`peakValleySpread`/`carbonPrice`/`includeStorage` 未接入 E 层（P2-6）**：属"参数暴露 vs 计算实现"的错配，建议要么标注"未接入·示例占位"，要么按 R8.8b 计划逐项接线 → 人工排期。
5. **权威数据到位**：山西电价 / 光照 / 补贴仍 ASSUMPTION，需要创始人提供可核验 sourceUrl 后 `makeVerifiedFact` 自动升 FACT（管道已就绪，缺来源）。
6. **PUBLISHED+price>0 真卖方案**：DB 现状无一条， BUSINESS_INPUT_REQUIRED，未 AI 填充。
