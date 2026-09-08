# R9.0 储能价值模型设计（Storage Value Engine · 规划稿 V0）

> **状态（2026-09-08 更新·Step 2/3 已接入生产）**：Step 1（纯函数 `sandbox-storage-value.ts` + 61 项独立单测）按创始人四项裁决收口（§十六·五）；Step 2/3 依创始人指令「按照你的思路推荐继续完成项目」（2026-09-08）完成接线——SVE 已接入 `sandbox-model.ts` E3b（加性收入项，E4/财务原语零改动），`MODEL_VERSION` 1.0.0→**1.1.0**、`SANDBOX_PARAMS_VERSION` 1.1.0→**1.2.0**（+5 个 SVE 键），storage>0 黄金样本全仓重录、storage=0 路径**逐字节零 churn**（焊点测试锚定）。收口记录见 §十六·六；**老项目重算版本戳策略仍未裁决**（§16.5，见 §十六·六·遗留）。
> **V1 方法论声明（ISSUE-1 强制声明）**：V1 采用年度平均购电价基线上的储能增量价值估算，并非逐时峰谷电价模型。逐时电价 / E4 分时化以后单独立项。
> **触发**：v0.58.0 夜批 TASK1 审计发现 **P1-2** —— 储能 `annualDischargeThroughputKwh` 在技术层已算出，但经济层 E3/E4 从不消费，导致储能「只计成本、不计收益」，`storageEnergy↑ ⇒ NPV 严格↓`。
> **本稿唯一裁决人**：创始人。§16 明确列出需要创始人拍板的版本口径问题，本文档**不自行决定**。
> **诚实纪律**（宪法 §16/§20）：文中一切"新增参数默认值"仍属 `ASSUMPTION` 占位；一切结论仍 `needsProfessionalReview=true`；本文档不声称任何数字已被核实。

---

## 一、当前问题（根因，均已读码定位）

现链路的储能是「**成本孤岛**」。证据：

| 位置 | 现状 | 后果 |
|---|---|---|
| `sandbox-tech.ts:150 storageAnnualThroughput` | 算了 `annualDischargeThroughputKwh`（能量口径，每天一次满充满放，受 `min(operatingDays, cycleLife/calendarLife)` 封顶，放电侧乘 RTE） | 能量算了，但—— |
| `sandbox-model.ts` 通读 | E3 收入 = 充电收入 + 余电上网 + 运营补贴；E4 购电 = `gridImport × elecPrice`。`tech.storage.*` **零引用** | 储能吞吐从未变成钱 |
| `sandbox-model.ts:203–216 hasStorage` | 储能只 gate 了 `storageCapex`（E1）与 `opexStorage`（E2） | 储能只进成本、不进收入 ⇒ 加储能必让 NPV 变差 |
| `sandbox-model.ts:227 energyCostY1 = gridImport × elecPrice` | E4 用**单一扁平电价**，无峰/谷之分 | 峰谷套利在数学上**根本无法存在**（没有时间维的价格差） |
| `sandbox-params.ts:79 region.peakValleySpread` | 参数**已存在**（默认 0.6，山西覆写 0.7），但 grep 全链路无消费方 | 套利腿有现成锚点，只差接线（P2-6 同源） |

另三个建模缺口（技术层）：

- **P1-2a 功率不封顶**：S4 每次放电量只用 `storageEnergy`，完全不看 `storagePower`（§8 要求容量/功率分别建模）。一个 400kWh/50kW 的储能被当成能瞬时放完。
- **P1-2b 效率单边**：S4 把整个 RTE 乘在**放电侧**（`perCycleDischarge = E×rte`），充电侧不额外抽能 → 低估了"为存 1 度电要多买多少谷电"的损耗成本。
- **P1-2c 无 SOC/DoD/衰减**：可用深度（SOC 窗口）、逐年容量衰减（§10）均未建模，储能寿命期内被当成永远满血。

---

## 二、原模型逻辑（不变的部分，务必保持）

技术层 S1 年度能量平衡（`annualEnergyBalance`）：
```
selfConsumed = min(PV, L)      export = max(0, PV − L)      import = max(0, L − PV)
```
经济层 E1–E8（`computeEconomics`）：E1 CAPEX（光伏 kWp×1000×元/W + 储能 kWh×1000×元/Wh + 桩 kW×元/kW − 建设补贴）；E2 OPEX；E3 收入（`delivered×chargingPrice + export×feedIn + delivered×operationSubsidy`）；E4 购电（`import×elecPrice`）；E5 逐年（光伏按 `(1−deg)^(y−1)` 衰减重平衡、名义价随 `inflation` 放大、`acLoad` 保持标称不变）；E6 正值按 `(1−tax)` 征税（无折旧抵税）；E7 末年残值 `grossCapex×residual%`；E8 喂 `npv/irr/payback/roi`（纯函数原语，§7 程序算）。

**本设计不推翻以上任何一条**（§15）。储能价值以**增量收益（additive delta）**形式挂到 E3，其余口径逐字保持。这样做的三个理由：①改动面最小、可回退；②天然回答 §11/§12「加 1MWh 储能带来多少收益」；③把"储能是否有价值"变成"这条 delta 是否为正"的单调判断，便于测死。

---

## 三、新模型目标（Storage Value Engine, SVE）

第一版只算**两类价值**（§2），其余（辅助服务/现货/容量电费/电力市场/复杂金融）§3 明令**排除**：

1. **峰谷套利（Arbitrage）**：谷时（低价）充电、峰时（高价）向负荷放电，赚取**移时价差**——不减少总用电量，只改变"何时买电"。
2. **光伏消纳（PV-consumption）**：储能吸收**本会被上网（低价）**的富余光伏，转而在负荷侧**抵扣高价下网**，赚取**自用完纳价差**。

目标：使 `storageEnergy↑` 对 NPV 的影响**由单调恶化变为"收益侧出现受封顶的非零正贡献"**，从而可回答"储能配多少值得 / 再加 1MWh 还有没有价值"。容量响应形态不预设（ISSUE-3，见 §11）：系统在给定容量搜索范围内寻找最优配置，可能存在内部最优点、端点最优，或在当前范围内持续增加/持续下降。

---

## 三·五、数据流与能源流（交付清单 §4、§5）

