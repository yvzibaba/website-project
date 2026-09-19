# V2 · GitHub 底座选型（第二轮 · 扩大搜索 + 三域拆解）

> 状态：**定稿，待创始人裁决**
> 本轮性质：纯研究 + 纯文档。**零代码改动**（内核 / 黄金样本 / 旧参数 / Legacy 全部零触碰）。
> 上一轮：`docs/V2_GITHUB_BASE_SELECTION.md`（第一轮 4 个指定候选）
> 原始数据：`research/github-round2/`（76 个文件，全部可复现）

---

## 0. 为什么要有第二轮（方法论上的自我纠错）

### 0.1 第一轮的结论有什么问题

第一轮审计了 4 个候选（`nextjs/saas-starter`、`Str4vinci/breos`、`felixtgd/ferntree`、`dailab/elvis`），4 个全部落选，结论是「主底座必须自建，不 fork 任何候选」。

这个结论**在逻辑上不成立**。它隐含了：

```
第一轮给的 4 个候选都失败了
        ↓（这一步是逻辑跳跃）
GitHub 上没有值得当底座的成熟项目
        ↓
继续用现有 TS / Next 主干
```

真正被证明的只有第一句。第二句需要**独立证据**。第一轮只在 §2 做了 6 条定向检索就收口，覆盖面远远不够——尤其是：

- 第一轮**完全没有审计能源计算域的成熟项目**（pvlib / SSC / REopt / PyPSA 一个都没进候选）；
- 第一轮**完全没有审计充电基础设施域**（OpenEMS / EVerest / CitrineOS / steve 一个都没进候选）；
- 第一轮**完全没有审计重卡/车队电动化专用项目**。

而本轮要决策的恰恰是「重卡光储充项目决策平台」——**能源计算**和**充电基础设施**正是这个产品的两个技术核心。第一轮把它们整个漏掉了。

所以第二轮的原则是：

> **「没有找到合适的底座」必须用证据证明。**
> 不能因为第一轮 4 个候选失败，就自动回到旧架构。
> 必须先把所有**可能**是底座的项目找出来，逐一审计，再落结论。

### 0.2 本轮审计方法（三个仪器，各有盲区）

| 仪器 | 用途 | 实现 |
|---|---|---|
| **定向元数据审计**（主仪器） | 对**已知名字**的成熟项目，直接抓 GitHub API 元数据 + 完整文件树 + LICENSE 原文 + 依赖清单 | `_scripts/fetch_r2*.sh`（跟随 301 重定向） |
| **检索发现**（辅助仪器） | 只用于**发现未知名字**的项目 | `/search/repositories`，`_scripts/fetch_r2f.sh` |
| **原始文件取证** | LICENSE / package.json / pyproject.toml / README 原文，不靠二手描述 | `_scripts/fetch_raw.sh` |

> ⚠️ **本报告的一个刻意选择：主仪器是「定向审计」而不是「检索」。**
> 原因见 §0.3 —— 本轮实测证明 GitHub 仓库检索在这个任务上是一个**很弱的仪器**。

### 0.3 两个方法学缺陷（实测记录，必须写下来）

#### 缺陷一：`-排除词` 会让检索静默清零（严重）

第一组检索（`search_r2_q1..q8`）结果被 `awesome-*` 类清单仓库淹没（如 `sindresorhus/awesome` 507k★、`public-apis/public-apis` 481k★）。为过滤它们，第二轮检索（`s2_q1..s2_q10`）在查询里加了 `-awesome`。

结果：**10 条检索全部返回 `total_count=0`**。

这不是「GitHub 上真的没有」，是查询语法把结果清零了。用探针复现（`probe_awesome_bug_20260919.txt`，2026-09-19 实测）：

| 探针 | 查询 | total_count |
|---|---|---|
| A | `battery+storage+dispatch+optimization` | **24** |
| B | `+language:Python` | **95** |
| C | `+stars:>30` | **5** |
| D | `+-awesome` | **0** ← 归零 |
| E | `+language:Python+stars:>30` | **2** |

`-awesome` 一加，24 变 0。修正方式：**不用 `-term`**，改为取回后再客户端过滤（`_scripts/fetch_r2f.sh` 注释里已写明）。

