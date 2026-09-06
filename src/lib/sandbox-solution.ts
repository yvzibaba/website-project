/**
 * 沙盘「结果 → 产业方案（Solution）草案」纯映射（中途重构 R8 · §14 第 7 项收尾「生成定制方案（复用已有
 * Solution 生成 + 购买闭环）」/ 总控最高优先级「商业闭环」）。
 *
 * 职责：把 R2 计算引擎 + R4 视图模型 + R7 企业画像吐出的**确定性结果**，翻译成一份可交给既有
 * 「方案后台 → 发布 → 查看 → 购买（Order）」闭环消费的**结构化产业方案草案**——其正文严格贴合
 * `solution-body.ts` 的 34 分节 canonical key，财务条目严格贴合 `solution-admin.ts` 的
 * `SolutionFinancialInput` 入参形状，从而日后 `createSolution`/`addSolutionFinancial` 可原样落库。
 *
 * 为什么单拎这一层（宪法第 7/16 条、§8 单一真源）：
 *   - **数字一律从引擎产物搬运/格式化，本模块绝不重算** NPV/IRR/ROI/回收期（§7「程序算、LLM 只解释」的
 *     程序侧延伸：连"进方案"也不允许把结果二次口算）。每个可查询的财务 Decimal 串都断言等于 `calc.metrics`
 *     原值，正文里的每个金额串等于 `sandbox-view` 的格式化器输出。
 *   - **诚实贯穿**（§16/§20）：草案恒 `evidenceGrade="ASSUMPTION"`、`needsProfessionalReview=true`、
 *     入参全为【示例·待核实】占位假设；并产出一份**机器可校验的发布阻塞清单**（price 未定 / 未挂靠
 *     Case / 需专业人工确认 / 负 NPV 复核），在缺真实数据与人工裁决前，方案**只能停在 DRAFT、绝不冒充可售**。
 *
 * 边界（本轮刻意保守，勿越权）：
 *   - **零 DB、零网络、零时钟、零随机**，纯函数、client-safe（与 `sandbox-view.ts`/`sandbox-report.ts` 同层）。
 *   - **不直接建 Solution 行**：`Solution.caseId` 是必填外键（沙盘情景不天然属于某个案例），贸然写入会像
 *     R6.4 的 `regionId` 那样触发 `P2003` 500——故 R8.1 只产出「草案 + 阻塞项」，把「是否/如何挂靠案例、
 *     是否放宽 caseId、价格定多少」这些**业务/法律责任决策交给人**（§「AI 做劳动、人做关键决策」）。
 *   - 只填沙盘**能确证**的分节，其余留空——由 `parseSolutionBody` 如实显示「待补充」，绝不臆造内容。
 */

import type { CalcResult, CalcResultOk } from "@/server/sandbox-model";
import { factInputs } from "@/server/parameter-engine";
import { formatMoney, type NamedValue, type SandboxViewModel } from "@/lib/sandbox-view";
import type { SandboxEnterpriseProfile } from "@/server/sandbox-profiles";
import { SANDBOX_PROFILES_VERSION } from "@/server/sandbox-profiles";

/**
 * 方案草案口径版本（分节映射 / 财务搬运规则变化须升版记因，宪法第 13 条）。
 * 1.1.0（R8.7）：财务条目新增 `assumptions.inputProvenance`（逐输入溯源，从 `CalcResult.inputProvenance` 搬运），
 *   并在存在**可核验来源 FACT 输入**时把首条（按 key 稳定序）的 http(s) 链接搬到 `financial.sourceUrl`，
 *   以喂 R8.5 升级写路径；`evidenceGrade` 仍诚实保持 ASSUMPTION（只要还有任一入参是占位假设，聚合结果即不升 FACT）。
 */
export const SANDBOX_SOLUTION_VERSION = "1.1.0";

/** 溯源引用：把草案钉到「方案生成口径版本」（与各区段引擎 calcRef 并列，供发布后审计）。 */
export function sandboxSolutionCalcRef(): string {
  return `sandbox-solution@${SANDBOX_SOLUTION_VERSION}`;
}