**数据流（谁算谁、单向、不回头重算）**：

```
参数引擎 resolveSandbox  ──(numeric 快照)──▶  技术层 computeTechModel
        │  region.elecPrice / peakValleySpread / policy.feedInTariff        │  PV_y, L, SC0/Exp0/Imp0
        │  project.storageEnergy/Power, tech.storageRoundTripEff,          │  storageThroughput（升级：功率/SOC/衰减封顶）
        │  storageCycleLife/CalendarLife, + 新增 SocMin/Max、Degradation、  │
        │  DischargeWindowHours、PeakLoadShare                              ▼
        └──────────────────────────────────────────▶  SVE  computeStorageValue（新纯函数模块）
                                                          │  Δ_arb,y, Δ_pv,y, EnergyFlowLedger
                                                          ▼
                                            经济层 computeEconomics（E1–E8 不变，E3 加 Δ_sto）
                                                          │  flows → npv/irr/payback/roi（原语不变）
                                                          ▼
                                            sandbox-view（revenue 卡拆 5 项 + 可选边际曲线）
                                                          ▼
                                            sandbox-report（读 vm，不重算）/ sandbox-demo（默认态不变）
```

**能源流（每年度、每一度电的唯一去向，互斥完备）**：

```
光伏 PV_y ┬─ 直接自用 SC0_y ─────────────────────────────▶ 供负荷（E4 不产生现金购电）
          └─ 富余 Exp0_y ┬─ 进储能(消纳腿) M_pv/η ─▶η 后放电 M_pv─▶ 抵下网
                          └─ 上网 (Exp0_y − M_pv/η) ─────────────▶ ×feedIn
电网下网 Imp0_y ┬─ 峰时段 σ·Imp0 ─ 谷充套利腿：抽 M_arb/η 谷电 ─▶η 放电 M_arb 峰时供负荷（只计价差）
               └─ 剩余 (1−σ)Imp0 ─┬─ 被消纳腿抵扣 M_pv（不重复计）
                                   └─ 净下网 (Imp0 − M_pv) ─▶ ×p
储能循环预算 D_max,y：M_arb,y + M_pv,y ≤ D_max,y（两腿共享、防超配）
```
数据流与能源流在 §6 的账本不变量处交汇：`M_arb` 只落"价差"桶、`M_pv` 只落"抵扣下网+牺牲上网"桶，二者电量片不相交。

---

## 四、数学口径完整定义

### 4.1 输入变量（复用既有键 + 明确新增键）

复用（已存在，`ASSUMPTION` 占位）：

| 符号 | 键 | 单位 | 默认/山西 |
|---|---|---|---|
| `E_cap` | `project.storageEnergy` | kWh（铭称容量） | 400 |
| `P_rated` | `project.storagePower` | kW（额定功率） | 200（demo 态 = `E_cap/2`） |
| `η` | `tech.storageRoundTripEff/100` | —（往返效率） | 0.88 |
| `N` | `finance.projectLife` | 年 | 15 |
| `n_d` | `project.operatingDays` | 天/年 | 350 |
| `CycLife` | `tech.storageCycleLife` | 次 | 6000 |
| `CalLife` | `tech.storageCalendarLife` | 年 | 10 |
| `p` | `region.elecPrice`（×通胀） | 元/kWh | 0.7 / 0.55 |
| `spread` | `region.peakValleySpread`（×通胀） | 元/kWh | 0.6 / 0.7 |
| `feedIn` | `policy.feedInTariff`（×通胀） | 元/kWh | 0.35 / 0.33 |
| `capex_s` | `tech.storageCapex` | 元/Wh | 1.3 |
| `om_s` | `tech.storageOm` | 元/kWh·年 | 12 |
| `PV_y` | 技术层首年光伏×衰减（§E5） | kWh/年 | — |
| `L` | 技术层年交流负荷（标称恒定） | kWh/年 | — |

**新增输入**（提案键，一律 `ASSUMPTION`、`editable`、进 §16 版本裁决；命名沿用点分单一真源约定）：

| 符号 | 提案键 | 单位 | 建议默认 | 语义 |
|---|---|---|---|---|
| `w` (SOC 窗口) | `tech.storageSocMin` / `tech.storageSocMax` | % (0–100) | 10 / 90 | DoD 的载体：单次可用深度 = `(max−min)/100`，此处即 §9 的 SOC 边界，也是 §5 的 DoD（二者合一，避免重复参数） |
| `δ_s` | `tech.storageDegradation` | %/年 | 2.5 | 储能逐年容量衰减（与光伏 S2 同构，透明工程简化，非电化学模型，§10） |
| `H_dis` | `tech.storageDischargeWindowHours` | h/日 | 2 | 每天可"满功率向价值窗口放电"的小时数（峰段可用时长；demo `storageDuration=2h` 时恰覆盖全容量） |
| `σ` | `tech.storagePeakLoadShare` | —(0–1) | 0.4 | **年度简化代理（ISSUE-4 裁决保留，2026-09-08）**：σ 不是逐时真实峰时电量，而是"峰时可套利下网电量比例"的年度代理。标记 `ASSUMPTION`；凡产出恒 `needsProfessionalReview=true`（方向性偏差见 §18 R-A） |

> 参数引擎会强制：新增 `derived` 键须声明 `dependsOn`；新增 numeric 键须过 `ParameterSpecSchema`。上表均 numeric 非派生，直接登记即可。`SANDBOX_PARAMS_VERSION` 须随之升版（§16）。

### 4.2 中间变量

年最大可用放电（能量侧，逐年）——把 S4 升级为**容量与功率双封顶 + SOC + 衰减**：
```
e_cycle   = min( E_cap · w ,  P_rated · H_dis )          # 单次循环可放电量 [kWh]，§8 功率双封顶
cycles_y  = min( n_d ,  CycLife / CalLife )              # 年循环次数（沿用 S4 寿命折算）
D_max,y   = e_cycle · cycles_y · (1 − δ_s/100)^(y−1)    # 第 y 年可用放电上界 [kWh/年]，§10 衰减
```
年度基线能量（技术层 S1，逐年、光伏已衰减）：
```
SC0_y = min(PV_y, L)     Exp0_y = max(0, PV_y − L)     Imp0_y = max(0, L − PV_y)
```
价格分解（峰/谷单价，随通胀放大；使 `storage=0` 时年均价 = `p`，保证回退兼容）：
```
p_peak,y   = p_y + spread_y/2       p_valley,y = p_y − spread_y/2       (p_y = p·(1+infl)^(y−1))
```