#### 缺陷二：多概念自然语言查询因 AND 语义大量归零

第三轮检索（`s3_q1..q10`）的实测结果：

| # | 查询 | total | 命中 |
|---|---|---|---|
| q1 | `battery storage dispatch optimization language:Python stars:>30` | **0** | — |
| q2 | `energy management system language:TypeScript stars:>5` | 1 | `energywebfoundation/origin` |
| q3 | `OCPP charging station management stars:>30` | 3 | `steve` / **`citrineos-core`** / `ocpp-csms` |
| q4 | `heavy duty truck charging depot` | 1 | **`NatLabRockies/hdev-depot-charging-2021`** |
| q5 | `site energy optimization PV storage EV charging stars:>5` | **0** | — |
| q6 | `project finance model energy cash flow` | 4 | 全部 0★（无价值） |
| q7 | `microgrid techno-economic optimization stars:>15` | **0** | — |
| q8 | `load profile time series energy language:TypeScript stars:>3` | **0** | — |
| q9 | `solar PV simulation language:TypeScript stars:>5` | 403 | 配额耗尽 |
| q10 | `fleet electrification charging infrastructure planning` | 403 | 配额耗尽 |

**10 条里 4 条返回 0、2 条配额失败。**

最讽刺的是 q7：`microgrid techno-economic optimization` 返回 0，但 **REopt 就是 NREL 的微网技术经济优化模型**，125★/47★，活跃维护。它没被搜到，因为 GitHub 仓库检索是在 name + description + README 上做 **AND 匹配**，多概念长查询必然归零。

**这两个缺陷合起来的结论是**：检索只能用来「撞见」新项目，不能用来「证明没有」。
- 本轮**真正靠检索发现**的新项目只有两个：`citrineos/citrineos-core`（q3）和 `NatLabRockies/hdev-depot-charging-2021`（q4）。这两个恰好都是关键发现——但那是运气，不是方法。
- 因此**本报告的覆盖面来自定向审计清单**（§1），不是来自检索总数。

### 0.4 复现方式

```bash
# 前置：本机需要走 GHelper 隧道访问 github.com（见 skill: github-via-ghelper）
bash ~/.workbuddy/skills/github-via-ghelper/scripts/ghproxy.sh curl -sS "https://api.github.com/repos/pvlib/pvlib-python"
```

- 元数据：`research/github-round2/meta_*.json`（GitHub `/repos/{owner}/{repo}` 原样落盘）
- 文件树：`research/github-round2/tree_*.json`（`/git/trees/{sha}?recursive=1`）
- 许可证原文：`research/github-round2/lic_*.txt`
- 依赖清单：`research/github-round2/mf_*.json|.toml|.prisma`
- 检索：`research/github-round2/search_r2_q*.json` / `s2_q*.json` / `s3_q*.json`
- 脚本：`research/github-round2/_scripts/`

---

## 1. 候选总表（26 个真实仓库，全部硬数据）

数据抓取时间：**2026-09-19**。`pushed` = 最后提交日期。

### 1.1 产品 / SaaS 底座域（TypeScript 为主）

| 仓库 | ★ | fork | 语言 | License | pushed | 形态 |
|---|---|---|---|---|---|---|
| `nocodb/nocodb` | 65,013 | 5,059 | TS | NOASSERTION（AGPL 系） | 2026-09-19 | Airtable 替代（低代码数据库） |
| `makeplane/plane` | 59,622 | 5,803 | TS | **AGPL-3.0** | 2026-09-18 | Jira 替代（项目管理） |
| `twentyhq/twenty` | 57,050 | 9,179 | TS | NOASSERTION（AGPL 系） | 2026-09-19 | Salesforce 替代（CRM） |
| `calcom/cal.diy` | 48,553 | 15,172 | TS | MIT | 2026-09-14 | 排程基础设施 |
| `t3-oss/create-t3-app` | 29,117 | 1,535 | TS | MIT | 2025-12-13 | Next.js 脚手架 |
| `vercel/nextjs-subscription-payments` | 7,719 | 1,762 | TS | MIT | 2025-01-23 | ⚠️ **ARCHIVED** |
| `ixartz/SaaS-Boilerplate` | 7,421 | 1,334 | TS | MIT | 2026-09-02 | SaaS 模板（订阅/权限/i18n） |
| `boxyhq/saas-starter-kit` | 4,935 | 1,229 | TS | Apache-2.0 | 2026-07-20 | 企业 SaaS 模板（SSO 强） |
| `energywebfoundation/origin` | 109 | — | TS | — | — | 能源凭证/市场（检索命中） |

