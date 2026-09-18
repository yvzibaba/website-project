# 内核解耦方案（COUPLING CUT PLAN）

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