> **ISSUE-1 裁决（选项 A，创始人 2026-09-08）**：E4 维持单一平均电价 `Imp0 × p` 不变；套利增量一律按 `p − p_valley/η` 计价，**`p_peak` 仅作诊断透出、不进入任何计价公式**（E4 已按 `Imp0 × p` 计入基线购电成本，若 Δ_arb 再用 `p_peak` 会重复计价，每度多记 `spread/2`）。**V1 采用年度平均购电价基线上的储能增量价值估算，并非逐时峰谷电价模型**；逐时电价 / E4 分时化以后单独立项。

### 4.3 两条腿的分配（Energy Flow Ledger 的核心规则，§11；ISSUE-2 裁决版，创始人 2026-09-08 批准）

给定 `D_max,y`，按**单位经济价值（margin）高者优先占用共享循环预算**切分；margin 相等时套利优先（确定性平局规则）：

```
arb_margin = p_y − p_valley,y / η          # 套利腿每度放电净收益 [元/kWh]（ISSUE-1 选项 A 口径，不用 p_peak）
pv_margin  = p_y − feedIn_y / η            # 消纳腿每度放电净收益 [元/kWh]

# 容量片（放电侧口径）：
arb_slice = σ · Imp0_y                     # 套利只动"峰时下网"时间片，只做移时，不减总量
pv_slice  = min( η · Exp0_y , (1−σ) · Imp0_y )

# margin 降序贪心（分数背包最优）：每腿只在自身 margin > 0 时运行（操作者不做负价值循环）；
#   margin 高者先取 min(剩余预算, 自身容量片)，剩余预算留给另一腿。两腿合计受预算硬顶：
M_arb,y + M_pv,y ≤ D_max,y
```

**为什么 margin 优先是本模型的最优分配（ISSUE-2 批准理由，写入模块文档）**：两条价值腿在当前 V1 模型下均为**线性单位价值**（每度放电的收益恒等于各自 margin，与分配量无关），且共享有限 `D_max`——这正是分数背包问题的结构，按单位价值降序贪心即全局最优。它同时保证三条已实测性质：η 下降时储能总价值不增（可行域收缩 + 各腿 margin 逐点下降）、spread/feedIn 变化时价值单调不降、I1/I2/I3 不变量不被破坏。早期设计稿的"固定套利优先"已被 Step 1 测试证伪（基准参数下次优，且出现"η 降→总收益反升"的物理悖论：实测 η=0.58 时 10,344 元 → η=0.55 时 63,636 元），本节为裁决后版本。

### 4.4 收益公式（单位：元/年，均为 E3 的加性 delta）

```
Δ_arb,y = M_arb,y · ( p_y − p_valley,y / η )
        = 移峰电量 ×（年度均价 − 谷价÷往返效率）    # 每放 1 度省下均价购电、代价是多买 1/η 度谷电（ISSUE-1 选项 A：不用 p_peak）

Δ_pv,y  = M_pv,y  · ( p_y − feedIn,y / η )
        = 消纳电量 ×（下网价 − 上网价÷往返效率）    # 每放 1 度省 1 度下网、代价是少卖 1/η 度上网
```
总储能年度增量收益：`Δ_sto,y = Δ_arb,y + Δ_pv,y`（各自 ≥0，故 Δ_sto ≥0，绝不给储能"倒贴收益"）。
> **为什么效率必须进分母**（§7）：充 1MWh、放不足 1MWh。套利腿每净放 1 度需从电网买 `1/η` 度谷电；消纳腿每净用 1 度需牺牲 `1/η` 度本可上网的光伏。η 越低，收益越低，单调正确。
> **ISSUE-1 裁决记录（选项 A，创始人 2026-09-08）**：套利增量**不使用 `p_peak`**——E4 已按 `Imp0 × p` 对全部下网电量（含被套利移走的峰时电量）计入基线购电成本，若 Δ_arb 再按 `p_peak` 计"避免的峰价"，每度电将重复计入 `p_peak − p = spread/2` 元。`p − p_valley/η` 口径已由恒等式测试钉死（"扁平 E4 反事实成本差 ≡ Δ_sto"，见单测 I3）。**V1 采用年度平均购电价基线上的储能增量价值估算，并非逐时峰谷电价模型**；逐时电价 / E4 分时化以后单独立项（届时属新口径变更，须另走 §16 版本裁决并重推公式）。

### 4.5 单位验算

`M [kWh/年] × p [元/kWh] = 元/年` ✅；`D_max = [kWh]·[次/年]·无量纲 = kWh/年` ✅；`e_cycle = min(kWh, kW·h) = kWh` ✅；`cycles = min(天, 次/年)` 取年循环上界，量纲按"次/年" ✅；`p_peak = 元/kWh ± 元/kWh` ✅。与既有 CAPEX 的 `kWh×1000×元/Wh`、E3/E4 的 `kWh×元/kWh` 桥接口径一致。

### 4.6 边界与约束（§4/§8/§9/§10）

- `0 ≤ M_arb,y , M_pv,y , D_max,y`；`M_arb,y + M_pv,y ≤ D_max,y`（同一循环预算不可两腿都占满——**防重复计算的硬顶**）。
- `w = (SocMax − SocMin)/100 ∈ (0,1]`；`SocMax ≤ 100`、`SocMin ≥ 0`。
- `η ∈ (0,1]`；`(1−δ_s/100)^{y−1}` 衰减系数 `∈ (0,1]`（逐年降）。
- `σ ∈ [0,1]`、`H_dis > 0`、`P_rated > 0`、`E_cap > 0`，否则储能未纳入（沿用 `hasStorage` 判定）。
- `storageEnergy = 0` 或 `storagePower = 0` ⇒ `D_max,y = 0` ⇒ `Δ_sto = 0` ⇒ **与原基线逐字一致**（回退兼容，见 §16）。
- 无储能时价格分解不产生任何现金流影响：`p_peak` 恒为诊断透出、**不进入任何计价公式**（ISSUE-1 选项 A），`p_valley` 仅出现在 Δ_arb 的 `p_valley/η` 项；二者**均不参与 E4 的 `gridImport×p`**，故基线购电费不变。

