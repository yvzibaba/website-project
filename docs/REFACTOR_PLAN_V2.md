# REFACTOR_PLAN_V2 — 修改计划 + 首批代码修改方案（阶段4 · 最终输出 3 & 4）

> 生成日期：2026-09-09（Asia/Shanghai）
> 上游：`docs/MODEL_AUDIT_REPORT.md`（问题清单 F-1~F-11）、`docs/PRODUCT_V2_DESIGN.md`（V2 架构）。
> **状态：计划待批准。本文不含任何已实施的代码修改。按开发原则"等待确认后再开始修改代码"，全部改动 STOP 待创始人放行。**
> 铁律：小步提交、每批跑测试、不改冻结模块的公式/版本、不制造虚假数据、不加无商业价值功能。

---

## 一、修改批次总览（按风险与依赖排序）

| 批次 | 性质 | 是否触碰经济公式 | 是否触碰冻结模块 | 审批要求 |
|---|---|---|---|---|
| **批次 1** | 呈现/文案/校验/扫描集 | ❌ 不动公式 | 敏感性文件内部标识符保留 | **可立即做**（本方案已给具体 diff） |
| **批次 2** | 接线/画像数据修复 | ⚠️ 改 hasStorage 判定（不改公式本身） | 触碰 `sandbox-model.ts`（冻结） | 逐项批准 + 黄金回归 |
| **批次 3** | 改经济模型（补中国关键参数） | ✅ 新增计算腿 | 触碰 E3/E4/finance（冻结核心） | **创始人逐项拍板口径** |
| **批次 4** | 产品重构/UI/三级沙盘 | ❌ 只呈现 | 不触碰引擎 | 分批小步，每页验收 |

**推进顺序**：批次1（立即）→ 批次4 中"分级入口/首页"（呈现，低风险，直接兑现产品价值）→ 批次2（修画像矛盾，为路径B铺路）→ 批次3（改模型，最后且逐项批准）。

---

## 二、批次 1 · 首批实际代码修改方案（纯呈现/校验，不动经济公式）

> 以下每项均为**建议 diff**，尚未实施。每项独立小步提交，提交后跑 `npm run test:unit` + 相关黄金回归。

### B1-1 · 龙卷风 → 中国化文案（创始人裁决落地·呈现层）

**原则**：只改**用户可见文案**，保留内部标识符 `computeTornado`/`TornadoRow`/`SENSITIVITY_VERSION`（避免破坏 calcRef 溯源与黄金样本）。

| 文件:行 | 现文案 | 建议改为 |
|---|---|---|
| `src/app/page.tsx:211` | "…NPV / IRR / ROI / 回收期、**龙卷风敏感性**与确定性动态报告。" | "…多久回本 / 能赚多少 / 内部收益率，以及**关键因素影响力排行**与确定性动态报告。" |
| `src/components/sandbox/SandboxCharts.tsx:148` | `title="敏感性 · 龙卷风（对 NPV）"` | `title="关键因素影响力排行（对净现值 NPV 的±影响）"` |
| `src/lib/sandbox-report.ts:278` | "**龙卷风图**在报告页可视化各变量的正负摆动幅度…" | "**关键因素影响力排行**在报告页展示各变量±摆动对 NPV 的正负影响，辅助判断应优先核实哪些假设。" |
| `src/lib/sandbox-solution.ts:267` | "…one-at-a-time **龙卷风**敏感性——最敏感变量：…" | "…逐项±摆动敏感性分析——影响最大的因素：…" |
| `sandbox-report.ts` 第四节标题 | "四、敏感性：结果最容易被谁左右" | 保留（已是中国话，无需改） |

> 图表**形态**（水平双向条形）保留——本质仍是 ±摆动，只是不再叫"龙卷风"。可选增强（后续）：每行补"离盈亏平衡还有多远"标注。

### B1-2 · 修 F-6：龙卷风呈现值 = 实际裁剪值（消除呈现≠事实）

**文件**：`src/server/sandbox-sensitivity.ts` `computeTornado`（约 line 191-215）。
**问题**：`lowInput/highInput = baseInput×(1±delta)` 未裁剪，但 `runSandboxModel` 实际裁剪 → 图上标 3.335、实际按 3.0 算。

**建议 diff**（记录实际生效值，保留原始扰动值供透明）：
```ts
// 现：
const lowInput = baseInput * (1 - delta);
const highInput = baseInput * (1 + delta);

// 改为（新增"实际生效值"解析，与引擎裁剪口径一致）：
const lowRaw = baseInput * (1 - delta);
const highRaw = baseInput * (1 + delta);
const lowInput = resolveSandbox(withUserOverride(layers, p.key, lowRaw)).numeric[p.key] ?? lowRaw;
const highInput = resolveSandbox(withUserOverride(layers, p.key, highRaw)).numeric[p.key] ?? highRaw;
if (lowInput !== lowRaw) notes.push(`低端扰动 ${lowRaw} 越界，已裁剪至 ${lowInput}`);
if (highInput !== highRaw) notes.push(`高端扰动 ${highRaw} 越界，已裁剪至 ${highInput}`);
```
- `TornadoRow` 可选新增 `lowInputRaw/highInputRaw` 字段（纯加性，向后兼容）。
- **须 `SENSITIVITY_VERSION` 升版**（1.3.0→1.4.0，记因：呈现值改为裁剪后实际值）+ 跑敏感性黄金回归确认既有场景 row 值符合预期（基线内参数未越界，摆幅不变；仅越界场景显示值变化）。

