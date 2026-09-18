# 内核解耦方案（COUPLING CUT PLAN）

> **状态：✅ 已执行完毕（R9.1，2026-09-18）。**
> 执行结果与**对原方案两处误判的修正**见文末「执行结果」一节。
> 下方原文保留不改——它记录了当时的判断依据，包括判断错的地方；这本身就是资产。
>
> **注意**：本文的验收标准第 3 条（闭包 42 → 38）已被实测修正为 **39**，理由见文末。
> 权威判据请以 `npm run kernel:verify` 的实际输出为准，不要以本文数字为准。

> 目标：让 `kernel/` 变成**零框架依赖**的纯领域包，从而可以挂载到任意 Next.js 底座，
> 而不需要在换底座时改动内核的任何一行业务逻辑。

---

## 现状诊断

对 34 个内核文件做**传递闭包**（不只是直接 import）后，发现内核仍会拽进 8 个壳层文件，
其中 `src/auth.ts` 引入了 `next-auth`：

```
next-auth  ←  src/auth.ts  ←  src/server/authz.ts  ←  sandbox-projects.ts
                                                   ←  sandbox-solution-source.ts

             src/server/solution-admin.ts  ←  sandbox-solution-store.ts
```

**结论：内核边界上有 3 处泄漏。** 有趣的是，其中 2 处泄漏的内容本身是**纯的**——
只是恰好住在一个被 NextAuth 污染的模块里。

---

## 泄漏点 1 · `sandbox-projects.ts:21`（浅，1 分钟可修）

```ts
import { STAFF_ROLES, type SessionUser } from "@/server/authz";
```

**问题**：`authz.ts` 第 1 行 `import { auth } from "@/auth"` → 整个 NextAuth 被拖进内核。

**但被引用的两个东西都是纯的：**

| 符号 | 定义 | 性质 |
|---|---|---|
| `STAFF_ROLES` | `export const STAFF_ROLES: readonly UserRole[] = ["REVIEWER", "ADMIN"]` | 纯常量，1 行 |
| `SessionUser` | `interface { id; email; name; role: UserRole }` | 纯类型，4 个字段 |

**修法**：把这两个符号（连同 `authz.ts` 里那个「给定角色是否被允许」的纯函数）抽到
`src/lib/roles.ts`，`authz.ts` 改为 re-export 以保持向后兼容：

```ts
// src/lib/roles.ts —— 纯模块，零 I/O、零框架
import type { UserRole } from "@/lib/validation";
export interface SessionUser { id: string; email: string; name: string | null; role: UserRole; }
export const STAFF_ROLES: readonly UserRole[] = ["REVIEWER", "ADMIN"];
export function isRoleAllowed(role: UserRole, allowed: readonly UserRole[]): boolean { /* 原逻辑 */ }

// src/server/authz.ts —— 只保留 I/O 部分，其余转出
export * from "@/lib/roles";
export async function getCurrentUser() { /* 原样 */ }
export async function requireRole(...)  { /* 原样 */ }
```

然后把 `sandbox-projects.ts` 的 import 改指向 `@/lib/roles`。

---

## 泄漏点 2 · `sandbox-solution-source.ts:23`（浅，同上）

```ts
import { STAFF_ROLES, type SessionUser } from "@/server/authz";
```

与泄漏点 1 完全同源、同一修法。改指向 `@/lib/roles` 即可。

---

## 泄漏点 3 · `sandbox-solution-store.ts:35-42`（深，需要端口反转）

```ts
import {
  createSolution,
  addSolutionFinancial,
  addSolutionUnknown,
  SolutionFinancialInputSchema,
  SolutionUnknownInputSchema,
} from "@/server/solution-admin";
```

**这不是类型泄漏，是真实的领域耦合**：沙盘在导出时确实需要把结果写成 Solution 记录。
`solution-admin.ts` 是壳层的管理服务，还牵着 RBAC / 会话。

**修法：端口反转（依赖倒置）**，而不是把 `solution-admin` 整块搬进内核。