### 4.7 输出变量

`Δ_arb,y`、`Δ_pv,y`、`Δ_sto,y`（元/年，逐年）；经 E6 计税、E8 折现后进入既有 `metrics.{npv,irr,payback,roi}`；另出：`M_arb,y`、`M_pv,y`（kWh/年，能量账本）、`D_max,y`、年循环实际使用数、以及 §13 的边际量。全部落 `needsProfessionalReview=true` 与 `methodology` 声明。

---

## 四·五、成本模型（交付清单 §10，储能成本侧零改动）

储能的成本**完全沿用既有 E1/E2 口径，本设计不新增、不修改任何成本项**（§15 兼容）：

```
CAPEX_storage = storageEnergy · 1000 · tech.storageCapex        # E1，t=0 一次性，随容量线性；受建设补贴同比例抵扣
OPEX_storage  = storageEnergy · tech.storageOm                   # E2，元/年，随容量线性、随通胀放大
（两者仅在 hasStorage = storageEnergy>0 且 storagePower>0 且 tech 纳入 时计入，现状逻辑不变）
```
> **刻意不做的事**：不给储能加折旧/更换成本（V1 假设寿命期内不换）、不建 SOH 曲线驱动的提前更换 CAPEX、不建融资利息/DSCR（§3 禁）。这些属后续独立建模。

净价值判断即由"未变的线性成本"配"新引入的受封顶收益"产生：`ΔNPV(E) = NPV_收益(E) − CAPEX(E) − PV(OPEX_E)`。**ISSUE-3 裁决（2026-09-08）**：系统在给定容量搜索范围内寻找最优配置；可能存在内部最优点（成本线性、收益受多重封顶饱和时的典型形态）、端点最优，或在当前范围内持续增加/持续下降——模型与测试均不预设"必然存在内部最优 `E*`"，如实报告所在形态。换电池成本若未来要建，只会在 E1/E2 增设一笔"周期中资本支出"（projectLife 中途 `year≈CalLife` 追加 `E·capex·更换系数`），届时同样触发 `MODEL_VERSION` 升版，交人工。

---

## 五、经济因果链（可追溯，§5）

套利链（该腿 margin > 0 且按 §4.3 margin 优先分得预算时）：
```
E_cap · w · P_rated · H_dis · cycles_y · 衰减  →  D_max,y
   →  M_arb,y (=min(剩余预算, σ·Imp0))  →  × (p − p_valley/η)  →  Δ_arb,y  →  E3 收入 → E8 → NPV/IRR/Payback
```
光伏消纳链（与套利腿按 margin 优先竞争同一预算，先后由参数决定）：
```
D_max,y · Exp0_y · (1−σ)Imp0_y  →  M_pv,y (=min(剩余预算, η·Exp0, (1−σ)·Imp0))
   →  × (p − feedIn/η)  →  Δ_pv,y  →  E3 收入 → E8 → NPV/IRR/Payback
```
两条链各自"容量→可移动/可吸收电量→价差→收益"，每一步都可被 `sandbox-causality` 式测试逐段钉死（§19 测法：给单变量扰动，断言对应段变、下游指标变）。

---

## 六、防重复计算：Energy Flow Ledger（§6，本设计的地基）

**原则：每一度电在任意一年只能落进恰好一个价值桶。** 年度桶定义（互斥且完备）：

| 能量流 | 去向 | 计价 |
|---|---|---|
| `SC0_y` | 光伏直接被负荷吃掉 | 机会价 = 省 `p`（E4 已隐含：`gridImport = Imp0`，自用不产生现金购电） |
| `M_pv,y`（放电量） | 富余光伏→存储→负荷 | 计 `(p − feedIn/η)`，**同时** 从 `Exp0_y` 扣除 `M_pv/η`（这部分不再计入"余电上网"），从 `Imp0_y` 扣除 `M_pv`（不再计"下网"） |
| `Exp0_y − M_pv/η` | 富余光伏上网 | `× feedIn`（原 E3 上网收入项**相应缩小**） |
| `M_arb,y` | 谷电→存储→峰时供负荷 | 只计**移时价差** `(p − p_valley/η)`（ISSUE-1 选项 A）；其"下网电量"本就在 `Imp0_y` 里按均价 `p` 计过一次，套利项**只补价差、不重复抵扣电量**——若按 `p_peak` 记账将每度重复 `spread/2`，裁决禁止 |
| `Imp0_y − M_pv` | 仍需下网（不含移峰损失） | `× p` |
| 套利损失电量 `M_arb·(1/η − 1)` | 谷时额外买电补损 | 在 Δ_arb 公式的 `p_valley/η` 项里已含，不另计 |

**关键去重规则（写死为不变量，测死）：**
1. `M_arb,y` 与 `M_pv,y` 共享同一个 `D_max,y` 预算：`M_arb + M_pv ≤ D_max`，且套利只动 `σ·Imp0` 时间片、消纳只动 `(1−σ)·Imp0` 电量片 —— **两者作用于互不相交的下网子集**，故同一度下网不会既被套利省、又被消纳省。
2. 光伏只可能被消纳腿"截胡"一次：`M_pv/η ≤ Exp0_y`（截走的量从上网项扣干净），杜绝"同一度光伏既上网又抵扣下网"。
3. 套利腿不新增"省下的电量"，只新增"省下的钱"（价差），杜绝与 E4 电量购费重复计量。

这三条对应 §19 的三条反向断言（de-duplication invariants）。

---

## 七、效率建模（§7）

V1 沿用**单一往返效率 `η`**（`tech.storageRoundTripEff`），并把它**同时**用于两腿分母（充电抽能 / 牺牲上网量按 `1/η` 放大）。理由：技术层 S4 本就单 RTE，保持与既有链路一致、零新参数。**建议纠正 S4 现有偏差**：现 `perCycleDischarge=E×rte` 把损耗记在放电侧；SVE 改记在充电侧（多买 `1/η` 谷电、多牺牲 `1/η` 光伏），物理上更准（充电先扣损耗）。若未来要拆 `η_charge × η_discharge`，属后续独立增强，非 V1。