### 1.2 能源计算域（Python / C / C++ / Julia）

| 仓库 | ★ | fork | 语言 | License | pushed | 形态 |
|---|---|---|---|---|---|---|
| `PyPSA/PyPSA` | 2,154 | 699 | Python | MIT | 2026-09-19 | 电力系统分析（潮流/优化） |
| `pvlib/pvlib-python` | 1,668 | 1,225 | Python | **BSD-3** | 2026-09-16 | **PV 性能仿真标准库** |
| `NatLabRockies/EnergyPlus` | 1,570 | 490 | C++ | NOASSERTION（DOE BSD 风格） | 2026-09-18 | 整栋建筑能耗仿真 |
| `NatLabRockies/SAM` | 486 | 219 | C++ | **BSD-3** | 2026-09-18 | 系统顾问模型（PV+储能财务） |
| `oemof/oemof-solph` | 420 | 151 | Python | MIT | 2026-09-19 | 能源系统 LP/MILP 优化 |
| `calliope-project/calliope` | 373 | 110 | Python | Apache-2.0 | 2026-09-09 | 多尺度能源系统建模 |
| `GenXProject/GenX.jl` | 365 | 153 | Julia | **GPL-2.0** ⚠️ | 2026-08-03 | 电力容量扩展优化 |
| `NatLabRockies/pysam` | 150 | 85 | C | **BSD-3** | 2026-09-02 | SAM 的 Python 封装 |
| `NatLabRockies/reV` | 143 | 63 | Python | **BSD-3** | 2026-08-11 | 地理空间技术经济潜力评估 |
| `NatLabRockies/REopt_API` | 125 | 68 | Python | **NOASSERTION**（命名受限 BSD，见 §3） | 2026-09-18 | **微网技术经济优化后端** |
| `NatLabRockies/ssc` | 94 | 118 | C++ | **BSD-3** | 2026-09-18 | SAM 仿真内核 |
| `NatLabRockies/REopt.jl` | 47 | 48 | Julia | **Apache-2.0** | 2026-09-18 | REopt 的 Julia 重写（干净许可） |
| `epri-dev/StorageVET-deprecated` | 64 | — | Python | BSD-3 | 2026-08-19 | ⚠️ 名称即 deprecated |

### 1.3 充电基础设施域

| 仓库 | ★ | fork | 语言 | License | pushed | 形态 |
|---|---|---|---|---|---|---|
| `OpenEMS/openems` | 1,559 | 682 | Java | **AGPL-3.0** ⚠️ | 2026-09-19 | 能源管理系统（含 EMS/充电） |
| `steve-community/steve` | 1,126 | 497 | Java | **GPL-3.0** ⚠️ | 2026-09-18 | OCPP 1.6 充电站管理 |
| `mobilityhouse/ocpp` | 1,043 | 394 | Python | MIT | 2026-07-19 | OCPP 协议实现（Python 库） |
| `EVerest/EVerest` | 265 | 198 | C++ | Apache-2.0 | 2026-09-19 | EV 充电软件栈（车载/桩侧） |
| **`citrineos/citrineos-core`** | **294** | — | **TypeScript** | **Apache-2.0** | 2026-09-19 | **OCPP 2.0.1 CSMS 后端** |
| `citrineos/citrineos-operator-ui` | 29 | — | TS | Apache-2.0 | 2026-07-07 | 运营商 UI |
| `citrineos/citrineos-ocpi` | 23 | — | TS | Apache-2.0 | 2026-09-15 | OCPI 漫游模块 |

### 1.4 重卡专用域（本轮最关键的新发现）

| 仓库 | ★ | fork | 语言 | License | pushed | 形态 |
|---|---|---|---|---|---|---|
| **`NatLabRockies/hdev-depot-charging-2021`** | **16** | 13 | Jupyter/Python | **BSD-3** | 2021-06-21 | ⚠️ **ARCHIVED**，但：**重卡电动化场站充电负荷曲线生成** |