```ts
// src/lib/solution-write-port.ts —— 内核自己声明的契约，纯接口
import type { z } from "zod";

export interface SolutionWritePort {
  createSolution(input: unknown): Promise<{ id: string }>;
  addSolutionFinancial(solutionId: string, input: unknown): Promise<unknown>;
  addSolutionUnknown(solutionId: string, input: unknown): Promise<unknown>;
}

/** 由宿主应用（底座）在启动时注入实现 */
let impl: SolutionWritePort | null = null;
export function provideSolutionWritePort(p: SolutionWritePort) { impl = p; }
export function solutionWritePort(): SolutionWritePort {
  if (!impl) throw new Error("SolutionWritePort 未注入：宿主应用需在启动时调用 provideSolutionWritePort()");
  return impl;
}
```

内核内改为 `solutionWritePort().createSolution(...)`；
新底座里写一个薄适配器把 `solution-admin` 的实现接上。

**收益**：内核不再知道「谁在实现写库」「用什么鉴权」「底层是 Prisma 还是别的」——
这正是「换底座不动内核」的关键一环。

---

## 修复后的验收标准

重跑闭包分析，必须满足：

1. `next-auth` / `next` / `react` **从外部依赖列表中完全消失**
2. 白名单外依赖数为 **0**
3. 依赖闭包文件数从 **42 降到 38**（不再带入 `auth.ts` / `authz.ts` / `users.ts` /
   `solution-admin.ts` 中的壳层部分）
4. 26 个黄金样本 + 沙盘确定性快照测试**全部仍然通过**

验收命令：

```bash
python .kernel-tools/extract_kernel.py .
```

---

## 为什么值得做

做完之后，「换底座」这件事的边界就变得非常清晰：

```
新底座（可随时替换）          内核（搬走即可，永不重写）
├── 认证 / RBAC / 会话        ├── 沙盘技术经济引擎
├── 后台 Admin / CRUD         ├── 参数引擎 / 财务 / 敏感性
├── 内容建模                  ├── 评分内核 + 26 黄金样本
├── 支付 / 订单               ├── 研究流水线 + GitHub Scout
└── 页面 / 组件 / SEO         └── Model Router
        ↑                              ↑
   重写这半边              注入 SolutionWritePort，其余零改动
```

这也正是这份方案相对「推倒重来」的核心价值：**让「重写」的范围可度量、可收敛。**

---

# 执行结果（R9.1 · 2026-09-18）

## 验收对照

| 原方案验收标准 | 实测结果 | 判定 |
|---|---|---|
| 1. `next-auth` / `next` / `react` 从外部依赖列表消失 | 外部依赖只剩 `zod`、`@prisma/client`、`node:crypto`、`node:util` | ✅ |
| 2. 白名单外依赖数为 0 | `npm run kernel:verify` → 0 | ✅ |
| 3. 闭包文件数 42 → 38 | **实为 41**（见下方修正 2） | ⚠ 目标值有误，实质达成 |
| 4. 26 个黄金样本 + 沙盘确定性快照仍通过 | 单元测试 **1167 passed / 1 skipped**，与改造前逐字一致 | ✅ |

附加验证（原方案未列，但更强）：
`tsc --noEmit` 0 错误 · `eslint` 0 警告 · `next build` 成功 · `kernel:typecheck` 独立编译 0 错误。

## 修正 1：泄漏点是 **4 处**，不是 3 处

原方案记 3 处。实测第 4 处：

```
kernel/src/server/solution-generation.ts:14
import { updateSolution, type SolutionMutationResult } from "@/server/solution-admin";
```

**为什么原闭包脚本没发现它**：`extract_kernel.py` 的种子识别是「basename 含关键词」，
`solution-generation` 确实在关键词表里，但脚本只报「闭包带入的支撑文件」与「白名单外依赖」，
而 `solution-admin` 当时被当成**合法支撑文件**带入了闭包——所以它既不报红也不报错，
只是安静地把壳层代码混进了内核。**这是「按文件名找种子」这类启发式的结构性盲区：它能发现
『拽进来了不该拽的』，但发现不了『本来就不该在内核里的东西』。**

→ 改法：核查每个闭包成员**是否真的属于领域**，而不是只核查依赖表是否干净。
这也是下面修正 2 的由来。

## 修正 2：`solution-admin.ts` **不需要**端口反转，它本来就该在内核里

原方案第 3 节判定：

> 这不是类型泄漏，是真实的领域耦合……`solution-admin.ts` 是壳层的管理服务，还牵着 RBAC / 会话。
> 修法：端口反转（依赖倒置）……内核内改为 `solutionWritePort().createSolution(...)`

