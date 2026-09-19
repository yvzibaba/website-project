# V2 · 最终底座架构决策

> 状态：**定稿，待创始人裁决**
> 本轮性质：纯架构判断 + 纯文档。**零代码改动**。
> 上游依据：`docs/V2_GITHUB_SECOND_ROUND.md`（26 个候选硬数据）、`docs/V2_STRATEGY_FINAL.md`（战略定稿）
> 本文回答的唯一问题：**V2 到底换不换底座？换成什么？**

---

## 0. 先给出结论（一页版）

### 0.1 显式裁决

| 方案 | 定义 | 裁决 | 一句话理由 |
|---|---|---|---|
| **A** | fork / 二次开发某一个 GitHub 项目 | ❌ **否决** | 不存在三域通吃的项目（§4 负向结论 1）。产品域候选的数据层/授权层全部冲突；能源域候选全是 Python/C/Julia；充电域候选是 CSMS 不是产品。 |
| **B** | 某一个成熟能源项目作核心底座 + 产品层重开 | ❌ **否决** | 能源域**没有一个 TypeScript 项目**（§2.2）。采用即引入 Python/Julia 双语言运行时，对独立创业者是长期负债；且没有一个能源项目覆盖「重卡 + 光储充 + 中国电价」，核心层照样要自研。 |
| **C** | 某一个成熟 SaaS 作产品底座 + 能源计算层用成熟开源 | ❌ **否决** | 三个 SaaS 候选全部在数据层或授权层冲突：`ixartz` = Drizzle + Clerk（付费，数据出境）；`boxyhq` = React 18 / Next 15 代际回退 + Stripe/SSO 绑定；`nextjs-subscription-payments` = 已归档。采用任何一个都等于重写数据层 + 长期绑定第三方付费服务，收益为负。 |
| **D** | **无单一项目值得作完整底座 → 双（三）底座结构** | ✅ **采用** | 见 §1。这不是「退而求其次」，而是**由开源生态的真实分布决定的唯一可行结构**：三个域各自有自己的成熟参照物，但没有任何一个项目横跨三域。 |

### 0.2 采用方案 D 的具体形态

**底座 A（产品 / SaaS 基础）** = **现有 TypeScript / Next 主干自持**
**底座 B（能源计算基础）** = **借方法、TS 重写**（pvlib / SAM·SSC / REopt / BREOS / HDEV / PyPSA·oemof）
**底座 C（充电基础设施）** = **借架构与领域模型**（`citrineos/citrineos-core`）

关键定性：

> **底座 A 是「自己写的」，底座 B 和 C 是「借来的参照物」。**
> 本方案**不 fork 任何项目**，**不引入任何第二语言运行时**，**不新增任何 AGPL/GPL 依赖**。
> 换底座的实质不是「把代码换成别人的」，而是**「把自建主干的每一层对齐到一个外部权威标尺上」**。

---

## 1. 为什么是「双（三）底座」

### 1.1 底座划分的依据不是技术，而是**域**

任务给出的是一个反问式命题：「不要再找万能项目」。为什么？因为我们的产品本来就横跨三个**工程文化完全不同**的域：

| 域 | 本质 | 成熟开源的语言生态 | 典型许可 | 我们的用法 |
|---|---|---|---|---|
| **A 产品 / SaaS** | 用户、企业、项目、权限、订阅、报告、后台、商业化 | **TypeScript** | MIT / Apache-2.0 / AGPL | 自持（已有资产） |
| **B 能源计算** | PV 物理、储能算法、能源平衡、时间序列、设备模型、优化 | **Python / C / C++ / Julia** | BSD / MIT / GPL | 借方法，TS 重写 |
| **C 充电基础设施** | 充电设备、负荷、站点、运营 | **TypeScript（仅 citrineos）** | Apache-2.0 / AGPL / GPL | 借架构与领域模型 |

**三个域的语言生态是不重叠的**——这就是「万能项目不存在」的物理原因。产品域在 TS，能源域在 Python/C，充电域只有一根 TS 独苗。