### B1-3 · 修 F-11：UI 硬编码默认值改读单一真源（消除漂移风险）

| 文件:行 | 现状 | 建议 |
|---|---|---|
| `src/components/sandbox/SandboxDemoPanel.tsx:276` | `spec.id === "elecPrice" ? (0.7).toFixed(2) : …` | 从 `SANDBOX_PARAMETER_SPECS` 按 engineKey 读 `defaultValue`，不写死 0.7 |
| `src/components/sandbox/SandboxWorkbench.tsx:173` | `resolved.numeric["finance.discountRate"] ?? 8` | 兜底值改读参数目录 `finance.discountRate` 的 `defaultValue`（8），不写死字面量 |

> 纯呈现层，无计算影响，无需版本升。

### B1-4 · 把 feedInTariff 加入敏感性扫描集（已消费参数·纯加性）

**文件**：`src/server/sandbox-sensitivity.ts` `DEFAULT_SENSITIVITY_PARAMS`。
**理由**：上网电价已被 E3 消费（exp0>0 时），却缺席扫描集（F-7 一部分）。加入是**纯加性**，不改公式。
```ts
// 在 DEFAULT_SENSITIVITY_PARAMS 追加：
{ key: "policy.feedInTariff", deltaPct: 15 }, // 上网电价（余电上网腿，仅光伏>负荷时激活）
```
- **注意**：基线 exp0=0（acLoad>pvGen），故基线场景下 feedInTariff 摆幅=0（诚实标注"当前情景余电为0，上网电价不影响"）——这本身是有用的诚实信息，不是 bug。
- 与 B1-2 合并到同一次 `SENSITIVITY_VERSION` 升版（1.4.0）。

### B1-5 · 修 F-1 / F-1b：layers 服务端校验 + 时钟/FACT 信任边界（安全·不动模型）

**文件**：`src/server/sandbox-projects.ts`（layersSchema）、`src/server/sandbox-store.ts`（toEngineLayers）。

1. **F-1 layers 校验**：把 `z.record(z.string(), z.any())` 收紧为**白名单 schema**——只接受已知参数键、值类型匹配 spec（数值→number 且在 bounds、布尔→0/1），拒绝未知键与非法类型。region/policy 层的 `effectiveFrom/Until` 校验为合法日期。
2. **F-1b `now` 强制服务端时钟**：`toEngineLayers` **不接受客户端传入的 `now`**，一律用服务端当前时间（或项目创建时固化的服务端时间戳）——杜绝客户端注入时钟复活过期政策。
3. **F-1b FACT 降级**：客户端提交的 `sources[*].evidenceKind` **一律降级为 ASSUMPTION**（待人工核实），服务端只信任经 `makeVerifiedFact` 流程落库的 FACT。R8.7 闸门保留但明确"格式校验 ≠ 真伪校验"。

> 属**校验/安全**改动，不改任何经济公式，不影响黄金样本（黄金样本走服务端可信路径）。须补单测：非法 layers 被拒、客户端 now 被忽略、客户端 FACT 被降级。

**批次 1 验收**：`npm run test:unit` 全绿 + 敏感性黄金回归绿 + 新增校验单测绿 + 手动核对首页/报告/图表文案已中国化 + `git diff` 确认零经济公式改动。

---

## 三、批次 2 · 接线/画像数据修复（逐项批准 + 黄金回归）

### B2-1 · 修 F-2h：includeStorage 布尔接线（触碰冻结 `sandbox-model.ts`）

**文件**：`src/server/sandbox-model.ts` `hasStorage` 判定。
```ts
// 现：
const hasStorage = storageEnergy > 0 && storagePower > 0 && tech.storageIncluded;
// 建议（尊重用户可见开关）：
const includeFlag = numeric["project.includeStorage"] === 0 ? false : true; // 默认1=启用
const hasStorage = includeFlag && storageEnergy > 0 && storagePower > 0 && tech.storageIncluded;
```
- **风险**：触碰冻结文件。基线 includeStorage=1 → 基线行为不变 → **黄金样本 S/M/L 应零变化**（须回归确认）。仅当用户/画像显式置 0 时行为改变（这正是修复目的）。
- **须 `MODEL_VERSION` 讨论**：接线修 bug 是否升 MODEL_VERSION？建议**不升主版本**（基线输出逐位不变），但在 CHANGELOG 记"includeStorage 布尔接线修复"。创始人定夺。

### B2-2 · 修 F-3：TRANSIT 画像归零储能（数据修复）