---

## 2. 分域审计结论

### 2.1 产品 / SaaS 底座域：**没有一个是可整体 fork 的**

三个「看起来能当产品底座」的项目，全部在**数据层或授权层**与我们的工程冲突：

#### `ixartz/SaaS-Boilerplate` —— 框架版本几乎完全一致，但数据层是另一套

实测依赖（`mf_ixartz_package.json`）：

| 维度 | ixartz | 本项目 | 冲突 |
|---|---|---|---|
| next | `^16.2.9` | `16.3.4` | ✅ 同代 |
| react | `^19.2.7` | `19.2.8` | ✅ 同代 |
| tailwindcss | `^4.3.1` | `^4` | ✅ 同代 |
| zod | `^4.4.3` | `^4.5.4` | ✅ 同代 |
| vitest | `^4.1.9` | `^5.0.0` | ⚠️ 大版本回退 |
| typescript | `^6.0.3` | `^5` | ⚠️ 大版本前跳 |
| **ORM** | **`drizzle-orm@^0.45.2`** | **`prisma@^6`** | ❌ **完全不同** |
| **认证** | **`@clerk/nextjs@^7.5.2`（SaaS 付费）** | **`next-auth@5.0.0-beta.32`（自托管）** | ❌ **完全不同** |

工程规模：155 blob（`tsx:54 ts:40`），测试 6 目录 / 14 测试文件，CI 4 条 workflow。

**结论**：框架层同代不代表能复用。要吸收它，等于把 **Prisma → Drizzle** 和 **next-auth → Clerk** 两套数据/身份层整体替换，并且引入 Clerk 这个付费 SaaS 依赖（数据出境 + 长期成本）。这不是「复用底座」，这是「重写数据层」。**采用范围 = 仅产品形态与目录约定的参考**。

#### `boxyhq/saas-starter-kit` —— Prisma 对上了，但 React 代际 + Stripe 绑定冲突

实测依赖（`mf_boxyhq_package.json`）：

- ✅ `@prisma/client@6.10.0`（与我们的 Prisma 6 同代）
- ✅ `@next-auth/prisma-adapter@1.0.7`
- ❌ `next@15.5.14`（我们 16.3.4）、`react@18.3.1`（我们 19.2.8）→ **整体回退一代**
- ❌ `next-auth@4.24.13`（我们 5.0.0-beta.32）→ 认证 API 不兼容
- ❌ `stripe@17.7.0` + `@boxyhq/saml-jackson@26.2.0` + `@retracedhq/*` + `mixpanel-browser` → **支付与 SSO 强绑定付费/第三方服务**
- ⚠️ 工程规模 327 blob，测试仅 31 条，CI 1 条 workflow

**关键设计取向冲突**：boxyhq 走的是「**国际 SaaS 通用形态**」——Stripe 订阅计费 + SAML SSO + Mixpanel + Retraced 审计日志。而我们的商业模式是「**中国产业项目服务**」，收费形态是项目服务费 + 企业年费，不需要 Stripe，需要的是**项目/证据/参数可信度**这套中国特色资产。它的形态与我们的第一层需求（用户/企业/项目/权限/订阅/报告/后台）**只有「用户/企业/权限」三项真正重合**。

**结论**：Prisma 对上了，但整体代际回退 + Stripe/SSO 绑定 + 测试稀薄，收益不足以覆盖重写代价。**采用范围 = 权限模型与企业多租户表结构的参考**（其 `mf_boxyhq_schema.prisma` 已存档）。

#### `vercel/nextjs-subscription-payments` —— 已归档

7,719★ 但 `archived=true`，pushed 停在 **2025-01-23**。归档项目不作为底座。

#### 大 star 的 SaaS 项目（nocodb / plane / twenty / cal.com）全部排除

理由一致且简单：

1. **形态错位**：它们是「最终产品」（Airtable / Jira / CRM / 排程替代品），不是「可嵌入的产品底座」。我们的产品是**能源项目决策平台**，不是要做 Jira。
2. **License 冲突**：`plane` **AGPL-3.0**、`nocodb`/`twenty` NOASSERTION（AGPL 系）。AGPL 对网络服务有传染性——闭源商用 SaaS 直接排除。`cal.com`（MIT）License 干净，但领域完全无关。
3. `create-t3-app` 只是脚手架（29k★），不是产品底座。