---

## 八、功率 vs 容量分别建模（§8）

`e_cycle = min(E_cap·w , P_rated·H_dis)` —— 能量（MWh）与功率（MW × 时长）各自封顶取小。效果：
- 400kWh / 200kW / `H_dis`=2h：`min(400·0.8, 200·2)=min(320,400)=320`，能量封顶。
- 同样容量改 50kW：`min(320, 50·2=100)=100`，功率封顶 → 收益骤降。
这修掉 P1-2a（原 S4 只用 `E_cap`，功率形同虚设）。`H_dis` 是"每天有几个小时能满功率向价值窗口放电"的透明代理（无逐时曲线），与 demo 的 `DEMO_STORAGE_HOURS=2` 语义天然对齐。

---

## 九、SOC（§9）

以 `SocMin/SocMax`（%）刻画可用窗口 `w=(max−min)/100`，直接进 `e_cycle`。DoD 与 SOC 窗口在本 V1 合一（避免同一物理量两套参数漂移，违背 §16 单一真源）；若创始人要显式 DoD 键可另议。SOC 抬 `min` 或压 `max` → `w↓` → `e_cycle↓` → `D_max↓` → 两腿收益同比缩，单调可测。初始 SOC 在年度模型下不影响**净**吞吐（每满充满放周期与初值无关），故 V1 不引入 `SocInit`，标注为逐时模型才需要的量（留白，诚实）。

---

## 十、电池寿命（§10，透明工程简化）

三重封顶，全部沿用/最小扩展既有口径，**不做电化学模型**：
1. **循环寿命**：`cycles_y = min(n_d, CycLife/CalLife)`（S4 已有）。
2. **日历寿命**：体现在上式分母 `CalLife`。
3. **容量衰减**：`κ_y=(1−δ_s/100)^(y−1)`，与光伏 S2 衰减同构，逐年削 `D_max,y`。
效果：寿命末 `D_max` 变小 → 套利/消纳收益逐年递减 → 与 CAPEX 一次性投入相乘，天然产生"配多大储能"的边际递减（§12）。

---

## 十一、"储能是否值得配置"（§11，模型须能回答）

在同一引擎上对比 `E` 与 `E'=0`：
```
ΔCAPEX = E_cap·1000·capex_s（已有，随容量线性增）        → t=0 现金流更负
ΔOPEX  = E_cap·om_s（已有，随容量线性增）                 → 每年成本增
ΔRevenue(y) = Δ_arb,y + Δ_pv,y（新，随容量增、受 D_max 与价差等多重封顶，形态不预设）  → 每年收入增
ΔNPV  = Σ_y [ΔRevenue(y) − ΔOPEX·infl]·(1−tax)/(1+rate)^y − ΔCAPEX
IRR / Payback 变化 = 用新 flows 重喂既有 finance 原语（不碰口径）
```
ΔRevenue 受功率/能量/σ/Exp0/Imp0 多重封顶、且逐年衰减，形态通常先升后趋平；ΔCAPEX/ΔOPEX 线性。**ISSUE-3 裁决（创始人 2026-09-08）**：不预设"必然存在 `argmax_E ΔNPV`"——系统在给定容量搜索范围内寻找最优配置；可能存在内部最优点、端点最优，或在当前范围内持续增加/持续下降。模型与测试以 A 内部最优 / B 范围内持续上升 / C 范围内持续下降三态如实报告所在形态。模型由此可答"值不值得配、当前搜索范围内配多少最值"。

---

## 十二、边际储能价值（§12）

定义新增 `ΔE`（如 1MWh）的边际：
```
MarginalValue(E) = NPV(E + ΔE) − NPV(E)
MarginalCAPEX(E) = ΔE·1000·capex_s
MarginalRevenue(E) = Σ_y [Δ_sto,y(E+ΔE) − Δ_sto,y(E)] 折现
MarginalIRR / MarginalPayback：以 (MarginalCAPEX, MarginalRevenue 序列) 为迷你现金流跑 irr/payback
```
纯函数 `computeStorageMarginalValue(state, ΔE)` 两次调用既有 `runSandboxModel` 相减即可（复用命脉，不另立经济内核）。回答"继续加下去还有没有价值"= 边际 NPV 是否转正为负。建议 UI 出"边际收益 vs 容量"曲线（view 层加一张图，读取，不重算）。

---

## 十三、情景（§13）

至少三档峰谷价差情景（低/基准/高 `spread`），实现方式=对 `region.peakValleySpread` 做情景覆写（既有地区包已给 0.6/0.7，可再造"高压峰谷省"包）。预期因果（须测死方向）：低 `spread` ⇒ 套利腿可能 `≤0` 被关断、只剩消纳腿，储能价值大幅降；高 `spread` ⇒ 两腿皆活、最优容量右移、NPV 抬升。另建议叠"光伏比"情景（高/低 `pvCapacity`）驱动消纳腿。情景引擎沿用 R1 分层覆写，**不新增金融/债务情景**（§3 禁止）。

---

## 十四、敏感性（§14）

接线后，把以下键加入 `DEFAULT_SENSITIVITY_PARAMS`（当前因 E 层未消费被刻意排除，见 `sandbox-sensitivity.ts` 注释；**接线即解锁**）：

| 参数键 | 目标指标 |
|---|---|
| `tech.storageCapex`（已在集内） | NPV/IRR/Payback |
| `region.peakValleySpread`（**新增**，套利一阶杠杆） | 同上 |
| `tech.storageRoundTripEff`（新增） | 同上（效率→收益分母） |
| `project.storageEnergy`（新增，容量） | 同上（应显凹性拐点） |
| `project.storagePower`（新增，功率） | 同上（功率封顶区才敏感） |
| `tech.storageDegradation`（新增） | 同上 |
| `region.pvEquivalentHours`/`project.pvCapacity`（消纳率代理） | 消纳腿 |
| `tech.storageOm` | OPEX 项 |

注意 OAT 龙卷风是**单点 ± 扰动**，容量类参数在拐点两侧符号会变，可能低估——须用 §12 边际曲线补，龙卷风只给排序。`SENSITIVITY_VERSION` 须升版（§16）。

---

## 十五、与现有模型的兼容（§15，不推翻 R1–R8.8a）

