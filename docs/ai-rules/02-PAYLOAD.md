# 02 · Payload 集成规范

> 效力：见 [00-INDEX](./00-INDEX.md) 第 1 节 · 配套决策依据：`../../前期选型决策_Payload_vs_boxyhq.html`（工作区）

---

## 0. 为什么选 Payload（不要重复讨论）

前期最缺的不是 SaaS 骨架（多租户/计费），而是**结构化数据的录入 / 校验 / 版本 / 发布**能力 —— 因为核心技术资产（区域参数）目前**硬编码在 TypeScript 源码里**，改一个 `confidence` 要改代码 + 重新部署，而计划是 31 字段 × N 个省。

**已否决**：`boxyhq/saas-starter-kit`（前期的多租户组织太早、Stripe 计费国内不可用）。
**若未来出现「10+ 付费机构客户卡在席位/计费/SSO」**，再单独评估补一层，不在 V1 做。

---

## 1. 自动化前必须完成的 4 项实测（**未完成不许动 collections**）

| # | 要验证的事 | 通过标准 |
|---|---|---|
| 1 | Payload 与现有 Prisma 共用同一 Postgres | 两边各自 migrate 后互不破坏；表名可清晰区分 |
| 2 | **迁移所有权**分工 | 明确写出：Prisma 管哪些表、Payload 管哪些表、谁先跑 |
| 3 | Payload 的 Postgres adapter 表现 | 空库跑通一个最小 collection 的增删改查 + 版本 |
| 4 | 与 Next.js 16 App Router 共存 | 现有页面、现有 `/api` 路由不受影响，`npm run build` 通过 |

**验证必须在空库进行，禁止在有真实数据的库上试。**

---

## 2. 边界铁律

### ✅ 进 Payload 的（内容形状）

`RegionPack` · `RegionParam`（见 04 分册）· `Benchmark`（L1 公开基准与算例）· `Case` · `SolutionDoc` · `Supplier` · `Evidence` · 产品文案

### ❌ 不进 Payload 的

| 实体 | 留在 | 原因 |
|---|---|---|
| `Project` / `ProjectScenario` / `ProjectVersion` | Prisma | 领域事务对象，内核直接读写 |
| `SolutionFinancial` | Prisma | 计算结果的持久化，内核契约 |
| `Order` / `ChangeLog` / `ModelCall` | Prisma | 交易与运行日志 |
| `User` | **现有认证体系** | 不迁移、不重写（禁令 1） |
| **任何计算逻辑** | **内核** | 见 01 分册第 5 节 |

### 跨边界读取规则

> **Payload 只通过自己的 collections 操作 Payload 管的表。**
> 需要读 Prisma 管的表时，走**应用代码（Prisma）**，**不要**在 Payload 里建跨表关系映射到 Prisma 的表。

理由：Payload 预期自己的 schema 由它自己管理；让它去 join 别人的表会在升级时爆炸。

---

## 3. Collection 建模规范

1. **字段必须自带溯源元数据**。参数类 collection 强制包含：`evidenceKind`、`confidence`、`sourceUrl`、`asOf`、`note`（详见 04 分册）。缺一不可。
2. **启用版本与草稿**（`versions: { drafts: true }`）。参数与基准文档的每次修改必须留版本（宪法 §13）。
3. **访问控制显式声明**。默认拒绝；L1 公开内容对匿名只读，参数编辑仅管理员。
4. **先做只读 L1，再做写入**。不要一次性把编辑流程做全 —— 阶段 0 只需要能录入与查看参数。
5. **禁止在 hook 里写业务计算**。`beforeChange` / `afterChange` 只允许做**校验**与**审计**，不允许做财务/技术计算。

```ts
// ✅ 允许：校验
beforeChange: [({ data }) => {
  if (data.evidenceKind === 'FACT' && !data.sourceUrl) {
    throw new Error('FACT 必须有 sourceUrl（宪法 §20 不许虚构来源）');
  }
  return data;
}]

// ❌ 禁止：在这里算 CAPEX / ROI / 敏感性 —— 那是内核的事
```

---

## 4. 参数数据迁移（从 .ts 进数据库）

当前参数在 `kernel/src/server/sandbox-regions.ts`（`values`）与 `sandbox-region-facts.ts`（逐值溯源目录）。迁移须**保证内核行为不变**。

**迁移步骤（顺序不可颠倒）**

1. 写出**导出脚本**：把 `sandbox-regions.ts` 的 `values` 与 `sandbox-region-facts.ts` 的来源元数据合并成一份 JSON 快照，落盘留档。
2. 在 Payload 定义 `RegionPack` / `RegionParam` 两个 collection。
3. 导入 JSON → 数据库。**导入时所有条目必须保留 `confidence≤50` 与 `ASSUMPTION`**，不许顺手「升级」。
4. 内核增加一个**参数读取适配层**：优先读数据库，读不到回退到 `.ts` 内置值（保证可回滚）。
5. **跑测试**：`vitest run tests/unit` 必须仍为 **1,167 通过**。快照对比内核输出（沙盘确定性结果）必须**逐位相同**。
6. 确认一致后，才允许把 `.ts` 里的 `values` 标记为 legacy（**不要删除**，留到下一个大版本）。