### 1.2 为什么不能强行拼接多个开源项目（任务明确禁止的方向）

如果按「PV 用 pvlib + 优化用 PyPSA + 储能用 StorageVET + 充电用 citrineos + 产品用 boxyhq」去拼，会得到：

- **5 个运行时**：Node + Python×3 + Java/Julia
- **5 套数据模型**：Prisma（我方）+ 各自的内存/文件/DB 模型
- **4 种部署形态**：Next 服务 + Python sidecar×3 + ...
- **0 条统一的事务边界**：项目 → 方案 → 报告 → 证据 的全链路一致性在一个分布式异构系统里无法保证
- **License 传染风险**：AGPL（OpenEMS/nocodb/plane）与 GPL（steve/GenX）混进来

对**独立创业者**而言，这是直接把敏捷性打掉。所以任务说「**禁止机械拼接大量开源项目**」是对的——不是保守，是正确。

### 1.3 底座 A / B / C 的分工与接口

```
┌─────────────────────────────────────────────────────────────────────┐
│  底座 A · 产品 / SaaS 基础（自持 · TypeScript / Next）              │
│                                                                     │
│   用户 · 企业 · 项目 · 权限 · 订阅 · 报告 · 后台 · 商业化            │
│   25 Prisma model / 14 enum · 167 src 文件 · 35 页面 · 35 API 路由   │
│   自持理由：这是我们的商业模式本体，外部无对应物（§2）              │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ 调用（单向，进程内函数调用，非 RPC）
┌───────────────────────────▼─────────────────────────────────────────┐
│  底座 B · 能源计算基础（借方法 · TS 重写 · 内核）                    │
│                                                                     │
│   PV 物理计算 ← pvlib 方法                                          │
│   储能价值 / 衰减 ← BREOS 方法（第一轮）+ StorageVET 思路           │
│   技经优化 / 现金流 ← SAM·SSC 思路 + REopt 建模思路（不取代码/名称）│
│   重卡场站充电负荷 ← HDEV 建模路径（本轮关键发现）                  │
│   能源平衡 / 优化求解形式 ← PyPSA · oemof-solph 形式                │
│   自持理由：能源域无 TS 项目（§2 负向结论 2），必须自写             │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ 概念对齐（不引用代码）
┌───────────────────────────▼─────────────────────────────────────────┐
│  底座 C · 充电基础设施（借架构 · 借领域模型）                        │
│                                                                     │
│   参照物：citrineos/citrineos-core（TS / Apache-2.0 / OCPP 2.0.1）  │
│   借用内容：分层方式 · 领域概念命名 · ChargingProfile 语义 · 协议分层│
│   借用方式：读 → 在底座 A/B 里用我们的命名落地（不是 fork）         │
│   自持理由：citrineos 是 CSMS 后端，无用户/项目/报告概念（§2.3）    │
└─────────────────────────────────────────────────────────────────────┘
```

**硬约束：依赖是单向的。** 底座 C 只贡献**概念与命名**（编译期不存在依赖）；底座 B 是内核，**不依赖底座 A 也不依赖 C**（41 内核文件已实测零框架依赖，见 §3）。底座 A 单向调用 B。

---

## 2. 底座 A：产品 / SaaS 基础——为什么必须自持

### 2.1 现有量（本轮实测）

| 项 | 实测值 | 取证方式 |
|---|---|---|
| Next | `16.3.4` | `package.json` |
| React | `19.2.8` | `package.json` |
| TypeScript | `^5` | `package.json` |
| Tailwind | `^4` | `package.json` |
| Prisma / @prisma/client | `^6` | `package.json` |
| next-auth | `5.0.0-beta.32` | `package.json` |
| zod | `4.5.4` | `package.json` |
| vitest | `^5.0.0` | `package.json` |
| Prisma model / enum | **25 / 14** | `grep -c "^model \|^enum " prisma/schema.prisma` |
| `src/` 文件 | **167** | `find src -type f` |
| 页面 / API 路由 | **35 / 35** | `find src/app -name page.tsx / route.ts` |
| 测试文件 / 用例 | **93 / 1,261** | `grep -c` over `tests/`（288 个 describe） |
| LICENSE | **无**（私有仓库） | `ls LICENSE*` → 未找到 |

