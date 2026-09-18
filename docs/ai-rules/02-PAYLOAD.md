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
