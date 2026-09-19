# V2 · GitHub 底座选型报告

> 阶段：**V2 战略定稿阶段**（本阶段不写 V2 代码）
> 配套：`docs/V2_STRATEGY_FINAL.md` · `docs/V2_PRODUCT_ARCHITECTURE.md` · `docs/V2_MIGRATION_PLAN.md`
> 审计日期：2026-09-18 ~ 2026-09-19
> 审计人：AI Agent（数据可复现，原始 JSON **随仓库版本化**于 `research/github-base/`，17 个文件 / 604KB）

---

## 0. 审计方法（为什么这份报告可信）

**任务明确要求「实际访问并审计 GitHub，不得只看 README」。本报告的数据来源如下：**

| 手段 | 具体做法 | 能证伪什么 |
|---|---|---|
| **GitHub REST API** | `GET /repos/{owner}/{repo}` 取 stars / forks / license / `pushed_at` / `size` / `archived` | 证伪「README 说的活跃」——只看真实最后提交时间 |
| **完整文件树** | `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` | 证伪「有测试 / 有 CI」——数真实文件，不数声称 |
| **依赖清单** | `raw.githubusercontent.com` 直取 `package.json` / `pyproject.toml` | 证伪「技术栈匹配」——看真实依赖与版本 |
| **多组检索** | `GET /search/repositories` 6 组不同 query | 证伪「这就是最优解」——必须主动找替代品 |

**本报告所有数字均来自上述接口的实际返回，未经推测。** 原始数据保存在**仓库内** `research/github-base/`（`*.json`，共 17 个文件），可随时复核。

**一条方法学声明**：本报告**刻意不引用 README 里的自我描述**作为评判依据。README 是营销材料，不是工程事实。

---

## 1. 四个指定候选的审计结果

### 1.1 汇总表（硬数据）

| 候选 | Stars | Fork | License | 语言 | 创建 | **最后提交** | 文件数 | **测试** | **CI** |
|---|---:|---:|---|---|---|---|---:|---:|---:|
| `nextjs/saas-starter` | **16,134** | 2,728 | MIT | TypeScript | 2024-09-10 | **2025-12-11** | 55 | **0** | **0** |
| `felixtgd/ferntree` | **2** | 0 | MIT | Python | 2024-02-29 | 2026-09-10 | 136 | 4 | **0** |
| `Str4vinci/breos` | **19** | 4 | BSD-3 | Python | 2026-04-01 | **2026-09-17** | 360 | **60** | **2** |
| `dailab/elvis` | **21** | 7 | MIT | Python | 2021-05-12 | **2022-02-21** | 54 | 4 | **0** |

> **第一个刺眼的结论**：四个候选里，唯一「看起来成熟」的是 `nextjs/saas-starter`；
> 而三个能源域候选全部是 **个位数~两位数 stars 的 Python 研究工具**。
> `dailab/elvis` 更是**已经 4 年 7 个月没有提交**。

---

### 1.2 `nextjs/saas-starter` —— 16k stars，但不是我们要的底座

**它是什么**：Vercel 官方维护的 SaaS **起始模板**（starter template），不是产品、不是框架。

**真实技术栈**（取自 `package.json`，非 README）：

| 层 | 实际依赖 | 版本 |
|---|---|---|
| 框架 | `next` | **15.6.0-canary.59** ← canary 预发布版 |
| UI | `react` / `react-dom` | 19.1.0 |
| ORM | `drizzle-orm` + `drizzle-kit` + `postgres` | 0.43.1 / 0.31.1 / 3.4.5 |
| 支付 | `stripe` | 18.1.0 |
| 认证 | `jose`（JWT session）+ `bcryptjs` | 6.0.11 / 3.0.2 |
| 校验 | `zod` | 3.24.4 |
| 样式 | `tailwindcss` 4.1.7 + `radix-ui` + `cva` + `tailwind-merge` | — |
| **测试** | **`devDependencies` 为空 —— 无任何测试框架** | — |