### 2.2 为什么外部候选都替代不了它

三个候选逐一对照（数据来自 `research/github-round2/mf_*.json`）：

#### `ixartz/SaaS-Boilerplate`（MIT，7,421★）

框架版本几乎同代（Next 16.2.9 / React 19.2.7 / Tailwind 4.3.1 / zod 4.4.3），**这是它最容易骗人的地方**。但：

| 维度 | ixartz | 本项目 | 影响 |
|---|---|---|---|
| ORM | **drizzle-orm 0.45.2** | **prisma 6** | ❌ 25 个 model / 14 个 enum / 迁移历史全部作废 |
| 认证 | **@clerk/nextjs 7.5.2** | **next-auth 5 beta** | ❌ 认证模型重写；引入第三方付费（用户数据出境） |
| TypeScript | `^6.0.3` | `^5` | ⚠️ 前跳大版本 |
| vitest | `^4.1.9` | `^5.0.0` | ⚠️ 回退大版本 |
| 测试 | 14 测试文件 | **1,261 用例** | ❌ 我们的测试资产无法迁移 |

**判定**：**不采用其代码。** 只采用其**目录约定与产品形态**（`src/` 分层、Storybook + Playwright + vitest 的三层测试结构、ESLint 严格度）作为 A 类改造的参考。

#### `boxyhq/saas-starter-kit`（Apache-2.0，4,935★）

Prisma 与 next-auth 都对上了，但：

| 维度 | boxyhq | 本项目 | 影响 |
|---|---|---|---|
| Next | 15.5.14 | 16.3.4 | ❌ 回退一代 |
| React | **18.3.1** | **19.2.8** | ❌ 回退一代（RSC/Server Action 行为差异） |
| next-auth | **4.24.13** | **5.0.0-beta.32** | ❌ v4→v5 是破坏性重写 |
| 支付 | **stripe 17.7.0** | 无 | ❌ 商业模式不需要 Stripe |
| SSO | `@boxyhq/saml-jackson 26` | 无 | ⚠️ 企业客户可能有用，但代价大 |
| 遥测 | mixpanel + retraced | 无 | ⚠️ 需要就不需要 |

**唯一值得取的**：它的 Prisma schema 里的**企业多租户 + 角色权限表结构**（`mf_boxyhq_schema.prisma` 已存档）——**参考表设计，不搬代码**。

#### `vercel/nextjs-subscription-payments`（MIT，7,719★）

`archived = true`，最后提交 **2025-01-23**。归档项目不作底座。

### 2.3 结论：底座 A 自持，理由是本轮实证的

> **底座 A 不是「因为找不到更好的所以留着」，而是「因为我们的产品概念在开源里没有对应物所以必须自持」。**

实测的三个候选，其领域概念与我们的重合度只到「用户 / 企业 / 角色」三个词。而我们的 25 个 Prisma model 里的**项目、方案、参数、证据、可信度、报告、实际值（Actuals）、电价体系、区域事实**——**在三个候选里全部不存在**。这些才是产品本体。

---

## 3. 底座 B：能源计算基础——借方法，TS 重写

### 3.1 内核现状（本轮实测，用于界定重写边界）

```
npm run kernel:verify
──────────────────────────────────────────
内核文件数      : 41
导入语句数      : 149
外部依赖：
  ✓  13x  zod
  ✓   5x  @prisma/client
  ✓   1x  node:crypto
  ✓   1x  node:util
✓ 通过：内核零框架依赖，未反向引用宿主，白名单外依赖 0 个。
```

