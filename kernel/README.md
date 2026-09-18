# kernel — 领域内核

**状态：已完成解耦（R9.1）· 零框架依赖 · 全仓单一真源 · 由守卫脚本持续把关**

本目录是光储充重卡项目的**框架无关领域内核**。
它不是「代码备份」，而是**换底座时原样搬迁的那一块**。

---

## 零框架依赖（实测，非声称）

```
$ npm run kernel:verify

内核守卫 · 框架无关性校验
──────────────────────────────────────────────────────────
内核文件数      : 41
导入语句数      : 149

外部依赖：
  ✓  13x  zod
  ✓   5x  @prisma/client
  ✓   1x  node:crypto
  ✓   1x  node:util

✓ 通过：内核零框架依赖，未反向引用宿主，白名单外依赖 0 个。
```

**这条结论有守卫，不靠人记。** 任何人往内核里写一行框架 import，`npm run kernel:verify` 立刻红灯。
再加一条独立的编译证明：`npm run kernel:typecheck`（内核用**自己的** tsconfig 单独编译，不挂宿主）。
两条都绿，才说明「换底座不动内核」这句话此刻仍然成立。

---

## 这里有什么

| 模块 | 文件 | 职责 |
|---|---|---|
| 技术经济沙盘 | `src/server/sandbox-*.ts`、`src/lib/sandbox-*.ts` | 光储充重卡项目的确定性计算：参数分层解析 → 技术能耗模型 → 逐年现金流 → NPV/IRR/ROI/回收期 → 敏感性 tornado → 动态报告 |
| 参数引擎 | `src/server/parameter-engine.ts` | `default < region < policy < user` 分层解析、裁剪、派生参数重算、版本化 |
| 评分内核 | `src/server/scoring.ts`、`case-scores.ts` | 10 维机会评分 + 证据可信度，幂等、可复算、版本化 |
| 方案数据层 | `src/server/solution-admin.ts`、`solution-body.ts` | Solution 聚合的 CRUD + 34 分节正文解析（纯数据层，无鉴权） |
| 研究流水线 | `src/server/research-pipeline.ts`、`scout*.ts` | 五角色研究（research→bull→bear→judge→qa）、GitHub Scout 许可证/依赖治理门 |
| 模型路由 | `src/server/model-router.ts`、`deepseek-provider.ts` | 唯一模型出入口；业务层不得硬编码模型名 |
| 身份契约 | `src/lib/roles.ts` | `SessionUser` / `STAFF_ROLES` / `hasRole`——内核**自己声明**它需要什么样的调用者 |

**规模：41 个文件 / 12,107 行。**

---

## 架构位置：内核是「不可变的那一半」

```
宿主底座（可替换，重写这半边）        内核（搬走即可，永不重写）
├── 认证 / RBAC / 会话  ← 适配器      ├── 沙盘技术经济引擎
├── 后台 Admin / CRUD                ├── 参数引擎 / 财务 / 敏感性
├── 内容建模                          ├── 评分内核
├── 支付 / 订单                       ├── 研究流水线 + GitHub Scout
└── 页面 / 组件 / SEO                 └── Model Router
```

**依赖方向是单向的：宿主 → 内核。** 内核**绝不**反向 import 宿主（即不得出现 `@/...`）。

### 身份契约：依赖倒置的落地

内核需要做资源级授权判定（「这个项目归谁」），但它**不 import 宿主的鉴权实现**。
它只声明自己需要什么形状：

```ts
// kernel/src/lib/roles.ts —— 纯模块，零 I/O
export interface SessionUser { id; email; name; role }
export const STAFF_ROLES: readonly UserRole[] = ["REVIEWER", "ADMIN"];
export function hasRole(role, allowed): boolean
```

宿主负责把自己的会话（Auth.js / 其他 / 测试桩）适配成这个形状。
**换鉴权方案时，改的是宿主的一个适配器，内核零改动。**

---

## 消费方式

```ts
// 方式一：barrel（公开 API 面稳定）
import { sandboxParams, parameterEngine } from "@app/kernel";

// 方式二：深路径直取（细粒度；由 package.json exports 的 "./*" 与 tsconfig paths 支持）
import { SANDBOX_PARAMS_VERSION } from "@app/kernel/server/sandbox-params";
```

别名解析由两处声明：根 `tsconfig.json` 的 `paths`、`vitest.config.ts` 的 `resolve.alias`
（后者顺序敏感：`@app/kernel` 必须排在 `@` 之前，理由见该文件注释）。