/** 沙盘唯一深耕的 V1 行业叙事（照总控 §14，非六行业铺量）。 */
const SANDBOX_INDUSTRY_LABEL = "新能源重卡 + 光伏 + 储能 + 充电一体化场站";

/* ────────────────────────────── 类型 ────────────────────────────── */

/**
 * 财务条目：与 `solution-admin.SolutionFinancialInput` 同形（Decimal 用**十进制字符串**承载、
 * 不含负号；缺失/为负/算不出 → 诚实省略该字段，绝不填假值）。这样草案可被 `addSolutionFinancial` 原样吃下。
 */
export interface DraftFinancial {
  capex?: string;
  opexAnnual?: string;
  revenueAnnual?: string;
  roiPct?: string;
  irrPct?: string;
  paybackYears?: string;
  currency?: string;
  assumptions?: Record<string, unknown>;
  calcRef?: string;
  sourceUrl?: string;
  note?: string;
}

/** 关键未知变量：与 `solution-admin.SolutionUnknownInput` 同形。 */
export interface DraftUnknown {
  name: string;
  impact?: string;
  howToResolve?: string;
  severity?: number;
}

export interface SandboxSolutionInput {
  /** 必须是引擎对**当前**情景的 `CalcResult`（§9 读最新结果、§7 程序算）。 */
  calc: CalcResult;
  /** 与之配套的视图模型（`buildSandboxViewModel(calc,...)` 产物）——正文金额/百分比串取自此（单一真源）。 */
  vm: SandboxViewModel;
  /** 地区名（如「山西」），供标题与来路。 */
  regionName: string;
  /** 项目 / 情景名（来自沙盘保存或页面输入），可空则回落到通用标题。 */
  projectName?: string;
  scenarioName?: string;
  /** R7 企业画像（可空=通用；有则裁剪「适用企业」叙述与摘要侧重）。 */
  profile?: SandboxEnterpriseProfile;
  /** 拟定价格（Decimal 串，可空=未定价 → 记入发布阻塞项）。 */
  price?: string;
  currency?: string;
}

export interface SandboxSolutionDraftOk {
  ok: true;
  draftVersion: string;
  solutionCalcRef: string;
  /** 溯源：把草案钉回具体引擎 calcRef + 各内核版本 + 画像版本。 */
  provenance: {
    calcRef: string;
    engineVersions: CalcResultOk["engineVersions"];
    profilesVersion: string;
  };
  // —— 可直接映射到 Solution 列的字段 ——
  title: string;
  slug: string;
  summary: string;
  /** canonical 34 分节 key → 内容（仅填沙盘能确证者；其余留空由归一器显示「待补充」）。 */
  body: Record<string, unknown>;
  financials: DraftFinancial[];
  unknowns: DraftUnknown[];
  riskDomains: string[];
  needsProfessionalReview: true;
  evidenceGrade: "ASSUMPTION";
  /** 拟定价格（可空）。 */
  price?: string;
  currency: string;
  /**
   * 机器可校验的**发布前阻塞清单**：非空即「尚不可对外发布/售卖」。这是把 §16「高风险须人工确认」
   * 与总控「缺真实数据不得冒充可售」固化为可断言的产物（R8.2 落库/发布路由据此拦停在 DRAFT）。
   */
  publishBlockers: string[];
}

export interface SandboxSolutionDraftErr {
  ok: false;
  draftVersion: string;
  solutionCalcRef: string;
  /** 引擎/视图失败原因（透传诚实错误，绝不产出编造的方案）。 */
  error: { reason: string; detail: string };
  publishBlockers: string[];
}

export type SandboxSolutionDraft = SandboxSolutionDraftOk | SandboxSolutionDraftErr;

/* ────────────────────────────── 内部工具 ────────────────────────────── */

/** 非有限或缺失 → true（用于「算不出即不搬运」）。 */
function bad(x: number | null | undefined): boolean {
  return x == null || !Number.isFinite(x);
}