| 内核文件 | 字节 | 职责 |
|---|---|---|
| `kernel/src/server/project-model.ts` | 29,310 | 模型定义与装配（**最大**） |
| `kernel/src/server/storage-value.ts` | 24,514 | 储能价值计算 |
| `kernel/src/server/sensitivity.ts` | 14,575 | 敏感性分析 |
| `kernel/src/server/finance.ts` | 10,390 | 财务现金流 |

**这就是「换底座不动内核」的物质基础**：41 个文件、零框架依赖、149 条 import 全部在白名单内（zod / @prisma/client / node 内置）。**这句话是已经守住的，不是待实现的。**

### 3.2 三个域的借鉴清单（底座 B）

| 能力 | 借鉴对象 | License | 借鉴什么 | 不借鉴什么 |
|---|---|---|---|---|
| **PV 物理计算** | `pvlib/pvlib-python` | BSD-3 | 太阳位置算法、辐照度分解（Erbs/DISC/ Perez）、组件温度（NOCT/SAPM）、单/双二极管 I-V、系统损耗 | Python 实现、pandas 时间序列依赖 |
| **仿真内核 + 财务** | `NatLabRockies/ssc` + `pysam` + `SAM` | BSD-3 | 性能模型与财务模型的**耦合方式**、月度/年度现金流的组织 | C++ 内核、SAM 的桌面应用架构 |
| **微网技经优化** | `NatLabRockies/REopt_API` / `REopt.jl` | ⚠️ 命名受限 BSD / Apache-2.0 | **MILP 目标函数与约束形式**：容量变量、运行约束、需量电费、投资回收 | ⚠️ **代码与名称都不取**（§3 命名条款） |
| **储能衰减与价值** | `Str4vinci/breos`（第一轮） | MIT | 衰减模型、循环寿命、调度收益 | Python 包形态 |
| **重卡场站负荷** | **`NatLabRockies/hdev-depot-charging-2021`** | BSD-3 | **建模路径**：日行驶循环 → 到达/离开时间分布 → SOC 需求 → 桩功率分配 → 站点聚合 | Jupyter 实现（已归档停更 5 年） |
| **优化求解形式** | `PyPSA` / `oemof-solph` | MIT | 能源平衡方程的**变量/约束书写范式** | 系统级（输电网）粒度模型 |

### 3.3 硬约束：**不引入第二语言运行时**

这是本方案的**不可协商项**。理由：

1. **工程负债**：Python sidecar 意味着新增依赖管理、进程生命周期、类型边界（要么用 RPC 协议，要么用代码生成）、部署双份、CI 双份、日志双份。对一个独立创业者，这是把交付速度砍半的代价。
2. **调用边界会破坏内核纯洁性**：41 文件零框架依赖的价值是「换底座不动内核」。一旦内核需要调用一个 Python 进程，内核就依赖了「一个外部进程」——**这是另一种形式的边界泄漏**，只是换了个方向。
3. **可测试性下降**：1,261 个用例的价值在于**纯函数可测**。跨进程调用会把大批单元测试变成集成测试。
4. **公式是公开知识**：PV 物理、现金流、MILP 形式都是**已发表的方法**，不受版权保护。JS/TS 重写这些公式是**合法且常规**的（`pvlib` 本身就是从 MATLAB 移植来的）。

> **结论：底座 B 的形态是「内核里的 TypeScript 模块」，不是「外部服务」。**
> 借鉴的是**方法、公式、约束形式、建模路径**；产出是**我们自己的 TS 实现 + 我们自己的测试**。

---

## 4. 底座 C：充电基础设施——借架构与领域模型

### 4.1 采用对象