**scripts 只有 8 条**：`dev / build / start / db:setup / db:seed / db:generate / db:migrate / db:studio`。**没有 `test`、没有 `lint`、没有 `typecheck`。**

**九维评估**：

| 维度 | 评价 | 依据 |
|---|---|---|
| 成熟度 | ⚠️ 中 | 16k stars 但仅 55 个文件；是**模板**不是产品 |
| 活跃度 | ❌ **偏低** | 最后提交 2025-12-11，距审计已 **9 个月**；53 个未关 issue |
| 技术架构 | ⚠️ | **Drizzle** ORM，与本项目 **Prisma** 不一致 |
| 测试 | ❌ **零** | 0 测试文件、0 测试框架 |
| 文档 | ⚠️ | 仅 README + `.env.example` |
| 扩展性 | ⚠️ | 模板式结构，扩到多模块业务需要大改 |
| 核心能力 | 认证 + 订阅计费 + 团队/席位 | 与本项目需要的「项目决策引擎」**无交集** |
| License | ✅ MIT | 商用无碍 |
| **匹配度** | ❌ **低** | 见下 |

**为什么不能作主底座（三条硬理由）**：

1. **会降级现有技术栈。** 本项目当前是 **Next 16.3.4 + React 19.2.8 + Prisma 6**；fork 这个模板意味着 Next **降级到 15 canary**、ORM **从 Prisma 换成 Drizzle**。
2. **引入本项目已明确否决的能力。** 它绑死 **Stripe**——而 V1 阶段已判定 Stripe 在国内不可用并否决。
3. **它没有测试。** 本项目当前有 **1167 个单测 + 27 个集成测试**。为拿一个模板的骨架而放弃测试基线，是负收益。

> **结论**：可作为**「SaaS 骨架的参考读物」**（看它怎么组织 auth/订阅/中间件），
> **不可作为主底座**。

---

### 1.3 `Str4vinci/breos` —— 四个里唯一工程严肃的项目，但它是「库」不是「产品」

**它是什么**：`Building Renewable Energy Optimization Software`。
`pyproject.toml` 自述：**"Python library for PV and battery energy-system simulation and optimization"**，版本 0.6.0，Development Status :: **4 - Beta**。

**为什么说它严肃（这些是不能造假的信号）**：

- **360 个文件、147 个 `.py` + 83 个 `.rst` 文档**；
- **60 个测试文件** + **2 个 CI workflow**；
- 有 `.readthedocs.yaml`（ReadTheDocs 托管文档）、`CITATION.cff`（学术引用）、`CONTRIBUTING.md`、`SECURITY.md`、`ROADMAP.md`、`CODE_OF_CONDUCT.md`、`ATTRIBUTIONS.md`；
- **有 numba 加速内核**：`breos/_numba_dispatch.py` / `_numba_dispatch_kernels.py` —— 说明作者在做**性能工程**，不是玩具；
- 依赖是正经行业栈：`numpy>=2.0`、`pandas>=2.3.3`、**`pvlib>=0.14.0,<0.16`**（PV 建模的行业标准库）、`rainflow>=3.2.0`（雨流计数法，用于**电池循环寿命**）；
- 模块划分专业：`battery.py` / `inverter.py` / `economics.py` / `degradation/`（**29 个文件**）/ `load_profiles.py` / `emissions.py` / `cec_fit.py` / `execution.py`；
- **最后提交 2026-09-17（审计前一天）**，作者是 FEUP（波尔图大学）研究者。

**九维评估**：