### 2.2 能源计算域：**成熟度极高，但无一例是 TypeScript**

这是本轮最重要的结构性发现：

> **能源计算的成熟开源成果，100% 存在于 Python / C / C++ / Julia 生态里，TypeScript 生态里一个都没有。**

实测证据：

- `pvlib/pvlib-python`：1,668★，BSD-3，**PV 性能仿真的事实标准库**。466 blob / 188 个 `.py` / 134 个测试文件 / 9 条 CI workflow。功能覆盖：太阳位置、辐照度分解与透射、组件温度模型、单/双二极管 I-V 模型、系统损耗、时间序列。**这是「PV 物理计算」A 类能力的唯一正确答案。**
- `NatLabRockies/ssc` + `pysam` + `SAM`：**SAM（System Advisor Model）内核**。SSC（94★，BSD-3，C++）是底层仿真+财务模型；pysam（150★，BSD-3，C）是 Python 封装；SAM（486★，BSD-3）是桌面应用。三者构成 NREL 官方「PV 性能 + 财务」全栈。
- `NatLabRockies/REopt_API`（125★）与 `REopt.jl`（47★）：**微网技术经济优化**——这正是「光储充项目应该配多大、划不划算」这一类问题的官方参考实现。REopt_API 规模 2,136 blob / 626 `.py` / 142 测试 / 7 CI；REopt.jl 1,561 blob / 100 `.jl` / 107 测试 / 4 CI。**但许可证有陷阱，见 §3。**
- `PyPSA`（2,154★, MIT）、`oemof-solph`（420★, MIT）、`calliope`（373★, Apache-2.0）：能源系统优化框架，MIT/Apache 许可干净，但都是**系统级规划**（输电网/区域能源），与「单站/单场项目决策」粒度不同。
- `GenX.jl`（365★）**GPL-2.0**，直接排除。
- `reV`（143★, BSD-3）：地理空间技术经济潜力评估——用于「**在哪建**」，与我们「上游产业机会发现」层有方法论关联。
- `EnergyPlus`（1,570★）：整栋建筑能耗仿真，与重卡场站**无关**，排除。
- `StorageVET`：正式仓库已改名 `StorageVET-deprecated`（64★, BSD-3），**名称即退役声明**，排除。

**结论**：

- 能源计算域**有极高质量的可借鉴对象**，但**没有可直接当底座的 TypeScript 项目**。
- 引入 Python/Julia 运行时意味着**双语言工程栈**（构建、部署、测试、类型边界、调用协议全都要新增）——对独立创业者是明确的长期负债。
- 因此能源计算的正确形态是 **A 类（借方法与公式，在 TS 内重写）**，而不是「引入一个 Python 服务」。这一点在下一份文档 `V2_FINAL_BASE_ARCHITECTURE.md` 展开。

### 2.3 充电基础设施域：**唯一一个成熟的 TypeScript 底座级项目，但它是 CSMS 不是产品**

#### `citrineos/citrineos-core` —— 本轮最重要的正向发现

| 项 | 值 |
|---|---|
| URL | https://github.com/citrineos/citrineos-core |
| ★ / fork | 294 / — |
| 语言 | **TypeScript** |
| License | **Apache-2.0**（商用友好，无传染性） |
| 最后提交 | 2026-09-19（**当天仍在提交**） |
| 规模 | 2,753 blob；`ts:1813 tsx:292 json:449 yaml:74 pem:20` |
| 测试 | 374 个测试目录文件 / 425 个含 test|spec 的文件 |
| CI | **15 条 workflow** |
| 结构 | `apps/`（服务） + `packages/`（共享库） + `scripts/` + `LICENSES/`（REUSE 合规） |
| 技术栈 | Fastify + `sequelize-typescript` + `redis` + `ajv` + `@fastify/swagger` |
| 能力 | **OCPP 2.0.1 CSMS**（充电站管理系统）后端 |

为什么它重要：