**实测推翻了这个判断。** `solution-admin.ts` 的全部 import：

```
zod · @prisma/client · lib/prisma · lib/logger · lib/validation
```

零框架耦合。它**没有** import `authz`，也没碰会话（文件里只在注释中提过一次 `requireRole`，
而注释不是代码）。它就是 Solution 聚合的**纯数据层 CRUD**。

结论：**不需要** `SolutionWritePort`、不需要 `provideSolutionWritePort()`、不需要宿主侧注入适配器。
把 `solution-admin.ts` 放进内核即可。

**代价对比**：

| 方案 | 新增抽象 | 改动面 |
|---|---|---|
| 原方案（端口反转） | 新增端口接口 + 注册机制 + 宿主适配器 + 启动期注入时序约束 | 内核内 4 处调用改写 + 宿主新增 1 文件 + 2 个路由改导入顺序 |
| 实测方案（直接归位） | 无 | 0（它本来就在闭包里，只是位置需要从 `src/` 搬到 `kernel/`） |

**这也是「闭包 42 → 38」这个目标值错掉的原因**：原方案打算把 `solution-admin`（约 580 行）
连同 `authz`/`users`/`auth` 一起踢出闭包，所以算成 42−4=38。
实测只需踢出 3 个（`auth.ts` / `authz.ts` / `users.ts`），且新增 2 个（`roles.ts` / `index.ts`）：

```
42 − 3 + 2 = 41   ✓ 与实测一致
```

## 实际执行的改动清单

| # | 动作 | 规模 |
|---|---|---|
| 1 | 新建 `kernel/src/lib/roles.ts`（纯身份契约：`SessionUser` / `STAFF_ROLES` / `hasRole`） | +1 文件 |
| 2 | 新建 `kernel/src/index.ts`（barrel，命名空间导出以免 `export *` 静默吃掉重名符号） | +1 文件 |
| 3 | 修复 4 处泄漏：2 处改指 `lib/roles`，2 处随 `solution-admin` 归位内核 | 4 站点 |
| 4 | 删除内核内 3 个壳层文件（`auth.ts` / `authz.ts` / `users.ts`） | −3 文件 |
| 5 | 内核内部别名改写 `@/` → `@app/kernel/` | 99 处 |
| 6 | 宿主侧引用切换（`src/` + `tests/` + `scripts/` + `prisma/`） | 160 文件 / 440 处 |
| 7 | 删除 `src/` 下重复副本（**逐个先经 git blob 哈希证明与内核字节相同才删**） | −39 文件 |
| 8 | `src/server/authz.ts` 重写为「纯原语转出内核 + I/O 留壳层」，5 个符号对调用方零改动 | 1 文件 |
| 9 | 新建守卫 `.kernel-tools/verify_kernel.mjs`，接入 `npm run kernel:verify` | +1 文件 |
| 10 | 原 `extract_kernel.py` 的模型已失效（它会从 `src/` 找不到种子、静默报 0，造成「校验通过」的假象）→ 由守卫脚本取代 | 见该文件头注 |

## 三个已实测的陷阱（供复用）

1. **不要在 Windows 工作区按字节比对文件**。本仓 `core.autocrlf=true` 且**无** `.gitattributes`：
   工作区是 CRLF、git 对象库是 LF。任何「工作区 ↔ 对象库」或「未提交 ↔ 已提交」的字节比对
   会把**全部文件**误报为有差异。正确做法：比 git blob 哈希（
   `git rev-parse A:path` == `git rev-parse B:path`）。
2. **改写的顺序必须在比对之前**。第一版 codemod 先执行了别名改写、再做「副本是否仍与内核相同」的
   删除闸门——结果自己刚改过的文件全部「有差异」，闸门失效、39 个文件一个都删不掉。
   顺序必须是：**先证明等价 → 再改写 → 最后删除**。
3. **codemod 的扫描范围要覆盖全仓，不只是 `src/`**。第一版只扫了 `src/` 与 `tests/` 的 `@/` 形式，
   漏掉了 ① `tests/unit/` 里的**相对路径**导入（`../../src/server/sandbox-model`）、
   ② `scripts/` 与 `prisma/seed.ts`。补漏时先跑「悬空引用普查」定位全部缺口再修，比反复跑 typecheck 试错快得多。