| 维度 | 评价 | 依据 |
|---|---|---|
| 成熟度 | ⚠️ 中（Beta 0.6.0） | 工程规范齐全，但版本未到 1.0 |
| 活跃度 | ✅ **高** | 审计前一天仍有提交；2026-04 建库至今 5 个月 |
| 技术架构 | ✅ 好 | 清晰的领域模块化 + 性能内核分离 |
| 测试 | ✅ **好** | 60 个测试文件 + 2 CI |
| 文档 | ✅ 好 | ReadTheDocs + 83 个 rst |
| 扩展性 | ⚠️ | 定位是**库**，无 Web/多租户/权限 |
| 核心能力 | **PV+BESS 仿真与优化 + 衰减建模 + 经济性** | 与本项目技术域**高度相关** |
| License | ✅ **BSD-3** | 宽松，商用可借鉴/可移植（需保留版权声明） |
| **匹配度** | ⚠️ **中**——但价值在**算法**，不在**底座** |

**关键限制（必须写清楚，避免误判）**：它的 topics 是 `battery / **buildings** / **households** / modelling / pv / simulation / solar / storage`。
即：**面向建筑与家庭自消费（self-consumption）场景**，不是**商用车队 + 重卡快充 + 场站级投资决策**。
用户画像、时间尺度（家庭 15 分钟负荷 vs 车队日充）、决策目标（自消费率 vs IRR/回收期）都不同。

> **结论**：**不能作主底座**（它是 Python 库，本项目是 TS 产品）。
> 但它是本次审计中**最有价值的算法参考源**——尤其是 **`degradation/`（29 文件）与 `economics.py`**，
> 恰好对应旧模型最薄弱的「储能衰减」与「投资项口径」两块。

---

### 1.4 `felixtgd/ferntree` —— 形态对、但太小太早

**它是什么**：`Ferntree is an open-source tool for designing, simulating and analysing solar energy systems.`

**真实结构**：

- `backend/`：**62 个源文件**，FastAPI 0.141 + numpy 2.5 + pandas + h5py + matplotlib + psycopg + pydantic 2，有 `schema.sql`；
- `frontend/`：**TS 前端（13 个文件）+ index.html + package-lock.json**；
- 部署：`Dockerfile` + `compose.yml` + `compose.prod.yml` + `Caddyfile` + `.devcontainer/` + **terraform（13 个 `.tf`）**；
- 工程化：`.pre-commit-config.yaml`、pytest、ruff；
- `docs/architecture`、`docs/deployment`。

**九维评估**：

| 维度 | 评价 | 依据 |
|---|---|---|
| 成熟度 | ❌ **低** | 版本 **0.1.0**；136 个文件 |
| 活跃度 | ✅ 高 | 最后提交 2026-09-10 |
| 技术架构 | ✅ 中上 | FastAPI + TS 前后端分离，容器化 + IaC |
| 测试 | ❌ 低 | **仅 4 个测试文件**，0 CI |
| 文档 | ⚠️ 中 | 有 architecture / deployment 两页 |
| 扩展性 | ⚠️ | 单人项目 |
| 核心能力 | 太阳能系统「设计→仿真→分析」 | **产品形态与本项目旗舰高度同构** |
| License | ✅ MIT | 商用无碍 |
| Stars | ❌ **2** | 几乎无社区验证 |
| **匹配度** | ⚠️ 形态参考价值 > 代码价值 |

> **结论**：**不能作主底座**（2 stars、0.1.0、4 个测试）。
> 但它验证了一件重要的事：**「设计 → 仿真 → 分析」是这个领域被独立开发者认可的产品形态**，
> 其 **Docker + Caddy + compose + terraform** 的部署组合可以借鉴。

---

### 1.5 `dailab/elvis` —— 已废弃

**它是什么**：`Electric Vehicle Charging Infrastructure Simulator (ELVIS)`，MIT，Python。

**硬事实**：**最后提交 2022-02-21** —— 距审计（2026-09-19）**已 4 年 7 个月**。
0 CI、4 个测试文件、54 个文件、无 `pushed_at` 之后的任何活动。仓库未标 archived，但**实质已死**。

**九维评估**：