1. **它是唯一一个「充电基础设施 + TypeScript + Apache-2.0 + 高测试覆盖 + 高 CI 密度」的项目。** 2753 blob / 374 测试 / 15 CI 是**产品级工程量**，不是玩具。
2. 它的**领域模型**（ChargingStation / Connector / Transaction / ChargingProfile / MeterValue / Location / Tariff）正是我们第三层「充电负荷」要表达的对象。
3. 它示范了一个**通信协议栈（OCPP）在 TypeScript 里怎么分层**——这决定我们未来要不要接真实充电桩数据。

但它**不能当产品底座**：

1. **形态错位**：CSMS 是「管桩的后端服务」，我们做的是「项目投资决策平台」。CSMS 里没有用户、企业、项目、方案、报告、订阅——它的 25 个核心概念里，与「产品/SaaS」相关的**是 0 个**。
2. **数据层冲突**：它用 `sequelize-typescript`（不是 Prisma）。我们的 25 个 Prisma model / 14 个 enum 是既有资产，不可能为它换成 Sequelize。
3. **它要求真实硬件**：OCPP 的价值在于「真桩接入」。我们阶段一**明确不做真实桩接入**（见战略文档 §3.3），所以它的核心价值现阶段用不上。

**结论**：**`citrineos-core` = 底座 C（充电基础设施）的「架构与领域模型参照」，不是 fork 对象。** 采用方式是「读它的分层、抄它的领域概念命名、借它踩过的坑」，而不是「拉代码进来」。

#### 其余充电项目全部排除

| 仓库 | 排除理由 |
|---|---|
| `OpenEMS/openems` | **AGPL-3.0** → 闭源 SaaS 传染；Java 技术栈 |
| `steve-community/steve` | **GPL-3.0** → 同上；Java；仅 OCPP 1.6 |
| `EVerest/EVerest` | C++（5,355 blob 巨型工程），面向**车载/桩侧固件**，不是服务端；引入即背上 C++ 构建链 |
| `mobilityhouse/ocpp` | MIT 干净，但只是**协议库**（Python，486 blob 里 387 个是 JSON schema）；单薄的库，不是底座 |
| `energywebfoundation/origin` | 109★，能源凭证/市场方向，与项目决策无关 |

### 2.4 重卡专用域：**有参考实现，且它直接击中我们的 C 类核心**

#### `NatLabRockies/hdev-depot-charging-2021` —— 关键证据

| 项 | 值 |
|---|---|
| URL | https://github.com/NatLabRockies/hdev-depot-charging-2021 |
| ★ | 16 |
| License | BSD-3-Clause |
| 语言 | Jupyter Notebook / Python |
| 最后提交 | **2021-06-21** |
| 状态 | **ARCHIVED** |

对应的论文/工作：NREL 2021 年研究 **"Heavy-Duty Truck Electrification and the Impacts of Depot Charging"**，代码用于**生成重卡场站（depot）充电负荷曲线**。README 原文标注 "provided as-is without dedicated support"。

**为什么这个 16★ 的小仓库比很多万星项目更重要**：

我们的「必须自主开发」清单里，有一项是「**重卡充电负荷模型**」。这个仓库的存在证明：

1. **重卡场站充电负荷建模是有学术/工程参考的**——它不是无人区，不是必须从零推导的东西；
2. 它给出了**建模路径**：车队日行驶循环 → 到达/离开时间分布 → SOC 需求 → 桩功率分配 → 站点聚合负荷曲线；
3. 它的 License 是 BSD-3（干净，方法可自由借鉴重写）；
4. 它的**代码已归档且停更 5 年**——正好说明「不值得依赖它运行」，但**值得读它的方法并在 TS 里重写**。

**结论**：把「重卡充电负荷模型」从「纯 C 类从零自研」**降级为「B 类：借鉴方法后重写」**。我们的**独有性不在建模方法上，而在「中国重卡车型/运距/电价/场站约束」的本地化参数与真实数据回流上**。这是一个更准确、也更诚实的护城河定位。

---

## 3. 许可证取证：REopt 的「命名限制条款」（本轮必须记录的法律发现）

`REopt_API` 的 GitHub License 字段是 **NOASSERTION**（无法自动识别）——这不是「没有 License」，而是「自定义 License」。读了原文（`lic_REopt_API.txt`）才发现关键条款：