- 参数映射（`sandbox-demo`）：`storageEnergy` headline 仍映射 `project.storageEnergy`(+联动 `storagePower=容量/2h`)；`spread` 未上 headline，故 10 参数演示模型默认态**不变**（除非新增第 11 个 headline，属产品决定，另裁）。
- 技术模型：仅**新增** `storageAnnualThroughput` 的功率/SOC/衰减封顶分支，`computeTechModel` 返回体加字段（加性），`pvAnnualEnergyYear1/annualEnergyBalance` 等纯函数一字不改。
- 经济模型：E1–E8 保持，只在 E3 加一条 `储能收益` 分量（=Δ_sto）。
- 敏感性/报告/视图：视图 `revenueItems` 由 3 项增至 5 项（拆"储能-套利""储能-光伏消纳"）；报告读 vm 不重算，自动反映。**这些是呈现层加性扩展**。
- 版本体系：见 §16。

---

## 十六、是否修改模型口径 —— 需创始人裁决（§16，本文档**不自行决定**）

诚实结论：**这是一次经济口径变更**（E3 收入构成改变），不是纯加性元数据（与 R8.7 只加 `inputProvenance` 不同）。逐条：

1. **是否需改 `MODEL_VERSION`？** **需要**。E3 现金流构成变了，`calcRef` 指向的公式不再等价，依 §13「改口径须升版」不可留 1.0.0。（夜批禁令「自主不得 bump MODEL_VERSION」正是本项被留人工的直接原因。）
2. **是否需新增模型版本？** 建议**新增独立版本轴** `STORAGE_MODEL_VERSION`（如 1.0.0）描述 SVE 口径，并令 `MODEL_VERSION` 1.0.0→次版本，`engineVersions` 增列 SVE；`TECH_VERSION` 与 `SANDBOX_PARAMS_VERSION` 因新参数/新封顶亦须各升次版本。
3. **是否需重生成黄金样本？** **需要**——且注意 **demo 默认态本身含 400kWh 储能**，接入收益后基线 NPV/IRR/回收期会变，现有 `sandbox-model.test` 黄金样本（storage>0）**必须重录**；`storageEnergy=0` 的场景逐字不变。
4. **历史版本是否保持不变？** 已发布的 v0.58.0（`MODEL_VERSION=1.0.0`）作为快照**不回改**；新口径仅在新版本生效。
5. **新模型是否只作用于新版本？** 代码上是；但**数据风险**：既有已保存项目下次运行会按新口径重算 → 老项目历史结论与新结论并存，需要创始人决定是否给老项目打"生成时版本"戳以冻结展示（属持久化语义决定）。

> 因上述任一"需要升版/重录黄金样本"都触及夜批硬禁令，故**本设计到此为止，不改代码、不改 `MODEL_VERSION`、不改黄金样本**，全部交创始人确认后再实现。

---

## 十六·五、Step 1 收口裁决记录（创始人 2026-09-08，已落档执行）

1. **ISSUE-1 · 选 A**：E4 维持单一平均电价 `Imp0 × p` 不改。套利增量口径采纳 `Δ_arb = M_arb × (p − p_valley/η)`，**不使用 `p_peak` 作为 E3 增量项**（E4 已按 `Imp0 × p` 计入基线购电成本，再用 `p_peak` 即重复计价）。本稿 §4.2/§4.4/§5/§6 已同步修订。强制声明：**V1 采用年度平均购电价基线上的储能增量价值估算，并非逐时峰谷电价模型**；逐时电价 / E4 分时化以后单独立项。
2. **ISSUE-2 · 批准 margin 优先分配**："单位经济价值 margin 高者优先占用共享储能循环预算；margin 相等时套利优先"，`M_arb + M_pv ≤ D_max`。Step 1 已证明的 I1/I2/I3、"η 下降时储能价值不增加"、"spread 增加时价值不下降"、"不变量不被破坏"全部保留为常驻测试。最优性理由（已写入模块文档与 §4.3）：两条价值腿在当前 V1 模型下均为**线性单位价值**且共享有限 `D_max`，因此 margin 优先（分数背包贪心）是当前简化模型中的最优分配规则。
3. **ISSUE-3 · 修订"必然存在最优容量"的表述**：统一改为"系统在给定容量搜索范围内寻找最优配置；可能存在内部最优点、端点最优，或在当前范围内持续增加/持续下降"。本稿 §三/§四·五/§11/§19/附 已同步；今后测试不得断言"必然存在 argmax"。
4. **ISSUE-4 · σ 时间代理保留**：`sigma = tech.storagePeakLoadShare` 与当前 V1 年度代理口径保留；方法论明确"**σ 不是逐时真实峰时电量，而是峰时可套利下网电量比例的年度代理**"，标记 `ASSUMPTION`、`needsProfessionalReview=true`（§4.1 已同步；放电侧 `σ·Imp0` 时间片口径随本裁决一并落档）。

本批范围＝设计文档、模块注释与测试说明文字的同步；**未接入 sandbox-model E3、未改 E4、未改 `MODEL_VERSION` / `TECH_VERSION` / 参数版本、未重录黄金样本、未改数据库、未改历史结果、未接支付、未进融资模型**。§16 五项版本裁决仍待 Step 2/3 前逐项人工放行。

---

## 十六·六、Step 2/3 接入收口记录（2026-09-08，v0.59.0）

**放行依据**：创始人指令「按照你的思路推荐继续完成项目」（2026-09-08，对 Step 1.5 实验报告 §13/§14 建议路线的批准），在此授权下执行 §16 五项裁决并按 USER.md「高风险项留创始人拍板」保留下述遗留项。§19 步骤 1（Step 1）此前已合入。

**§16 五项裁决执行情况**：