| 维度 | 评价 | 依据 |
|---|---|---|
| 成熟度 | ❌ 低 | 54 文件 |
| **活跃度** | ❌ **已废弃** | **2022-02-21 后无提交** |
| 技术架构 | — | 无法从其时代背景外推可用性 |
| 测试 | ❌ 低 | 4 个文件 |
| 文档 | ❌ 弱 | 仅 README |
| 核心能力 | EV 充电基础设施仿真 | 域相关，但**充电站选址/负荷**层面 |
| License | ✅ MIT | — |
| **匹配度** | ❌ 不可用 | **不能把已死 4 年 7 个月的项目放进生产路径** |

> **结论**：**不可作底座，连作依赖都不可**（无维护）。
> 仅可作**历史建模思路**的阅读材料，且需自行验证其假设是否还成立。

---

## 2. 主动搜索：有没有更好的选择？

任务要求「同时主动搜索 GitHub，寻找更合适的新项目」。做了 **6 组检索**：

| # | Query 方向 | 命中总数 | 最好结果 |
|---|---|---:|---|
| 1 | 技术经济分析 / 光伏 | 198 | `protontypes/open-sustainable-technology` ★2,553 |
| 2 | 电池储能优化 | 183 | 多为 Home Assistant 玩家项目，最高 ★61 |
| 3 | EV 充电站仿真 | 89 | `skarapost/EVLib` ★54（**已死于 2020**） |
| 4 | 可再生能源项目融资 | **16** | 最高 **★3** —— **整个方向没有成熟项目** |
| 5 | 重卡 / 兆瓦级充电 | **21** | 全部 ★3 以下 |
| 6 | 能源系统建模框架 | **6** | `epri-dev/StorageVET-deprecated` ★64（**名字里就写着 deprecated**） |

### 2.1 值得记录的真实发现

| 仓库 | Stars | License | 语言 | 最后提交 | 为什么值得看 |
|---|---:|---|---|---|---|
| `protontypes/open-sustainable-technology` | **2,553** | CC-BY-4.0 | 目录型 | 2026-09-16 | **气候/可持续能源开源生态的策展目录**。对「产业机会发现引擎」的上游能力有直接价值 |
| `NatLabRockies/reV` | 143 | BSD-3 | Python | 2026-08-11 | **NREL 的地理空间技术经济评估**——估算区域技术潜力（容量/发电量）。直接对应「建在哪里」 |
| `FZJ-IEK3-VSA/glaes` | 66 | MIT | Python | 2026-09-05 | 能源系统**土地可用性**评估（选址） |
| `epri-dev/StorageVET-deprecated` | 64 | BSD-3 | Python | 2026-08-19 | **EPRI 的储能估值模型**。权威机构出品，可作储能经济性方法论参考 |
| `pielube/MESSpy` | 47 | — | Python | 2025-11-10 | 多能源系统仿真器 |
| `atpham88/HDV` | 16 | — | Python | 2022-07-10 | **重卡充电运输优化**（电动+氢能重卡）。学术，已停更 |

### 2.2 检索得出的三个「负向结论」（比正向发现更重要）

**① 重卡兆瓦级充电方向，开源界是真空。**
检索「heavy duty truck charging / megawatt」仅 **21 个命中，全部 ★3 以下**。
全球**没有任何一个开源项目**在做「重卡充电场站的投资决策与方案比较」。

**② 可再生能源项目融资方向，没有任何成熟开源实现。**
「renewable energy project finance」仅 **16 个命中，最高 ★3**，且多为个人 Notebook（Excel 财务模型的复刻）。
**不存在可用的开源项目财务分析产品。**

**③ 能源域的严肃开源资产，清一色是 Python 科学计算库，不是 Web 产品。**
BREOS / reV / glaes / MESSpy / StorageVET / ferntree —— **没有一个是 TypeScript 的 SaaS 产品**。