```
REopt®, Copyright (c) 2019, 2023 Alliance for Sustainable Energy, LLC

1. Redistributions of source code must retain the above copyright notice...

2. Redistributions in binary form must reproduce the above copyright notice...

3. Redistribution of this software, without modification, must refer to the software
   by the same designation. Redistribution of a modified version of this software
   (i) may not refer to the modified version by the same designation, or by any
   confusingly similar designation, and (ii) must refer to the underlying software
   originally provided by Alliance as "REopt®". Except to comply with the foregoing,
   the term "REopt®", or any confusingly similar designation may not be used to refer
   to any modified version of this software ... without the prior written consent of Alliance.

4. The name of the copyright holder(s), any contributors, the United States Government,
   the United States Department of Energy, or any of their employees may not be used to
   endorse or promote products derived from this software without specific prior written
   permission...
```

这是 **BSD-3 + 商标/命名附加条款（name-encumbered）**。对我们的含义：

| 场景 | 是否可行 |
|---|---|
| 借鉴 REopt 的**数学建模方法**（MILP 目标函数、约束形式），在 TS 里重写 | ✅ 可行（方法/思想不受版权保护） |
| 直接**搬运 REopt 源码**并闭源商用 | ⚠️ 需要让法务判读——尤其 §3 要求修改版**不得**用「REopt」或相似名称，且必须声明底层源自 Alliance 的 REopt® |
| 在产品宣传中说「基于 NREL REopt®」 | ❌ **必须事先取得 Alliance 书面同意** |
| 把 REopt 做成 SaaS 后端 API | ⚠️ 二进制分发条款（§2）+ 命名条款（§3）叠加，商业闭源 SaaS 场景**须法务审查** |

**对比：`REopt.jl` 的 License 是干净的 Apache-2.0**（已读 `lic_REopt.jl.txt` 全文确认）。

所以 REopt 系的正确使用姿态是：

> **读 `REopt_API` 的建模思路（它是完整 Python 实现，可读性最好），但不在产品中使用任何 REopt 代码或名称。**
> 若未来确实需要搬源码，优先考虑 **Apache-2.0 的 `REopt.jl`**，而不是命名受限的 `REopt_API`。

这条发现直接推翻了「REopt 是一个干净的 BSD 底座候选」这一乐观假设——**这也是本轮为什么必须读许可证原文而不是信 GitHub 的 License 字段的原因**。

---

## 4. 三条负向结论（比正向发现更重要）

### 负向结论 1：**不存在「一个项目同时是产品底座 + 能源计算底座 + 充电底座」**

三个域的真实分布：

| 域 | 存在成熟开源？ | 是 TypeScript？ | 与我们的 License/技术栈兼容？ | 能否 fork 当底座？ |
|---|---|---|---|---|
| 产品 / SaaS | ✅ 很多 | ✅ 很多 | ⚠️ 数据层/授权层几乎都不兼容 | ❌ 没有 |
| 能源计算 | ✅ **非常成熟** | ❌ **一个都没有** | ✅ BSD/MIT 居多（除 GenX GPL） | ❌ 语言不通 |
| 充电基础设施 | ✅ 少数 | ✅ **只有 citrineos-core** | ✅ Apache-2.0 | ⚠️ 形态错位（是 CSMS 非产品） |
| 重卡专用 | ⚠️ 有一个已归档的 | ❌（Jupyter） | ✅ BSD-3 | ❌ 已归档、已停更 5 年 |

**没有任何一行是三列全 ✅。** 因此「找一个万能项目」这条路在客观上被排除——不是因为搜索结果不好看，而是因为**三个域的开源生态在语言、形态、许可三个维度上本身就是分裂的**。

### 负向结论 2：**TypeScript 生态在能源物理计算上是一个空洞**

我们不是「选不出来」，而是**这个生态里不存在可选项**。实测：第三轮专门搜了
`site energy optimization PV storage EV charging`（q5，0 条）、
`solar PV simulation language:TypeScript`（q9，配额失败）、
`load profile time series energy language:TypeScript`（q8，0 条）。
即使不是 0 条，命中的也是 `energywebfoundation/origin`（能源凭证，非物理计算）。

含义：**能源计算层的 TypeScript 实现只能自己写**（公式可借，语言必须自持）。这不是权衡，是约束。