---

## 搬运方式（搬到新底座时）

1. 把 `kernel/` 整体复制进新项目（如 `packages/kernel/`）
2. 新项目声明两条路径映射：
   `"@app/kernel"` → `kernel/src/index.ts`、`"@app/kernel/*"` → `kernel/src/*`
3. 提供两个 peer 依赖：`zod` 与 `@prisma/client`
4. Prisma schema 见主仓 `prisma/schema.prisma`
5. 宿主把自己的会话适配成 `roles.SessionUser` 后传入

**内核内部的 import 全部是 `@app/kernel/...` 形式，不依赖宿主的 `@/*` 别名——
所以迁移时内核侧零改动。** 这一点与上一版 README 的说法相反（上一版说内核内部用 `@/*`），
原因见下方「已完成的解耦」。

---

## 边界约束（由守卫脚本强制，非君子协定）

- **禁止 import `next` / `react` / `react-dom` / `next-auth`**
- **禁止反向 import 宿主**（`@/...`）
- **禁止读 env 之外的运行时全局**（`window` / `document` / `localStorage`）
- 允许的外部依赖仅：`zod`、`@prisma/client`、`node:crypto`、`node:util`、`node:path`、`node:fs`、`node:url`
  （白名单在 `.kernel-tools/verify_kernel.mjs`；新增条目须同时更新 `docs/ai-rules/03-KERNEL.md`）

自检：

```bash
npm run kernel:verify      # 框架无关性 + 悬空引用 + 白名单
npm run kernel:typecheck   # 内核用自己的 tsconfig 独立编译
```

---

## 已完成的解耦（R9.1，2026-09-18）

### 改造前：内核是「影子副本」，不是真包

实测事实（不是推测）：

| 事实 | 数值 |
|---|---|
| `kernel/src` 与 `src` 逐字节相同的文件 | **39 / 39**（git blob 哈希一致） |
| 全仓对 `@app/kernel` 的引用 | **0** |
| 内核传递闭包白名单外依赖 | **2**（`next-auth`、`next-auth/providers/credentials`） |
| `kernel/package.json` 声明的入口 `src/index.ts` | **不存在** |

也就是说：内核能编译，只是因为 `tsconfig` 的 `include: ["**/*.ts"]` 把它当普通源码一起扫了；
**没有任何一行代码真的用它**。它是一份自洽的影子副本。

### 改造后：内核成为单一真源

| 动作 | 结果 |
|---|---|
| 修复边界泄漏 | 4 处导入站点（原方案记 3 处，实测漏了 `solution-generation.ts`） |
| 删除内核内的壳层文件 | `auth.ts` / `authz.ts` / `users.ts` 3 个 |
| 新增内核文件 | `lib/roles.ts`（纯身份契约）、`index.ts`（barrel 入口） |
| 内核内部别名改写 | 99 处 `@/` → `@app/kernel/` |
| 宿主侧引用切换 | 160 个文件 / 440 处（含 13 处相对路径与 `scripts/`、`prisma/` 的补漏） |
| 删除重复副本 | 39 个（每个先经 git blob 哈希证明与内核字节相同才删） |
| 闭包白名单外依赖 | **2 → 0** |

### 顺带纠正了原方案的两处误判

1. **泄漏点是 4 处，不是 3 处。** `solution-generation.ts:14` 也 import 了 `solution-admin`，
   原 `COUPLING_CUT_PLAN.md` 漏记（该文件不在种子清单里，因此闭包脚本没把它标红）。
2. **`solution-admin.ts` 不需要端口反转。** 原方案判断它「牵着 RBAC/会话」，实测：它的 import
   只有 `zod` / `@prisma/client` / `lib/prisma` / `lib/logger` / `lib/validation`——**零框架耦合**，
   它本来就是纯领域数据层，只是被误放在了闭包外。放回内核即可，**不需要**引入 `SolutionWritePort`
   依赖倒置那一层抽象。这正是「先测再信文档」的价值。

---

## 相关文档

- `docs/ai-rules/03-KERNEL.md` —— 内核改动流程与仍存在的缺陷清单
- `.kernel-tools/COUPLING_CUT_PLAN.md` —— 解耦方案（已执行，含结果回填与误判修正）
- `.kernel-tools/verify_kernel.mjs` —— 守卫脚本（本 README 所有数字的来源）