> **这三条合起来，直接否定了「找一个成熟 GitHub 项目当主底座」这个前提在能源域成立。**
> 领域里没有成熟的产品级底座可拿。硬找，只会拿回一个 2 stars 的 0.1.0 项目或一个已死 4 年 7 个月的仓库。

---

## 3. 结论：主底座必须自建，不 fork 任何候选

### 3.1 决策

> **V2 的主底座 = 现有仓库中已被验证的基础设施（Continues），而非任何外部仓库。**

理由按优先级排：

1. **现成资产已经过验证且不可替代。** 本项目当前已有：**1167 个单测（全绿）**、**27 个集成测试文件**（⚠️ 集成套件当前 7 例失败，根因已定位为「测试未随引擎升版同步」，**不影响本节的「不 fork」结论**，详见 `V2_MIGRATION_PLAN.md` §2.2）、`tsc --noEmit` 0 错误、eslint 0、`next build` 通过、**41 文件 / 149 import / 0 违规的内核边界守卫**、25 张 Prisma 表、**35 个页面、35 个 API 路由**、RBAC 权限、审计日志。**没有任何一个候选能提供这些**，而它们恰好是「通用 SaaS 基础设施」的全部。
2. **四个候选无一匹配**（详见第 1 节）。
3. **领域内不存在产品级开源底座**（详见第 2.2 节）。
4. **反向依赖风险**：引入 Python 库作生产依赖，意味着在一个 TS/Next 单体内维护第二条语言运行时与第二套部署链路——**对一个独立创业者的维护成本是灾难性的**。

### 3.2 与任务要求的对齐

任务要求「**1 个主产品底座 + 少量专业计算模块 + 自研新能源重卡领域模型**，不得做代码大杂烩」。
本报告的方案**精确满足**这个结构，且**主底座这一项选用自有资产而非外部仓库**：

| 任务要求 | 本方案 | 说明 |
|---|---|---|
| **1 个主产品底座** | ✅ **现有 TS/Next 仓库（裁剪后）** | 唯一运行时、唯一部署 |
| **少量专业计算模块** | ✅ **自研 TS 模块，接口对齐领域标准** | 不引入第二语言运行时 |
| **自研新能源重卡领域模型** | ✅ **必做，且这是真正的护城河** | 领域内无开源实现（见 2.2 ①） |
| 不得代码大杂烩 | ✅ | 不 fork、不 vendor、不引入 Python 生产依赖 |

---

## 4. 借鉴清单（用什么、怎么用）

**「不 fork」不等于「不借鉴」。** 以下为**分级借鉴清单**，每一项都标注了**借鉴方式**与**License 约束**。

### 4.1 可直接借鉴算法/方法（BSD-3 / MIT，可移植）

| 来源 | 借鉴什么 | 方式 | License 约束 |
|---|---|---|---|
| **`Str4vinci/breos`** | **`degradation/`（29 文件）的电池衰减建模**；`economics.py` 的经济性口径；`rainflow` 循环计数法的用法 | **读代码 → 用 TS 重写方法**（**不复制代码**） | BSD-3：复制代码须保留版权声明；**重写方法不受限** |
| `epri-dev/StorageVET-deprecated` | 储能价值评估的**方法论框架**（EPRI 权威） | 读文档 → 定义自己的价值项 | BSD-3 |
| `NatLabRockies/reV` | **技术潜力评估**（区域可建容量/发电量）的方法 | 读方法 → 用于上游「机会发现」 | BSD-3 |
| `atpham88/HDV` | 重卡充电的**运输-充电耦合建模**思路 | 读方法（学术，已停更，需自行验证） | 未标 License ⚠️ **只读思路，不复制代码** |

### 4.2 可直接使用（数据/目录，非代码）

| 来源 | 用途 | License |
|---|---|---|
| `protontypes/open-sustainable-technology` | **上游「产业机会发现」的数据源之一**：它是气候/能源开源生态的策展目录，可用于发现新技术方向与项目 | CC-BY-4.0（**须署名**） |