| 项 | 值 |
|---|---|
| 项目 | **`citrineos/citrineos-core`** |
| URL | https://github.com/citrineos/citrineos-core |
| License | **Apache-2.0**（商用友好、无传染、可闭源衍生） |
| 语言 | **TypeScript** |
| ★ / 最后提交 | 294 / **2026-09-19（当天）** |
| 规模 | 2,753 blob（`ts:1813 tsx:292 json:449 yaml:74`） |
| 测试 | 374 个测试文件 / 425 个含 test·spec 的文件 |
| CI | **15 条 workflow** |
| 结构 | `apps/` + `packages/` + `scripts/` + `LICENSES/`（REUSE 合规） |
| 技术栈 | Fastify + sequelize-typescript + redis + ajv + @fastify/swagger |
| 能力 | OCPP **2.0.1** CSMS（充电站管理系统） |

配套模块：`citrineos/citrineos-operator-ui`（29★）、`citrineos/citrineos-ocpi`（23★）——同为 Apache-2.0 / TypeScript。

### 4.2 复用范围（借什么）

| 借用内容 | 具体 |
|---|---|
| **分层方式** | `apps/`（可部署服务）与 `packages/`（共享库）的切分——与我们的 `kernel/` + `src/` 结构可以**对齐验证** |
| **领域概念命名** | ChargingStation / Connector / **ChargingProfile** / Transaction / MeterValue / Location / Tariff —— 我们第三层「充电负荷」的对象命名**直接对齐**它，保证未来接真桩不返工 |
| **OCPP 消息语义** | `ChargingProfile` 的 `chargingSchedule` / `chargingRateUnit` / `period` 语义——这是我们「重卡场站分时功率分配」的数据结构参照 |
| **协议分层的坑** | 它踩过的 OCPP 2.0.1 版本兼容、证书（`pem:20`）、Ajv schema 校验 —— 读它的 issue 与结构，省我们的试错 |
| **REUSE 合规实践** | `LICENSES/` 目录 + `scripts/` 的合规脚本 |

### 4.3 重写范围（不借什么）

| 不借用 | 理由 |
|---|---|
| **任何代码** | 不 fork。底座 A 用 Prisma，它用 Sequelize → 直接搬会污染数据层 |
| **Fastify 服务形态** | 我们的服务层是 Next Route Handler，不是 Fastify |
| **Redis 依赖** | 阶段一不需要会话/队列缓存；引入即新增运维组件 |
| **真实桩接入能力** | 战略明确：阶段一**不做**真实桩接入（见 `V2_STRATEGY_FINAL.md` §3.3） |

### 4.4 明确排除的充电项目

| 项目 | 排除理由 |
|---|---|
| `OpenEMS/openems` | **AGPL-3.0**（闭源 SaaS 传染）；Java |
| `steve-community/steve` | **GPL-3.0**；Java；仅 OCPP 1.6 |
| `EVerest/EVerest` | C++（5,355 blob 巨型固件栈），面向车载/桩侧 |
| `mobilityhouse/ocpp` | MIT 但只是协议库（486 blob 里 387 是 JSON schema），非底座 |

---

## 5. 采用项目总表（§十一 要求的登记项）