/** Decimal 串（十进制、两位、非负）；负/非有限 → undefined（省略而非造假，交发布阻塞项点名）。 */
function decimalOr(n: number | null | undefined): string | undefined {
  if (bad(n)) return undefined;
  const v = n as number;
  if (v < 0) return undefined; // SolutionFinancial 的 Decimal 字段禁止负号；负值改由 assumptions/正文承载
  return v.toFixed(2);
}

/** 把 NamedValue[]（原始数字）渲染成「名：金额」要点串数组（仅格式化，非重算）。 */
function moneyItems(items: NamedValue[] | undefined): string[] {
  if (!items) return [];
  return items.map((it) => `${it.name}：${formatMoney(it.value)}`);
}

/** 从 vm 卡片取已格式化串（单一真源，卡片缺失即「—」）。 */
function card(vm: SandboxViewModel, key: string): string {
  return vm.cards?.find((c) => c.key === key)?.value ?? "—";
}

/** slug 安全化：仅保留 [a-z0-9-]，其余转连字符；空则回落到时间无关的稳定串。 */
function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "sandbox-solution";
}

/* ────────────────────────────── 主装配 ────────────────────────────── */

/**
 * 组装产业方案草案。**只在 `calc.ok && vm.ok` 时产出结论**；任一失败 → 诚实回 `ok:false` + 错误 + 阻塞项，
 * 绝不给脏情景编一份看起来能卖的方案（对齐报告/解释的失败诚实范式）。
 */