### 4.3 仅作产品形态参考（不取代码）

| 来源 | 借鉴什么 |
|---|---|
| `felixtgd/ferntree` | 「设计 → 仿真 → 分析」的产品路径；Docker + Caddy + compose + terraform 的部署组合 |
| `nextjs/saas-starter` | SaaS 骨架的组织方式（auth / 订阅 / 中间件布局）——**仅作阅读参考** |
| `dailab/elvis` | 充电站仿真的历史建模思路（需自行验证假设） |

### 4.4 明确排除（License 或状态原因）

| 来源 | 排除原因 |
|---|---|
| `skarapost/EVLib` | **GPL-3.0**（强 copyleft，闭源 SaaS **不可**复制/链接其代码）+ **最后提交 2020-01-01（已死）** |
| `hacf-fr/Solar-Router-for-ESPHome` | **GPL-3.0** + 是嵌入式硬件项目，与业务无关 |
| `dailab/elvis`（作依赖） | 4 年 7 个月无维护 |

> **License 合规红线（必须遵守）**：
> - ✅ 可用：**MIT / BSD-3 / Apache-2.0**（宽松，商用友好）
> - ⚠️ 慎用：**CC-BY-4.0**（可商用但**必须署名**）
> - ❌ **禁用：GPL-3.0 及任何 copyleft** —— 会传染到闭源产品
> - ❌ 未标 License 的仓库 = **默认保留全部权利**，**只能读思路，不能复制代码**

---

## 5. 最终选型结论（一句话版）

> **不选任何候选作底座。**
> **主底座 = 现有仓库裁剪后的 TS/Next 主干**（它是唯一同时具备测试基线、内核边界守卫与 SaaS 基础设施的资产）；
> **专业计算模块自研**（TS，接口对齐领域标准）；
> **重卡领域模型 100% 自研**——因为全球开源界在这个方向上**是空的**（21 个命中、全部 ★3 以下）；
> **算法思想选择性借鉴 BREOS 等 BSD-3 项目，但以「读方法、用 TS 重写」为唯一方式，不复制代码、不引入第二语言运行时。**

**这条结论的反直觉之处值得强调**：任务假定「GitHub 上有更成熟的项目可以拿来用」。
实测数据不支持这个假定——**在能源决策这个细分域，开源生态的成熟度远低于预期**。
这本身是一个重要的战略情报：**它既是风险（没有现成的可以抄），也是机会（说明这个软件不是「已经被做烂了」）**。

---

## 6. 附录 · 审计数据可复现

| 文件 | 内容 |
|---|---|
| `research/github-base/nextjs_saas-starter.json` | 仓库元数据 |
| `research/github-base/Str4vinci_breos.json` | 仓库元数据 |
| `research/github-base/felixtgd_ferntree.json` | 仓库元数据 |
| `research/github-base/dailab_elvis.json` | 仓库元数据 |
| `research/github-base/tree_*.json` | 四个仓库的**完整文件树** |
| `research/github-base/mf_*` | 依赖清单（`package.json` / `pyproject.toml`） |
| `research/github-base/search_1..6.json` | 6 组检索的原始返回 |

复跑方式（需经隧道，见技能 `github-via-ghelper`）：

```bash
bash ~/.workbuddy/skills/github-via-ghelper/scripts/ghproxy.sh \
  curl -sS "https://api.github.com/repos/Str4vinci/breos"
```

**审计局限（诚实声明）**：
1. GitHub **未认证** API 有速率限制（搜索接口约 10 次/分钟），故检索组数为 6 组而非穷举；
2. 本审计**未运行**任何候选项目的代码，故「能否在本机跑起来」未经验证——但鉴于结论是「不采用作底座」，该验证对决策无影响；
3. stars 数**不等于质量**，本报告刻意以「文件树 + 测试数 + CI + 最后提交」为主判据，stars 仅作参考。