| # | 项目 | GitHub URL | License | 采用原因 | 复用范围 | 重写范围 | 淘汰范围 |
|---|---|---|---|---|---|---|---|
| 1 | **本仓库主干**（自持） | `yvzibaba/website-project` | 私有（无 LICENSE 文件） | 产品本体无开源对应物（§2.3） | 25 Prisma model / 14 enum / 167 src / 35 页面 / 35 API / 93 测试文件（1,167 单测全绿）/ 41 内核文件 | 旧沙盘 UI 层、旧案例首页、旧六行业展示 | 见 `V2_FINAL_MIGRATION_PLAN.md` |
| 2 | `citrineos/citrineos-core` | https://github.com/citrineos/citrineos-core | **Apache-2.0** | 唯一「充电 + TypeScript + Apache-2.0 + 产品级测试」项目 | **仅概念**：分层、领域命名、ChargingProfile 语义、协议分层经验 | 全部代码（不 fork，用 Prisma 而非 Sequelize） | Fastify / Redis / 真实桩接入 |
| 3 | `pvlib/pvlib-python` | https://github.com/pvlib/pvlib-python | **BSD-3** | PV 性能仿真事实标准 | **仅方法**：太阳位置、辐照分解、组件温度、I-V 模型、损耗 | 全部代码（TS 重写，不用 Python） | pandas / numpy 依赖链 |
| 4 | `NatLabRockies/hdev-depot-charging-2021` | https://github.com/NatLabRockies/hdev-depot-charging-2021 | **BSD-3** | **重卡场站充电负荷**的唯一公开参考实现 | **仅建模路径**：行驶循环→到达分布→SOC→桩功率→聚合 | 全部代码（TS 重写） | Jupyter 实现（已归档停更 5 年） |
| 5 | `NatLabRockies/ssc` / `SAM` / `pysam` | https://github.com/NatLabRockies/ssc | **BSD-3** | 仿真+财务的耦合范式 | **仅方法**：性能模型与财务模型的耦合、现金流组织 | 全部代码（C++ 内核不引入） | 桌面应用架构 |
| 6 | `NatLabRockies/REopt_API` / `REopt.jl` | https://github.com/NatLabRockies/REopt.jl | ⚠️ **命名受限 BSD** / **Apache-2.0** | 微网技经优化的官方实现 | **仅思路**：MILP 目标函数与约束形式 | 全部代码 | ⚠️ **REopt 名称与代码均不使用**（§3 命名条款） |
| 7 | `Str4vinci/breos`（第一轮） | https://github.com/Str4vinci/breos | MIT | 储能衰减与价值 | **仅方法**：衰减模型、循环寿命、调度收益 | 全部代码（TS 重写） | Python 包形态 |
| 8 | `boxyhq/saas-starter-kit` | https://github.com/boxyhq/saas-starter-kit | Apache-2.0 | 企业多租户 + 角色权限表设计 | **仅 Prisma schema 表结构参考** | 不搬代码 | Stripe / SAML Jackson / Mixpanel / Retraced / React 18 |
| 9 | `ixartz/SaaS-Boilerplate` | https://github.com/ixartz/SaaS-Boilerplate | MIT | 目录约定与三层测试结构 | **仅目录与工程约定参考** | 不搬代码 | Drizzle / Clerk / typedoc |
| 10 | `PyPSA/PyPSA`、`oemof/oemof-solph` | https://github.com/PyPSA/PyPSA | MIT | 能源平衡方程书写范式 | **仅范式参考** | 不搬代码 | 输电网系统级粒度模型 |

**排除登记（License 或状态原因）**

| 项目 | 排除原因 |
|---|---|
| `makeplane/plane` (59.6k★) | **AGPL-3.0**，闭源 SaaS 传染 |
| `nocodb/nocodb` (65k★) | NOASSERTION（AGPL 系） |
| `twentyhq/twenty` (57k★) | NOASSERTION（AGPL 系） |
| `OpenEMS/openems` (1,559★) | **AGPL-3.0** |
| `steve-community/steve` (1,126★) | **GPL-3.0** |
| `GenXProject/GenX.jl` (365★) | **GPL-2.0** |
| `epri-dev/StorageVET-deprecated` (64★) | 名称即退役声明 |
| `NatLabRockies/EnergyPlus` (1,570★) | 整栋建筑能耗仿真，与重卡场站无关 |
| `vercel/nextjs-subscription-payments` (7,719★) | **已归档**（2025-01-23 停更） |
| `EVerest/EVerest` (265★) | C++ 固件栈，形态错位 |

---

## 6. 「什么必须自己开发」（§四 能力三分类）

### A 类 · 直接复用成熟能力