export function buildSandboxSolutionDraft(input: SandboxSolutionInput): SandboxSolutionDraft {
  const { calc, vm, regionName, projectName, scenarioName, profile, price } = input;
  const solutionCalcRef = sandboxSolutionCalcRef();

  // 失败：透传引擎或视图的诚实错误，不产出任何方案正文/财务。
  if (!calc.ok || !vm.ok) {
    const reason = !calc.ok ? calc.reason : vm.error?.reason ?? "view_error";
    const detail = !calc.ok ? calc.detail : vm.error?.detail ?? "视图模型不可用";
    return {
      ok: false,
      draftVersion: SANDBOX_SOLUTION_VERSION,
      solutionCalcRef,
      error: { reason, detail },
      publishBlockers: [
        `引擎/视图未产出有效结果（${reason}），方案不可生成，更不可发布`,
        "须先补齐必备参数、消除非有限/除零输入后重跑",
      ],
    };
  }

  const c = calc; // CalcResultOk
  const engineVersions = c.engineVersions;
  const profileVersion = profile ? `profiles@${SANDBOX_PROFILES_VERSION}` : "通用（无画像裁剪）";

  /* —— R8.7：从引擎带来的逐输入溯源里，筛出「有可核验 http(s) 来源」的真正 FACT（本模块绝不重算/编造）—— */
  const inputProvenance = c.inputProvenance;
  const factInputsSorted = inputProvenance
    ? factInputs(inputProvenance)
        .slice()
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    : [];
  const factCount = factInputsSorted.length;
  const representativeFactUrl: string | undefined = factInputsSorted[0]?.sourceUrl;

  const name = projectName?.trim() || "沙盘产业项目方案";
  const scen = scenarioName?.trim() || "基准情景";
  const title = `${name}｜${scen}（${regionName}）`;
  const slug = slugify(`${name}-${scen}-${regionName}`);

  /* —— 正文：逐节从 vm/c 搬运或格式化，绝不重算 —— */
  const body: Record<string, unknown> = {};

  body.name = title;
  body.industry = SANDBOX_INDUSTRY_LABEL;
  body.targetEnterprises = profile
    ? `${profile.name}——${profile.summary}`
    : "通用（未选择企业画像；V1 支持车队 / 充电运营商 / 园区 / 公交 / 投资人五类画像裁剪）";
  body.coreProblem =
    "在给定地区与一组（示例）技术经济参数下，量化『光伏 + 储能 + 充电桩 + 新能源重卡补能』一体化场站的投资强度、" +
    "逐年现金流与回报（NPV/IRR/ROI/回收期）、能量自给与绿电渗透、以及对关键假设的敏感性，辅助选址与投资决策——" +
    "所有关键数字由确定性程序模型计算，AI 与画像仅负责解读与侧重裁剪。";

  // 能源 / 设备（来自技术侧的呈现层标签，非重算）
  if (vm.meta) {
    body.energy =
      `光伏绿电自用比例 ${vm.meta.pvSelfConsumptionLabel}；绿电渗透率 ${vm.meta.renewableFractionLabel}。` +
      "（首年能量平衡：光伏自用 / 余电上网 / 电网下网，取自技术模型输出。）";
  }
  if (vm.energyBalance && vm.energyBalance.length > 0) {
    body.equipment = `首年能量平衡（kWh）：${vm.energyBalance
      .map((e) => `${e.name} ${(e.value ?? 0).toLocaleString("zh-CN")}`)
      .join("，")}。`;
  }

  // 成本模型：毛/补贴/净 CAPEX + 首年 OPEX 分解（全部格式化自 vm/capex，不换算）
  if (vm.meta) {
    body.costModel =
      `净 CAPEX（补贴后）${vm.meta.capexNetLabel}；毛 CAPEX ${vm.meta.capexGrossLabel}；建设补贴抵扣 ${vm.meta.subsidyLabel}；` +
      `首年运维 OPEX ${vm.meta.opexY1Label}。` +
      (vm.capex && vm.capex.length ? `CAPEX 构成——${moneyItems(vm.capex).join("；")}。` : "");
  }

  // 收入模型：首年收入 + 构成
  if (vm.meta) {
    body.revenueModel =
      `首年收入 ${vm.meta.revenueY1Label}。` +
      (vm.revenue && vm.revenue.length ? `构成——${moneyItems(vm.revenue).join("；")}。` : "");
  }

  // ROI / 回收期：直接引用指标卡串（单一真源）
  body.roi = `投资回报率 ROI：${card(vm, "roi")}。盈亏平衡充电单价（首年简化口径）：${card(vm, "breakeven")}。`;
  body.payback = `动态（折现）回收期：${card(vm, "payback")}。`;

  // 敏感性：点名最敏感变量 + 龙卷风前列（引用 vm.tornado 的 label，不重算摆幅）
  if (vm.tornado && vm.tornado.length > 0) {
    const top = vm.tornado
      .slice(0, 5)
      .map((t, i) => `${i + 1}) ${t.label}（Δ%≈${t.deltaPct.toFixed(1)}%）`)
      .join("；");
    body.sensitivity =
      `以 NPV 为指标的 one-at-a-time 龙卷风敏感性——最敏感变量：${vm.mostSensitiveLabel ?? "—"}。` +
      `Top：${top}。（摆幅由引擎计算，此处仅择要。）`;
  }

  // 风险分析 + 实施条件（诚实：占位假设 + 需专业确认）
  body.riskAnalysis =
    "本方案所有入参均为【示例·待核实】占位假设（电价/光照/补贴/设备造价/利用率等），" +
    "经济口径为 E1–E8 透明简化模型、非可研级；结论默认『需专业人工确认』，不得作为投资/并网决策依据。" +
    (bad(c.metrics.npv) || c.metrics.npv < 0
      ? " 按当前参数 NPV 为非正，商业发布前须重点复核。"
      : "");
  body.implementationConditions =
    "落地前须以来源可追溯的真实地区电价、光照/等效小时、补贴与上网政策、设备与土建造价、车队补能负荷等数据替换占位假设并复核。";

  // 关键未知（结构化 + 叙述）
  const unknowns: DraftUnknown[] = [
    {
      name: "全部技术与经济入参",
      impact: "均为示例占位假设（ASSUMPTION·置信≤50），任一偏离真实值都会改变 CAPEX/OPEX/现金流与 NPV/IRR/回收期。",
      howToResolve: "接入来源可追溯的真实地区/设备/负荷数据（R5 地区包落库 + 人工核实），逐项把 ASSUMPTION 升级为 FACT 并留 sourceUrl。",
      severity: 90,
    },
  ];
  if (c.metrics.roi.ok === false) {
    unknowns.push({ name: "ROI 不可计算", impact: `引擎回报 ROI：${c.metrics.roi.reason ?? "unknown"}`, howToResolve: "核对初始投资与现金流符号是否异常。", severity: 70 });
  } else if (!c.metrics.irr.ok) {
    unknowns.push({ name: "IRR 不可计算", impact: `引擎回报 IRR：${c.metrics.irr.reason ?? "unknown"}`, howToResolve: "检查现金流符号变化/多根可能或折现口径。", severity: 60 });
  }
  if (c.metrics.discountedPaybackYears == null) {
    unknowns.push({ name: "回收期不存在", impact: "在分析期内累计折现现金流未回正（或从不回本）。", howToResolve: "延长计算期或复核收入/成本假设。", severity: 65 });
  }
  body.unknowns = unknowns.map((u) => `${u.name}：${u.impact ?? ""}`);

  body.nextActions = [
    "用真实地区电价/光照/补贴/造价/负荷数据替换占位假设并重跑引擎",
    "由专业人员复核经济性与技术假设（§16 高风险领域）",
    "为方案挂靠一个可引用的案例（Case），并设定对外价格",
    "复核通过后走发布守卫上架，接入查看→购买闭环",
  ];

  // 溯源 + AI 标注（把草案钉回引擎与版本，供审计与可信度判定）
  const provenanceTail =
    factCount === 0
      ? "全部入参为示例假设，无外部来源可追溯。"
      : `其中 ${factCount} 项入参已带可核验来源链接（代表：${representativeFactUrl}），其余仍为示例假设，须逐项核实后方可整体升为事实。`;
  body.sources =
    `结果溯源：引擎 calcRef=${c.calcRef}；内核版本 model@${engineVersions.model} · tech@${engineVersions.tech} · ` +
    `finance@${engineVersions.finance} · params@${engineVersions.params}；地区=「${regionName}」；画像=${profileVersion}；` +
    `方案生成口径 ${solutionCalcRef}。${provenanceTail}`;
  body.aiAnnotations =
    "本方案的每一个数字均由确定性程序模型计算并经视图模型格式化呈现；画像与（若接入的）AI 解释仅做侧重裁剪与自然语言解读，" +
    "不新增、不改写任何数字。证据等级：ASSUMPTION（示例·待核实）。";

  /* —— 财务条目：Decimal 串一律等于 calc 原值（搬运非重算），负/算不出即省略 —— */
  const financial: DraftFinancial = {
    capex: decimalOr(c.capex.net),
    opexAnnual: decimalOr(c.opexY1.gross),
    revenueAnnual: decimalOr(c.revenueY1.gross),
    currency: input.currency ?? "CNY",
    calcRef: c.calcRef,
    assumptions: {
      npv: Number.isFinite(c.metrics.npv) ? c.metrics.npv : null,
      roiRatio: c.metrics.roi.ok && typeof c.metrics.roi.value === "number" ? c.metrics.roi.value : null,
      irrFraction: c.metrics.irr.ok && typeof c.metrics.irr.value === "number" ? c.metrics.irr.value : null,
      discountedPaybackYears: c.metrics.discountedPaybackYears,
      simplePaybackYears: c.metrics.simplePaybackYears,
      breakEvenChargingPriceY1: c.breakEvenChargingPriceY1,
      evidenceKind: "ASSUMPTION",
      methodology: c.methodology,
      regionName,
      profileName: profile?.name ?? null,
      solutionCalcRef,
      engineVersions,
    },
    note: "全部为示例占位假设下的计算结果，Decimal 串直接搬运引擎值，未二次换算；为负或算不出的指标已省略并登记于关键未知/阻塞项。",
  };
  // R8.7：仅在确有可核验 FACT 来源时，把逐输入溯源 + 代表链接搬进行级数据，喂 R8.5 升级写路径。
  // （诚实基线 factCount=0 → 整段不触发，既有黄金草案逐字不变。）
  if (factCount > 0) {
    financial.assumptions = { ...(financial.assumptions ?? {}), inputProvenance, factInputCount: factCount };
    if (representativeFactUrl) financial.sourceUrl = representativeFactUrl;
    financial.note =
      `${financial.note ?? ""} 另有 ${factCount} 项入参带可核验来源链接（逐输入见 assumptions.inputProvenance、代表见 sourceUrl），` +
      "其余仍为示例假设，须逐项核实后方可整体升为事实（§20）；本行 evidenceKind 暂留 ASSUMPTION。";
  }
  // ROI 引擎给比值 → roiPct 需要百分数（×100），仅非负可入 Decimal 字段。
  if (c.metrics.roi.ok && typeof c.metrics.roi.value === "number" && c.metrics.roi.value >= 0) {
    financial.roiPct = (c.metrics.roi.value * 100).toFixed(2);
  }
  // IRR 给小数 → irrPct 百分数；仅非负可入。
  if (c.metrics.irr.ok && typeof c.metrics.irr.value === "number" && c.metrics.irr.value >= 0) {
    financial.irrPct = (c.metrics.irr.value * 100).toFixed(4);
  }
  // 回收期（取折现口径，审慎）。
  if (c.metrics.discountedPaybackYears != null && c.metrics.discountedPaybackYears >= 0) {
    financial.paybackYears = c.metrics.discountedPaybackYears.toFixed(2);
  }

  /* —— 发布阻塞项：机器可校验，把「尚不可售卖」钉成产物（§16 / 总控）—— */
  const publishBlockers: string[] = [
    factCount === 0
      ? "入参均为【示例·待核实】占位假设（ASSUMPTION），须以来源可追溯的真实数据替换并复核后方可对外发布/售卖"
      : `部分入参（${factCount} 项）已接可核验来源链接，但仍有其余入参为示例假设，须全部替换为可追溯真实数据并复核后方可对外发布/售卖`,
    "沙盘方案须挂靠一个已存在的案例（Case.caseId 必填外键）才能进入发布/购买闭环——当前草案未附 caseId",
    "需专业人工确认（§16：经济与技术假设属高风险领域，AI 只解读、人做关键决策）",
  ];
  if (!price || price.trim() === "") {
    publishBlockers.splice(1, 0, "尚未设定对外价格（发布上架前必填）");
  }
  if (bad(c.metrics.npv) || c.metrics.npv < 0) {
    publishBlockers.push("按当前参数 NPV 为非正，作商业发布须重点复核");
  }

  const riskDomains = ["投资", "能源", "政策"];

  const summary =
    `基于沙盘决策模型（${regionName}${profile ? `·${profile.name}` : ""}）生成的「${SANDBOX_INDUSTRY_LABEL}」产业方案草案。` +
    `核心结论：净 CAPEX ${vm.meta?.capexNetLabel ?? "—"}、NPV ${card(vm, "npv")}、IRR ${card(vm, "irr")}、` +
    `动态回收期 ${card(vm, "payback")}、ROI ${card(vm, "roi")}。所有数字为程序计算、入参为示例假设、需专业人工确认。`;

  return {
    ok: true,
    draftVersion: SANDBOX_SOLUTION_VERSION,
    solutionCalcRef,
    provenance: {
      calcRef: c.calcRef,
      engineVersions,
      profilesVersion: SANDBOX_PROFILES_VERSION,
    },
    title,
    slug,
    summary,
    body,
    financials: [financial],
    unknowns,
    riskDomains,
    needsProfessionalReview: true,
    evidenceGrade: "ASSUMPTION",
    price: price && price.trim() !== "" ? price.trim() : undefined,
    currency: input.currency ?? "CNY",
    publishBlockers,
  };
}