> ⚠️ **第 5 步是这一步的全部意义。** 若测试数或快照有任何变化，回退，不要继续。

---

## 5. 禁止事项

1. 禁止把内核代码搬进 Payload。
2. 禁止在有真实数据的库上试迁移。
3. 禁止在迁移过程中「顺手修正」参数值或置信度。
4. 禁止让 Payload 的迁移文件与 Prisma 的迁移文件互相依赖。
5. 禁止为了用上 Payload 的某个功能，而修改内核的对外接口。
6. 禁止在未跑通第 1 节 4 项实测前，写任何 collection 业务逻辑。

---

## 6. 迁移所有权分工（第 1 节第 2 项的书面结论）

> **本节是硬契约。两张表的所有权不得交叉。**

| 事项 | 所有者 | 迁移工具 | 迁移文件位置 |
|---|---|---|---|
| `"User"` / `"Case"` / `"Evidence"` / `"Project"` / `"Solution"` / `"SolutionFinancial"` / `"Order"` / `"Lead"` 等**全部 25 个模型** | **Prisma** | `prisma migrate` | `prisma/migrations/` |
| `cms_users` / `cms_region_packs` / `cms_region_params` | **Payload** | `payload migrate` | `src/payload/migrations/`（**独立目录**） |
| `payload_migrations` / `payload_preferences` / `payload_locked_documents` | **Payload**（框架自建） | 同上 | 同上 |

### 表名可分（这是「互不破坏」的可验证形式）

| | 命名风格 | 例 |
|---|---|---|
| Prisma | PascalCase，SQL 中需加引号 | `"Region"` · `"Case"` · `"SolutionFinancial"` |
| Payload | 小写 + 下划线，前缀固定 | `cms_region_params` · `payload_migrations` |

**两套前缀交集必须为空。** 「Prisma 的表是否被 Payload 破坏」不靠人肉记忆，靠机械断言 —— 见 `tests/integration/payload-smoke.test.ts` 第 ① 项（该文件随 R9.2 阻塞一并**未提交**，见 §7.4；裁决后即可启用）。

### 连接串分工

| 用途 | 变量 | 端点 | 为什么 |
|---|---|---|---|
| 应用运行时（Prisma Client） | `DATABASE_URL` | Neon **pooler** | 短连接高并发，池化端点复用后端连接 |
| Prisma 迁移 | `DIRECT_URL` | Neon **直连** | 迁移期的跨事务准备语句不被连接池支持（Prisma 官方要求 pooler 场景另配 `directUrl`） |
| Payload adapter | `DATABASE_URL` | Neon **pooler** | 走应用运行时身份（`push: false`，不依赖自省） |

### 执行顺序（谁先跑）

1. `npm run db:deploy`（Prisma）—— 先建业务表。
2. `payload migrate`（Payload）—— 再建 `cms_*` / `payload_*`。

**顺序不可颠倒，也不可互相依赖**：Payload 的表**没有**任何外键指向 Prisma 的表（禁令 4 的具体含义）。需要跨读时走应用代码（Prisma），不走 Payload 的关系字段。

> ⚠️ **禁止用 Payload 的 dev schema-push 建表**（第 7.2 节有实测证据：在本库上必崩）。Payload 的表**只能**来自 `payload migrate`。

---

## 7. R9.2 实测结论：Payload 在本 CJS 工程**不可直接接入**

> **本节全部结论都附可复现证据。写入日期 2026-09-18，依托 Payload 3.90.0 全量安装完成后的实测。**
>
> ⚠️ **一条重要的方法论教训**：本轮前半段曾得出四个「结论」（`@next/env` 互操作失败 / `date-fns` 目录导入报错 / tsc 找不到 `payload` 类型 / drizzle-kit 丢参数），
> **其中三个是假象** —— 它们全部由「`npm install` 尚未解压完」造成（实测：安装中 `payload/dist` 的 `.d.ts` 只写了 160/666 个）。
> 在依赖树未定型前做任何技术判断都是**对自己撒谎**。判据：等 `package.json` 里出现新依赖（npm 在 reify 结束后才写）。

### 7.1 根因：本工程是 CommonJS，而 Payload 3 是 ESM-first

| | 本项目 | Payload 官方模板 |
|---|---|---|
| `package.json` `"type"` | **无（= CJS）** | **`"module"`（= ESM）** |
| vitest 配置 | `vitest.config.ts` | `vitest.config.mts` |
| 测试脚本 | `--import tsx` | `--import=tsx/esm` |