| 能力 | 来源 | 用法 |
|---|---|---|
| PV 物理计算 | pvlib（BSD-3） | 抄公式 → TS 重写 |
| 储能衰减/价值算法 | BREOS（MIT）+ StorageVET 思路 | 抄方法 → TS 重写 |
| OCPP 协议语义 | citrineos-core（Apache-2.0）/ mobilityhouse-ocpp | 抄领域模型与语义 |
| 通用认证 | next-auth 5（已内置） | 直接用 |
| 通用数据库/ORM | Prisma 6 + PostgreSQL（已内置） | 直接用 |
| 通用 UI | Tailwind 4 + Radix（已内置） | 直接用 |
| 通用工程基线 | vitest / ESLint / 内核守卫（已内置） | 直接用 |
| 财务现金流形式 | SAM / REopt 思路 | 抄形式 → TS 重写 |

### B 类 · 借鉴后重写

| 能力 | 借鉴对象 | 为什么不能直接复用 |
|---|---|---|
| 商业项目现金流模型 | SAM / REopt | 它是「美国电价 + 美国税制」，我们要中国/山西 |
| 方案比较 | REopt 的多方案输出 | 它的输出是 API JSON，我们的输出是**决策报告** |
| 项目推荐 | reV（地理潜力）思路 | 它的粒度是「区域资源潜力」，我们是「单个项目该不该投」 |
| 时间序列协调 | pvlib / PyPSA 的时序范式 | 要适配「PV 出力 × 重卡充电负荷」的耦合，非纯发电曲线 |
| **重卡充电负荷模型** | **HDEV（本轮降级项）** | 方法可借，**参数必须中国化**（车型/运距/电价/场站约束） |

### C 类 · 必须自主开发（护城河只能在这里）

| 能力 | 为什么开源里没有 |
|---|---|
| **重卡车队模型** | 中国重卡车型/运距/班次/载重分布，无公开数据模型 |
| **重卡充电负荷模型**（中国化参数层） | HDEV 只给方法，中国参数须自建 |
| **项目级配置推荐** | 「这个站该配多少 PV / 多少储能 / 多少桩」——商业判断，非纯物理 |
| **中国 / 山西电价体系** | 分时电价、需量电费、容量电价、市场化交易——属地化政策资产 |
| **项目商业模式** | 谁投、谁持有、谁付费、收益分配——交易结构设计 |
| **项目服务流程** | 从诊断到落地的服务 SOP |
| **数据可信度体系** | 证据契约、A/B 类欠功课清单、参数溯源——已开始建设 |
| **项目实际数据回流体系（Actuals）** | 真实运营数据回填 → 校正模型 → 形成壁垒 |

> **真正的护城河必须集中在 C 类。** A 类是「别人已经写好的物理」，B 类是「别人已经想好的方法」，C 类才是「只有做了这个生意才会有的东西」。

---

## 7. 本轮硬边界遵守情况（自证）

| 边界 | 状态 | 取证 |
|---|---|---|
| 不写 V2 代码 | ✅ | 本轮仅新增 `docs/*.md` 与 `research/github-round2/*`（数据+脚本） |
| 不改经济内核 | ✅ | `kernel/` 零改动（`git status` 无 kernel 变更） |
| 不改黄金样本 | ✅ | `tests/` 零改动 |
| 不改旧参数值 | ✅ | `docs/verified-data/` 零改动 |
| 不重新引入 Payload | ✅ | `package.json` 零改动 |
| 不删除 Legacy | ✅ | 无删除操作 |
| 内核守卫仍通过 | ✅ | `npm run kernel:verify` → 41 文件 / 149 import / 0 违规 |

---

## 8. 下一阶段的入口条件（本阶段**到此停止**）

本阶段到此停止。下一阶段（V2 换底座实施）的入口条件是：

1. 创始人裁决本方案的方案 D 与三域底座结构；
2. 裁决「不引入第二语言运行时」这条硬约束；
3. 裁决「citrineos-core 只借概念不 fork」；
4. 裁决「REopt 名称与代码均不使用」；
5. 裁决「重卡充电负荷模型降级为 B 类（借方法重写）」。

**裁决通过后**，才进入 `docs/V2_FINAL_MIGRATION_PLAN.md` 的 P1 阶段（边界切分，不改变任何行为）。