1. **§16.1 升 `MODEL_VERSION`**：✅ 1.0.0→**1.1.0**，注释写明「R9.0 Step 2 接入 SVE 储能价值 Δ_sto（E3b，加性收入项，E4/财务原语零改动）」。`calcRef` 随之为 `model@1.1.0`。
2. **§16.2 独立版本轴 `STORAGE_MODEL_VERSION`**：**未采纳**（授权内自主裁决，按宪法「冲突选更简单」）。`engineVersions` 保持 model/tech/finance 三轴不变：`TECH_VERSION` 仍 1.0.0（技术层零改动，SVE 是独立新模块 `sandbox-storage-value.ts`）、财务原语零改动。SVE 口径的真源＝本模块头注 + 本文档；若创始人要求第四轴可后补（纯加性）。
3. **§16.3 重录黄金样本**：✅ 全仓完成。storage>0 的 live 黄金全部按引擎真值重录（基线 NPV 4,277,409→**4,448,573**、IRR 23.7553→**24.3497**%、折现回收 5.28→**5.14** 年、ROI 4.0035→**4.0880**、首年收入 4,987,500→**5,014,991** 含 Δ_sto=**27,491**）；`storageEnergy=0` 场景**逐字节零 churn**（`sandbox-model.test` 焊点：E0 情景 gross 4,987,500 / net 3,030,500 / NPV 4,797,756 与 R2.4 一致）；**spread=0 ⟹ NPV 逐字节回落 4,277,409**（交叉验证：套利关断即等价旧引擎）。
4. **§16.4 历史版本不回改**：✅ v0.58.0 快照仅在 git 历史，新口径只在新版本生效。
5. **§16.5 老项目版本戳策略**：❌ **未做，仍待创始人裁决**。既有已保存项目下次重算将按 1.1.0 新口径出数（`calcRef` 会变为 model@1.1.0，与旧 1.0.0 行可区分）；是否给老项目打「生成时版本」戳冻结展示，属持久化语义决定，本批不擅权。

**实现清单**（§19 步骤 2–4 全部完成；步骤 5 敏感性解锁刻意延后）：

- `sandbox-params.ts`：+5 个 SVE 键（`tech.storagePeakLoadShare` σ=40%、`tech.storageSocMin` 10%、`tech.storageSocMax` 90%、`tech.storageDegradation` 2.5%/年、`tech.storageDischargeWindowHours` 2h/日，全 `ASSUMPTION`、pro 档、占位假设 source），`SANDBOX_PARAMS_VERSION` 1.1.0→**1.2.0**。`region.peakValleySpread`（默认 0.6）首次被消费。
- `sandbox-model.ts`：E3b 加性收入项 Δ_sto——逐年调 `storageValueDelta`（价格随通胀放大后传入，不再重复乘 inflFactor），`RevenueBreakdownY1` 新增必填 `storageValue` 列；6 个 SVE 键**仅在有储能时**校验（storage=0 缺键不报错——零 churn 前提）；notes 诚实输出 Δ_sto 值、S1 消纳腿为 0 的原因、SVE 被安全清零的逐年原因；`needsProfessionalReview` 保持 true。
- `sandbox-view.ts`：`revenueItems` 末尾**条件性**追加「储能价值(套利)」分项（=0 不出现，视图层零 churn）。
- 测试：`sandbox-model.test` 重录 + 新增「R9.0 Step2 · SVE 接线锚定」7 例（手算链 Δ_sto=112,000×0.245455=27,491、零 churn 焊点、spread=0 交叉验证、缺键 scoping、spread 阶梯 0→0.6→1.0→1.5 严格递增、elecPrice 耦合 ∂margin/∂p=1−1/η<0、FLIP 正贡献 +70,889）；`sandbox-causality` P1-2 钉桩改写为「基线经济下 NPV 仍随储能容量严格单调下降（真实经济信号：NPV=0 需 spread≈1.568）」+ P2-6 移除 spread + 新增 spread/FLIP 因果块 + 轴 C 改名「NPV 随电价下降」并收紧为严格单调断言（旧名「上升」与实际方向相反，属 v0.58.0 既有笔误）；`demo-linkage`/`demo`/`report-dynamic` 版本与镜像钉桩同步；`sandbox-store`（unit+integration）、`sandbox-demo`（integration）、`sandbox-solution-store`、`sandbox-solution-loop` 黄金重录。

**刻意不做（本批边界）**：

- ~~**敏感性扫描集未解锁 spread**（§19 步骤 5 延后）~~ → **已于 2026-09-08 阶段1 收口（创始人批准"Spread 敏感性"，v0.61.0）**：`region.peakValleySpread` 加入 `DEFAULT_SENSITIVITY_PARAMS`（±15%，电价同族），`SENSITIVITY_VERSION` 1.2.0→**1.3.0**，E3/E4/finance/参数默认值零改动；敏感性黄金测试新增"spread 解锁合理性"块（默认集内/方向为正/TOP1 仍为充电单价 + 低/中/高 spread 0.3/0.6/1.0 下储能价值与 NPV 严格单调增、IRR 单调增、折现回收期严格单调减 + spread=0 储能价值诚实归零）。
- 消纳腿（PV 富余）保持恒 0：S1 互斥缺口（年度确定性平衡下 Exp0>0⟺Imp0=0）已在 notes 与本档声明，分时切片/代理分解待立项（Step 1.5 报告 §S1）。
- 融资模型（R8.8b 贷款/DSCR/Equity IRR）、逐时电价、E4 分时化：均未动。

**验证**：`tsc --noEmit` 0 错；`eslint` 0 问题；`test:unit` **58 文件 / 1026 例全绿**（含 61 例 SVE 独立单测 + 7 例接线锚定）；集成套件真连 Neon 复跑（见 CHANGELOG v0.59.0 验证段）。

---

## 十七、对现有代码的影响清单（实现期，非本期）

只列触点，供确认后逐项实现：`sandbox-params.ts`（+5 新参数、版本++）→ `sandbox-tech.ts`（`storageAnnualThroughput` 升级或新建 `storageValue` 纯函数、`TECH_VERSION++`）→ 新建 `src/server/sandbox-storage-value.ts`（SVE：分配+两腿+账本，纯函数、可离线测死）→ `sandbox-model.ts`（E3 接入 Δ_sto、`engineVersions` 增列、`MODEL_VERSION++`、`needsProfessionalReview` 保持 true）→ `sandbox-view.ts`（收入卡拆分、可选边际曲线图）→ `sandbox-sensitivity.ts`（解锁参数、版本++）→ `sandbox-report.ts`（读 vm 自动带新分项，无需重算）。**不动**：`sandbox-finance.ts`、`parameter-engine.ts`、数据库/schema、认证/支付、R8.7 溯源管道。