官方模板 `templates/website@v3.90.0` 的 `package.json` 里 `"type": "module"` 是**必然而非偶然** ——
Payload 的包做的是**无扩展名的目录导入**（如 `@payloadcms/translations` → `import 'date-fns/locale/en-US'`），
Node 原生 ESM 解析器拒绝这种写法，**只有打包器接受**。

**推论**：Payload 在 Next.js 里能跑，是因为 Next 用打包器处理一切；一旦离开打包器（CLI、迁移、Node 脚本），就必须是真正的 ESM 工程。

### 7.2 实测证据（四条，均在本库、完整安装下复现）

**① Payload CLI 无法加载配置文件** —— `ERR_REQUIRE_ASYNC_MODULE`

```
require() cannot be used on an ESM graph with top-level await.
  From .../src/payload.config.ts
  Requiring .../node_modules/@payloadcms/richtext-lexical/dist/index.js
```

`.ts` 配置在 CJS 工程里被 tsx 编译成 CJS，于是 `require()` 去加载 ESM 依赖（含顶层 await）→ 崩。
**后果**：`payload migrate:create` / `payload migrate` 全部不可用。
**且 CLI 只认 `payload.config.js` / `payload.config.ts`**（实测 grep 全量 dist），不存在 `payload.config.mts` 这条退路。

**② dev schema-push 在本库必崩** —— `error: there is no parameter $1`

根因在 `drizzle-kit@0.31.7` 的 `pushSchema` 内部 shim（`api.js`）：

```js
const db2 = { query: async (query, params) => {
  const res = await drizzleInstance.execute(sql3.raw(query));  // ← params 被整个丢弃
  return res.rows; } };
```

调用方传的 `[tableSchema, tableName]` 被丢掉，只把带 `$1::regnamespace` / `$2` 占位符的裸 SQL 交给 Postgres。
**触发守卫是 `if (cprimaryKey.length > 1)`** —— 本意检测「复合主键」，但该统计**不按表分组**。
本库已有 Prisma 的 26 张表（各有主键）→ 计数恒 > 1 → **必然踩进坏路径**。
**后果**：`push: false` 是强制项，不是可选项。

**③ 测试宿主必须把 Payload 包内联**（`vitest.payload.config.ts` 的 `server.deps.inline`）

Vitest 默认把 `node_modules` 依赖外置给 Node 原生解析 → 撞上第 7.1 节的目录导入问题，实测报错：

```
Directory import '.../date-fns/locale/en-US' is not supported resolving ES modules
  imported from .../@payloadcms/translations/dist/importDateFNSLocale.js
```

内联（交给 Vite 处理）后该错误消失 —— 因为它把加载语义**对齐到了产线的打包器语义**。

**④ `tsc --noEmit` 反而通过**（完整安装后 0 错误）
说明类型层面无阻碍：`payload/dist/index.d.ts` 存在、`moduleResolution: bundler` 能解析 `exports.types`。
**唯一的墙是运行时模块格式，不是类型。**

### 7.3 后台 UI 亦不可挂载（独立的结构性冲突）

Payload 官方模板的 `(payload)/layout.tsx` **自己渲染 `<html>/<body>`** ——
前提是官方模板**没有根布局**（`(frontend)` 与 `(payload)` 平级）。

本项目**已有** `src/app/layout.tsx` 作为全局根布局。挂进去会得到嵌套 `<html>` ——
可编译、构建通过、**运行时 hydration 报错**，属于本规范最该防的静默问题。
要挂就得把既有全部路由搬进 `(app)` 目录组，波及全部页面与 `robots.ts` / `sitemap.ts`。

### 7.4 结论与选项（**需创始人裁决，不得自行选择**）

| 选项 | 内容 | 代价 | 风险 |
|---|---|---|---|
| **A · 转 ESM** | 给 `package.json` 加 `"type": "module"`，逐项修 CJS 互操作（`next.config.ts` / `postcss` / `eslint` / `vitest` / `prisma/seed.ts` / `scripts/*`），再把既有路由搬进 `(app)` | 全仓工程配置改造 + 路由搬迁 | **高**：动的是当前已验证全绿的基线（1167 单测 / 构建 / 0 类型错误） |
| **B · 弃用 Payload** | 参数 CRUD + 版本留在既有栈（Prisma + `/admin`），复用已设计好的证据元数据契约 | 约 2 张表 + 若干后台页 | **低**：不引入新基础设施 |
| **C · 手工迁移绕过 CLI** | 用脚本调 drizzle-kit 的 `generateSQL` 生成建表 SQL（避开第 7.1 与 7.2 节两条坏路径） | 每次 schema 变更都要手搓迁移 | **中**：长期脆弱，且仍是 ESM 宿主 |

**现状**：A 之前的**所有**路径都已被实测堵死；Payload 的表目前**一张都建不出来**。
在创始人裁决前，`src/payload/**` 与 `tests/integration/payload-smoke.test.ts` **保持未提交状态**（第 5 节禁令 6：未跑通 4 项实测前不许写 collection 逻辑）。