**文件**：`src/server/sandbox-profiles.ts` TRANSIT_PROFILE.presetValues。
```ts
// 现：presetValues 有 includeStorage:0，但 storageEnergy/storagePower 缺省 → 全局默认 400/200 仍生效
// 建议（二选一，取决于 B2-1 是否先做）：
//  方案A（B2-1 已接线）：includeStorage:0 即足够，储能自动不算 → 无需改数据
//  方案B（B2-1 未做）：显式补 "project.storageEnergy": 0, "project.storagePower": 0
```
- **依赖**：若 B2-1 先接线，B2-2 用方案A（零数据改动，最干净）；否则用方案B（补两个归零键）。
- `SANDBOX_PROFILES_VERSION` 视改动升版记因。

**批次 2 验收**：黄金回归 S/M/L 29/29 绿 + 新增单测（includeStorage=0 → capex.storage=0 且 storageValue=0；TRANSIT 画像 → 无储能）+ 探针式复核。

---

## 四、批次 3 · 改经济模型（高风险·创始人逐项拍板口径·最后做）

> 每项都是**新增计算腿**，触碰冻结的 E3/E4/finance 核心。按 USER 决策风格，**财务内核口径一律创始人拍板**。每接一项：先定口径→改代码→升对应版本→跑黄金回归（既有场景可能因新腿而变化，须创始人确认新基线）→补单测→文档记因。

| ID | 修改 | 待创始人定的口径 | 触碰 |
|---|---|---|---|
| B3-1 | F-2c 需量电价接入 | 需量费=峰值需量kW×demandCharge×12？峰值需量如何从负荷推？是否分时？ | E4 |
| B3-2 | F-2e 碳价接入 | 碳收益=替代火电量×排放因子×carbonPrice？排放因子取值来源？ | E3 |
| B3-3 | F-2f/g 融资腿 | 利息税盾口径？Equity IRR 定义？DSCR？（R8.8b 遗留，高风险） | finance |
| B3-4 | F-4 储能超寿命 | 超日历寿命年：储能价值归零 or 计更换 CAPEX？更换成本口径？ | SVE/model |
| B3-5 | F-8 负谷价地板 | p_valley<0 时是否设地板？套利腿是否封顶？ | SVE |

**纪律**：批次 3 **任一项未获明确口径批准前不得动代码**。每接一项后，需量电价/碳价/融资结构方可加入敏感性扫描集（兑现 F-7"加入中国关键影响参数"的后半段）。

---

## 五、批次 4 · 产品重构/UI/三级沙盘（呈现为主·分批验收）

| ID | 修改 | 文件 | 性质 |
|---|---|---|---|
| B4-1 | `/sandbox` 分级切换（免费10参数 / 专业40参数），共用同一引擎 | `src/app/sandbox/page.tsx` + 组件 | 呈现 |
| B4-2 | Level 1 暴露第9参数 chargingPrice；第10参数 includeStorage **待 B2-1 接线后**才暴露 | `sandbox-demo.ts` DEMO_HEADLINE_SPECS | 呈现 |
| B4-3 | 首页30秒价值主张重构（结果导向首屏 + 免登录免费沙盘 CTA + 诚实徽章） | `src/app/page.tsx` | 呈现 |
| B4-4 | 企业页画像卡（先修 B2-2 避免矛盾） | `src/app/enterprise/page.tsx` | 呈现 |
| B4-5 | 方案销售页"含什么/价格位/交付物/免责"（价格 HUMAN INPUT 预留不填） | `src/app/solutions/[id]/page.tsx` | 呈现 |

**纪律**：B4 全部**只改呈现与文案**，数字仍来自引擎；不编造案例/客户/数据（诚实空态优于虚假繁荣）；Level 3 企业定制引擎**不在本阶段**（V3+）。

---

## 六、CHANGELOG 与提交纪律

- 本次（阶段4 第一~五阶段设计）为 **docs-only 小步提交**：新增 `MODEL_AUDIT_REPORT.md`、`PRODUCT_V2_DESIGN.md`、`REFACTOR_PLAN_V2.md` 三文档 + CHANGELOG 追加一条 docs 记录，**不升产品版本号**（沿用 v0.64.1 docs-only 先例）。
- 每批次代码修改**独立提交**，提交信息含批次号与修复的 F 编号；提交前跑 `node ground_truth.mjs` 暴露 orphan（里程碑纪律）。
- 任何触碰冻结模块的提交（批次2/3）前，必须黄金回归绿 + CHANGELOG 记因 + 创始人批准留痕。

---

## 七、最终四项输出索引

1. **项目问题优先级列表** → `docs/MODEL_AUDIT_REPORT.md` §7（F-1~F-11 按 P1/P2/P3）+ §附速览。
2. **V2 产品架构** → `docs/PRODUCT_V2_DESIGN.md`（三条用户路径 + 三级沙盘 + UI + 商业化）。
3. **修改计划** → 本文 §一~§五（批次1~4，按风险/依赖排序）。
4. **第一批实际代码修改方案** → 本文 §二（B1-1~B1-5，含具体 diff，纯呈现/校验，不动经济公式）。

> **STOP 点**：按开发原则"等待确认后再开始修改代码"，以上全部为计划。请创始人确认：①是否放行批次1（纯呈现/校验，低风险）；②批次2/3 各项口径裁决；③龙卷风中国化文案是否符合预期。确认前不动任何代码。