---

## 十八、风险与方向性偏差（§20 诚实）

- **R-A 逐时无 vs 年度法（最大）**：本链无 8760h 曲线。套利收益依赖"谷充峰放"的**时间共现**，消纳依赖"光伏出力与充电负荷错峰"的共现；年度平均会**高估**两者（与 S1 已知高估自用同性质）。缓解：`σ`(峰时段占比) 与 `H_dis`(峰时长) 作**保守折扣代理**，默认给偏低假设并在 `notes` 标"随时间匹配假设，可能高估"，`needsProfessionalReview=true`。真值须逐时模型（远期，非本 V1）。
- **R-B 净负荷重叠与预算分配（ISSUE-2 裁决后更新）**：负荷峰与光伏富余峰通常不重叠；两腿共享 `D_max` 的分配已由"固定先套利后消纳"改为**margin 优先（分数背包贪心最优，创始人 2026-09-08 批准）**，先后由两腿 margin（即电价参数与情景）决定，不再是固定假设。年度代理对"时间共现"的高估风险不变（R-A），"仅消纳/仅套利"开关情景仍建议保留作披露。
- **R-C 充电功率与变压器/并网容量**：套利额外谷充功率可能撞 `gridCapacity`（P1-3 未解），本期不校验，须注明"未含功率约束，可能高估可执行度"。
- **R-D 基线含储能**：demo 默认 400kWh，接入即改黄金样本（见 §16.3），非零 churn，务必人工确认后再录。
- **R-E 全 `ASSUMPTION`**：`σ/δ_s/H_dis/SocW` 及 `spread` 皆占位；不得对外当 FACT。

---

## 十九、最小实现任务树（口径获批准后，严格顺序，每步带测）

0. **前置批准闸**：创始人确认 §16 五项（版本轴、黄金样本重录、老项目版本戳策略、是否上 headline 第 11 参）。未批不进入 1。
1. `sandbox-storage-value.ts` 纯函数：`storageThroughputCapped`（§4.2 功率/SOC/衰减）+ `energyFlowLedger`（§6 分配+去重）+ `storageValueDelta`（§4.4 两腿）。**独立单测**：单位、边界、`η` 单调、`E/P` 双封顶、SOC 缩、衰减降、三条去重不变量、`storage=0 ⇒ Δ=0`、无 NaN/负。
2. `sandbox-params.ts` 加 5 新参数（版本++）；`sandbox-tech.ts` 暴露新字段（版本++）；`sandbox-causality` 扩：加储能 NPV **不再单调恶化**的反向测试（替换 v0.58.0 钉死的"P1-2 现状"断言）；容量响应按 A 内部最优 / B 范围内持续上升 / C 范围内持续下降三态如实断言，**不预设必然存在 argmax**（ISSUE-3）。
3. `sandbox-model.ts` E3 接 Δ_sto（`MODEL_VERSION++`、重录 storage>0 黄金样本）；命脉测试：改 `spread`/`storageCapex`/`storageEnergy` → NPV 变。
4. `sandbox-view.ts`/`sandbox-report.ts` 呈现拆分；报告三情景（§13）结论不同、无硬编码。
5. `sandbox-sensitivity.ts` 解锁参数（版本++）；边际曲线（§12）helper + 测。
6. 五门：`tsc` 0 / `eslint` 0 / `test:unit`（基线上净增，全绿）/ `build` 0（无新路由）/ 集成（纯函数不连库，应维持 134 不变）。
7. `CHANGELOG`/`README`/`TESTING` 同步 + 一次提交。
> 每步独立可回退、独立绿；步骤 1–2 为纯函数+测试，**不改经济口径**，可在闸 0 批准后先行合入（不 bump 任何 *_VERSION，不录黄金），步骤 3 起才触版本轴——便于分批人工放行。

---

## 附：测试计划要点（§19 内嵌）

正向：套利随 `spread↑/η↑/E↑(封顶前)/P↑(封顶前)` 单调增；消纳随 `Exp0↑/p↑/feedIn↓` 增。反向（去重不变量）：`M_arb+M_pv≤D_max`、`M_pv/η≤Exp0`、套利不新增电量抵扣；同一度光伏不双计。退化：`storage=0 ⇒ Δ_sto=0 ⇒ 基线逐字不变`；`σ=0 ⇒ 无套利`；`spread=0 ⇒ 无套利`；`E 极大 ⇒ 收益饱和`。鲁棒：极端 6 轴组合无 NaN/Infinity/负能量。指标：容量响应**不预设形态**——允许内部最优（单峰）、端点最优或范围内单调增/减，测试以 A/B/C 三态分类如实断言（ISSUE-3，不得断言"必然存在 argmax"）。回归替换：删除/改写 v0.58.0 中"加储能 NPV 单调恶化"的**钉死断言**（该断言是记录 P1-2 现状，实现后即过期）。

---

**Step 1 已于 2026-09-08 收口（四项裁决落档 §十六·五）；Step 2/3 已于同日依创始人「按照你的思路推荐继续完成项目」指令接入生产并收口（落档 §十六·六，v0.59.0）。`MODEL_VERSION` 1.1.0、`SANDBOX_PARAMS_VERSION` 1.2.0、storage>0 黄金全仓重录、storage=0 零 churn 焊点锚定、spread=0 与旧引擎逐字节交叉验证。遗留待创始人：①老项目重算版本戳策略（§16.5）；②敏感性扫描集解锁 spread（§19 步骤 5，需 SENSITIVITY_VERSION++）；③消纳腿分时建模（S1 接口缺口）。融资模型（R8.8b）、逐时电价、E4 分时化均未动。**

> **后续进展（2026-09-08）**：遗留②已随**阶段1「Spread 敏感性」**收口（创始人批准，v0.61.0）——`SENSITIVITY_VERSION` 1.2.0→1.3.0，spread 入默认扫描集（±15%），低/中/高合理性验收全过，E3/E4/finance 零改动（见 §十六·六"刻意不做"块的销项记录与 CHANGELOG v0.61.0）。遗留①已由创始人批准"历史项目生成时模型版本冻结策略"并落地（v0.60.0，STORE_VERSION 1.0.3，零 schema 迁移）；遗留③消纳腿分时建模仍待立项。
