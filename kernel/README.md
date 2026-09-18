# kernel — 领域内核

本目录是从 `website-project` 主仓抽离出的**框架无关领域内核**。
它不是「代码备份」，而是**换底座时原样搬迁的那一块**。

## 这里有什么

| 模块 | 文件 | 职责 |
|---|---|---|
| 技术经济沙盘 | `src/server/sandbox-*.ts`、`src/lib/sandbox-*.ts` | 光储充重卡项目的确定性计算：参数分层解析 → 技术能耗模型 → 逐年现金流 → NPV/IRR/ROI/回收期 → 敏感性 tornado → 动态报告 |
| 参数引擎 | `src/server/parameter-engine.ts` | `default < region < policy < user` 分层解析、裁剪、派生参数重算、版本化 |
| 评分内核 | `src/server/scoring.ts`、`case-scores.ts` | 10 维机会评分 + 证据可信度，幂等、可复算、版本化 |
| 研究流水线 | `src/server/research-pipeline.ts`、`scout*.ts` | 五角色研究（research→bull→bear→judge→qa）、GitHub Scout 许可证/依赖治理门 |
| 模型路由 | `src/server/model-router.ts`、`deepseek-provider.ts` | 唯一模型出入口；业务层不得硬编码模型名 |

**规模：42 个文件 / 12,322 行。**

## 为什么它值得单独成包

**它的回归保护远大于它的代码占比：**

| 指标 | 数值 |
|---|---|
| 内核代码行数 | 12,322（占全仓约 20%） |
| **内核相关测试用例** | **851** |
| 全仓测试用例 | 1,244 |
| **内核测试占比** | **68.4%** |

也就是说：**全仓 68.4% 的回归测试在保护这块内核。** 推倒重写会同时清空这张网。

## 搬运方式（搬到新底座时）

1. 把 `kernel/` 整体复制进新项目的 workspace（如 `packages/kernel/`）
2. 在新项目的 `tsconfig.json` 里保留 `"@/*"` 别名——内核内部 import 全部是 `@/...` 形式，
   **无需改动任何一行 import**
3. 提供两个 peer 依赖：`zod` 与 `@prisma/client`
4. Prisma schema 见主仓 `prisma/schema.prisma`（19 张表 + 11 个枚举）
5. 按 `.kernel-tools/COUPLING_CUT_PLAN.md` 切断 3 处边界泄漏，并在宿主侧注入 `SolutionWritePort`

## 边界约束（必须遵守）

- **禁止在内核里 import `next` / `react` / `react-dom`**——这是它可移植的前提
- **禁止在内核里读 env 之外的运行时全局**（`window` / `document` / `localStorage`）
- **禁止在内核里 import 任何 `auth` / UI 组件 / Route Handler**
- 新增文件后，用 `python .kernel-tools/extract_kernel.py .` 复核闭包仍然干净

## 当前状态：⚠ 尚有 3 处边界泄漏

传递闭包分析显示，内核目前仍会拽进 `src/auth.ts`（→ `next-auth`）。
详见 `.kernel-tools/COUPLING_CUT_PLAN.md`。**切断这 3 处之后，本包即为零框架依赖。**

## 自检

```bash
# 依赖闭包 + 白名单校验（dry-run）
python .kernel-tools/extract_kernel.py .
```

期望输出：外部依赖只剩 `zod` 与 `@prisma/client`，白名单外依赖数为 0。