### 负向结论 3：**「用成熟项目替换旧架构」在这里不是一个可执行的选项，但「用成熟项目校正旧架构」是**

因为负向结论 1，方案 A（fork 某个项目）与方案 B/C 的**单底座**版本全部不可执行。
但第二轮的正向发现（citrineos-core 的分层 / pvlib 的模型 / REopt 的建模 / HDEV 的负荷路径）**足以做另一件事**：给旧架构的每一层指定一个「应该长成什么样」的外部参照物，然后按参照物改造旧架构。

这才是第二轮真正的产出：**不是「换成一个更好的项目」，而是「给自建主干装上三个外部标尺」。**

---

## 5. 与第一轮的差异（为什么第二轮结论必须覆盖第一轮）

| 维度 | 第一轮 | 第二轮 |
|---|---|---|
| 候选数量 | 4（全部为指定的 SaaS/脚手架类） | **26**（含能源计算 + 充电基础设施 + 重卡专用） |
| 能源计算域 | **完全未覆盖** | pvlib / SSC / SAM / pysam / reV / REopt_API / REopt.jl / PyPSA / oemf / calliope / GenX / StorageVET / EnergyPlus |
| 充电基础设施域 | **完全未覆盖** | citrineos-core / EVerest / steve / OpenEMS / mobilityhouse-ocpp / origin |
| 重卡专用域 | **完全未覆盖** | hdev-depot-charging-2021 |
| 许可证审查深度 | 看 GitHub 字段 | **读 LICENSE 原文**（发现 REopt 命名条款、GenX GPL、OpenEMS AGPL、steve GPL） |
| 依赖审查深度 | 看描述 | **读 package.json / pyproject.toml**（发现 ixartz=Drizzle+Clerk、boxyhq=Stripe+React18） |
| 检索方法 | 6 条 | 28 条，**并且记录了 2 个方法学缺陷** |
| 结论形态 | 「不 fork，自建」 | **「三域拆解 + 每域指定外部参照物 + 双底座」** |

第一轮结论「自建主干」**方向上是对的**，但**理由不成立**（它是 4 个样本的归纳，不是全域审计的结论）。第二轮用 26 个样本 + 三域覆盖，**重新证明**了这个结论，并且补上了第一轮缺失的：每个域到底该参照谁。

---

## 6. 本报告结论（供下一份文档展开）

1. **方案 A（fork/二次开发某 GitHub 项目）不可执行**——不存在三域通吃的项目（§4 负向结论 1）。
2. **不存在「单一能源项目 + 产品层重开」的干净路径**——能源域没有 TS 项目，引入 Python/Julia 运行时是长期负债。
3. **不存在「单一 SaaS 底座 + 能源层开源」的路径**——SaaS 候选的数据层（Drizzle / Sequelize）或授权层（Stripe / Clerk / AGPL）都与我们冲突。
4. **唯一可行结构 = 双（三）域底座**：
   - **底座 A（产品/SaaS 基础）** = 现有 TypeScript/Next 主干**自持**（25 Prisma model / 41 内核文件零框架依赖 / 1,167 单测全绿 / 34 条宪法守卫），外部仅取**形态与表结构参考**（boxyhq 的权限模型、ixartz 的目录约定）。
   - **底座 B（能源计算基础）** = **借方法、TS 重写**：pvlib（PV 物理）、SAM/SSC（仿真+财务）、REopt（微网技经优化，只读思路）、BREOS（储能衰减，第一轮）、HDEV（重卡场站负荷，本轮）、PyPSA/oemof（优化求解形式）。
   - **底座 C（充电基础设施）** = **借架构与领域模型**：`citrineos/citrineos-core`（TS / Apache-2.0 / OCPP 2.0.1 CSMS）作为分层、命名与协议栈的唯一权威参照。
5. **所有 C 类能力（重卡车队模型 / 重卡充电负荷 / 项目级配置推荐 / 中国与山西电价体系 / 项目商业模式 / 服务流程 / 数据可信度 / 实际数据回流）必须自研**，护城河只能建在这里。

> 详细裁决（方案 A/B/C/D 的显式判定）见 `docs/V2_FINAL_BASE_ARCHITECTURE.md`。
