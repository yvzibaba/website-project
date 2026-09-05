/**
 * 沙盘「动态报告」纯函数（中途重构 R6.1 · §9 动态报告 / §14 优先级第 5 项）。
 *
 * 职责：把 R4 已建好的**视图模型**（`buildSandboxViewModel` 的产物，其数字全部来自 R2 引擎）
 * 确定性地叙述成一份**结构化、可导出的中文决策报告**。这一步**不碰任何模型 / 网络 / 时钟 / 随机**，
 * 是「程序算、LLM 只解释」（§7）里**程序负责的那一半**——报告的每一个数字都经 `sandbox-view` 的
 * 格式化器从引擎输出生成，本模块只做**排序、择要、拼句**，**绝不重算 NPV/IRR/回收期/ROI**（第 16 条单一真源）。
 *
 * 为什么单拎一层而非在组件里直接拼字符串：
 *   - §9 要求「报告读最新 CalcResult、版本化」——把报告口径固化成 `REPORT_VERSION` + 纯函数，
 *     可用黄金样本单测「焊死」报告叙述与模型输出一致（延续 `scoring.ts`/`sandbox-view.ts` 范式），
 *     不靠肉眼验收；R6.2 的 AI 解释（`runTask`）只会在这份**确定性骨架**之上追加「为何变 / what-if」的
 *     自然语言点评，绝不改这些数、也绝不被允许算这些数。
 *   - 诚实贯穿（§16/§20）：报告恒带「占位假设 + E1–E8 简化口径 + 需专业人工确认 + §17 端到端未通不得当
 *     决策依据」声明；引擎失败时只回诚实错误、绝不产出编造的结论。
 *
 * 输入契约：只吃 `SandboxViewModel`（视图层产物）+ 少量展示上下文（地区名 / 用户改动清单 / 折现率），
 * 不 import 任何 server 引擎（类型走 `import type`），与 `sandbox-view.ts` 同为 client-safe 纯投影。
 */

import type { SandboxViewModel } from "@/lib/sandbox-view";
import type { ProfileFocusTag, SandboxEnterpriseProfile } from "@/server/sandbox-profiles";

/** 报告口径版本（叙述结构 / 择要规则变化须升版记因，宪法第 13 条）。 */
export const REPORT_VERSION = "1.1.0"; // 1.1.0：新增可选「企业个性化视角」节（R7 · 依画像裁剪，只重排既有指标卡值、绝不重算）

/* ────────────────────────────── 类型 ────────────────────────────── */

/** 一条被用户改动的参数（由调用方从 `SANDBOX_PARAMS` 标签 + `overrides` 预备好，本模块不查目录）。 */
export interface ChangedParamView {
  key: string;
  label: string;
  /** 用户改后的展示值（已格式化或原值字符串均可）。 */
  value: string;
  unit?: string;
}

export interface ReportInput {
  /** 必须是 `buildSandboxViewModel` 对**当前**参数情景的输出（§9「读最新 CalcResult」）。 */
  vm: SandboxViewModel;
  /** 地区名（如「山西」「全国通用（示例）」），供标题与来路说明。 */
  regionName: string;
  /** 用户显式改动的参数（可空=全用地区/默认）。 */
  changedParams?: ChangedParamView[];
  /** 折现率（百分数原值，如 8 表示 8%），仅供执行摘要口径提示，不参与任何计算。 */
  discountRatePct?: number;
  /**
   * 当前企业画像（R7 · §14 第 7 项）。**仅在 vm.ok 且提供了非空画像时**追加一节「企业个性化视角」，
   * 该节只从已算好的指标卡里**挑选/排序/引用**，绝不重算任何数字。省略此字段 → 报告与 R6 输出逐字一致（向后兼容）。
   */
  profile?: SandboxEnterpriseProfile;
}

/** 报告的一个分节。kind 决定 UI 如何渲染（prose=段落；bullets=键值条；list=要点）。 */
export interface ReportSection {
  key: string;
  title: string;
  kind: "prose" | "bullets" | "list";
  /** prose / list 用。 */
  paragraphs?: string[];
  /** bullets 用（label + value）。 */
  items?: { label: string; value: string }[];
}

export interface SandboxReport {
  reportVersion: string;
  ok: boolean;
  title: string;
  regionName: string;
  /** 生成依据（溯源，第 7/16 条）：把报告钉到具体 calcRef + 各内核版本。 */
  generatedFrom: {
    calcRef?: string;
    viewVersion?: string;
    engineVersions?: SandboxViewModel["engineVersions"];
  };
  sections: ReportSection[];
  /** 失败态的诚实说明（无脏结论）。 */
  error?: { reason: string; detail: string };
  needsProfessionalReview?: boolean;
  /** 常驻免责条（成功/失败都带，§16/§17）。 */
  disclaimers: string[];
}

/* ────────────────────────────── 内部小工具（仅择要 / 比较，非重算） ────────────────────────────── */

function findCard(vm: SandboxViewModel, key: string): string | undefined {
  return vm.cards?.find((c) => c.key === key)?.value;
}

/** 从卡片取数值符号判档（NPV 卡已格式化，这里另看 cashFlow/原始卡 hint 不足以判正负，故用 vm 里可得的正负线索）。 */
function npvNonNegative(vm: SandboxViewModel): boolean | null {
  const card = vm.cards?.find((c) => c.key === "npv");
  if (!card) return null;
  const v = card.value;
  if (v === "—") return null;
  // formatMoney 对负数前置 "-"；据此判正负（纯呈现层字符串判定，不重算 NPV）。
  return !v.trim().startsWith("-");
}

/** 关注点 token → 中文短语（未知 token 一律忽略，绝不臆造未在模型中出现的内容，§16）。 */
const FOCUS_PHRASE: Record<ProfileFocusTag, string> = {
  selfConsumption: "光伏绿电自用比例（自发自用能省多少电费）",
  green: "绿电渗透率（碳减排与绿色示范价值）",
  cashflow: "逐年现金流的稳定与前期回正节奏",
  scale: "可复制扩张的规模弹性",
  risk: "对关键假设的敏感性与下行风险",
};

/**
 * R7「企业个性化视角」节：**只引用已算好的指标卡值**（按画像 emphasis 的优先级挑卡），
 * 把「这类企业最该看哪几个结论」讲清。绝不重算、绝不引入报告外的新数字。无画像 / 无可用卡则不产出该节（返回 null）。
 */
function buildProfileSection(vm: SandboxViewModel, profile: SandboxEnterpriseProfile): ReportSection | null {
  const byKey = new Map((vm.cards ?? []).map((c) => [c.key, c] as const));
  const picked = profile.emphasis.metricKeys
    .map((k) => byKey.get(k))
    .filter((c): c is NonNullable<typeof c> => c != null);
  const focus = profile.emphasis.focusTags.map((t) => FOCUS_PHRASE[t]).filter(Boolean);

  const paragraphs: string[] = [profile.emphasis.headline];
  if (picked.length) {
    paragraphs.push(`本画像建议优先关注：${picked.map((c) => `「${c.label} ${c.value}」`).join("、")}。`);
  }
  if (focus.length) {
    paragraphs.push(`此外，这类企业通常还侧重：${focus.join("；")}。`);
  }
  paragraphs.push(
    `企业画像「${profile.name}」的默认参数为示例占位假设（非经核事实）：${profile.note} 换画像即换一组预设起点，但方案数字仍全部由确定性引擎现算、不随画像口径改动。`,
  );

  return {
    key: "profile",
    title: "企业个性化视角（依企业画像裁剪）",
    kind: "list",
    paragraphs,
  };
}

/* ────────────────────────────── 报告装配 ────────────────────────────── */

const BASE_DISCLAIMERS = [
  "本报告全部数字由**确定性计算引擎**（参数分层 → 技术能耗 → 经济编排 → 财务评价）程序算出，AI 不参与算数，只负责解释。",
  "入参默认均为**占位假设**（经济口径为透明简化的 E1–E8，非可研/财税级），结论**需专业人工确认**。",
];

const E2E_DISCLAIMER =
  "§17 端到端主链（选地区→改参数→跑→技术/经济/风险/敏感性→AI 解释→个性化方案）尚在建，本报告为其中「技术/经济/风险/敏感性 + 动态报告」环节的确定性产物，**不得单独作为投资或并网决策依据**。";

/** 生成结构化报告。`vm.ok=false` 时只回诚实错误 + 免责，绝不编造结论。 */
export function buildSandboxReport(input: ReportInput): SandboxReport {
  const { vm, regionName, changedParams = [], discountRatePct, profile } = input;

  const generatedFrom: SandboxReport["generatedFrom"] = {
    calcRef: vm.calcRef,
    viewVersion: vm.viewVersion,
    engineVersions: vm.engineVersions,
  };

  // ── 失败态：诚实，不产出脏结论 ──
  if (!vm.ok) {
    const reason = vm.error?.reason ?? "unknown";
    const detail = vm.error?.detail ?? "计算引擎未通过";
    const missing = vm.error?.missingInputs ?? [];
    const invalid = vm.error?.invalidInputs ?? [];
    const diag: string[] = [];
    if (missing.length) diag.push(`缺少的输入参数：${missing.join("、")}`);
    if (invalid.length) diag.push(`非法的输入参数：${invalid.join("、")}`);
    diag.push("请回到参数控制台修正后重试；本报告不展示任何未经完整计算的估算值。");
    return {
      reportVersion: REPORT_VERSION,
      ok: false,
      title: `产业项目沙盘报告 · ${regionName}（未能生成）`,
      regionName,
      generatedFrom,
      error: { reason, detail },
      needsProfessionalReview: true,
      disclaimers: [...BASE_DISCLAIMERS, E2E_DISCLAIMER],
      sections: [
        {
          key: "error",
          title: "当前参数不足以生成结论",
          kind: "list",
          paragraphs: [`引擎返回状态：${reason} — ${detail}`, ...diag],
        },
      ],
    };
  }

  const meta = vm.meta;
  const npv = findCard(vm, "npv") ?? "—";
  const irr = findCard(vm, "irr") ?? "—";
  const payback = findCard(vm, "payback") ?? "—";
  const roi = findCard(vm, "roi") ?? "—";
  const breakeven = findCard(vm, "breakeven") ?? "—";
  const positive = npvNonNegative(vm);
  const changedCount = changedParams.length;
  const changedDesc = changedCount
    ? `在${regionName}地区默认参数基础上，用户改动了 ${changedCount} 项：${changedParams
        .map((p) => `${p.label}=${p.value}${p.unit ? ` ${p.unit}` : ""}`)
        .join("；")}`
    : `采用${regionName}地区默认参数（未作个性化改动）`;

  const verdict =
    positive == null
      ? "净现值不可得，无法给出倾向性判断。"
      : positive
        ? "在当前参数下项目净现值为正，经济面初步乐观；但须结合下方敏感性与人工复核项审慎解读。"
        : "在当前参数下项目净现值为负，经济面承压；建议复核关键假设或调整规模/价格参数后再评估。";

  // 执行摘要
  const execParagraphs = [
    `${changedDesc}。`,
    `核心结论：净现值 NPV ${npv}，内部收益率 IRR ${irr}` +
      (discountRatePct != null ? `（折现率口径 ${discountRatePct}%）` : "") +
      `，动态回收期 ${payback}，投资回报率 ROI ${roi}。盈亏平衡充电单价 ${breakeven}。`,
    verdict,
  ];

  const sections: ReportSection[] = [
    { key: "exec", title: "一、执行摘要", kind: "prose", paragraphs: execParagraphs },
  ];

  // R7 · §14 第 7 项「企业个性化」：仅当调用方给了画像时，紧随执行摘要追加一节「企业个性化视角」，
  // 只挑既有的确定性指标卡值按画像优先级重排解读，绝不重算、绝不引新数字（不选画像 → 本节不出现，输出逐字同 R6）。
  if (profile) {
    const profileSection = buildProfileSection(vm, profile);
    if (profileSection) sections.push(profileSection);
  }

  // 投资与成本结构
  if (meta) {
    sections.push({
      key: "structure",
      title: "二、投资与首年运营结构",
      kind: "bullets",
      items: [
        { label: "净 CAPEX（补贴后）", value: meta.capexNetLabel },
        { label: "毛 CAPEX", value: meta.capexGrossLabel },
        { label: "建设补贴抵扣", value: meta.subsidyLabel },
        { label: "首年运维 OPEX", value: meta.opexY1Label },
        { label: "首年收入", value: meta.revenueY1Label },
        { label: "计算期", value: `${meta.projectLifeYears} 年` },
      ],
    });
  }

  // 能量与绿色指标（仅在 tech 可用时）
  if (meta) {
    sections.push({
      key: "energy",
      title: "三、能量与绿色指标",
      kind: "bullets",
      items: [
        { label: "光伏自用率", value: meta.pvSelfConsumptionLabel },
        { label: "绿电渗透率", value: meta.renewableFractionLabel },
      ],
    });
  }

  // 敏感性（最敏感变量，来自 R2.3 龙卷风；数字来自引擎不重算）
  if (vm.tornado && vm.tornado.length) {
    const top = vm.tornado
      .filter((t) => t.swing != null)
      .slice(0, 3)
      .map((t) => {
        const dir = t.swing != null && t.swing >= 0 ? "正向" : "负向";
        return `${t.label}（±${t.deltaPct}% 摆动对 NPV ${dir}影响，摆幅 ${Math.abs(t.swing as number).toFixed(0)}）`;
      });
    sections.push({
      key: "sensitivity",
      title: "四、敏感性：结果最容易被谁左右",
      kind: "prose",
      paragraphs: [
        vm.mostSensitiveLabel
          ? `最敏感变量为「${vm.mostSensitiveLabel}」。`
          : "敏感性扫描未能定位最敏感变量。",
        top.length ? `按影响大小前列：${top.join("；")}。` : "",
        "龙卷风图在报告页可视化各变量的正负摆动幅度，辅助判断应优先核实哪些假设。",
      ].filter(Boolean),
    });
  }

  // 关键假设与简化口径（引擎 notes 原样透出，不加工成"事实"）
  sections.push({
    key: "assumptions",
    title: "五、关键假设与简化口径",
    kind: "list",
    paragraphs: [
      "以下为本模型显式声明的简化口径与假设，任何一项偏离都需重算：",
      ...(vm.notes ?? []),
      "所有入参默认均为【示例·待核实】占位假设，须经可追溯来源替换后方可用于真实决策。",
    ],
    // notes 已在 paragraphs 原样透出
  });

  // 风险与人工复核
  sections.push({
    key: "risk",
    title: "六、风险与人工复核",
    kind: "list",
    paragraphs: [
      "本沙盘结论属高风险领域，须由具备产业、财务、电力专业背景的人员复核后方可采信或对外发布。",
      "V1 经济口径未内嵌融资结构利息税盾、流动资金、逐时负荷曲线（S1）、电池 SOH/温度/弃电（S5）与充电需求增长曲线；残值取名义常数（E7）。",
      E2E_DISCLAIMER,
    ],
  });

  // 溯源
  const ev = vm.engineVersions;
  sections.push({
    key: "provenance",
    title: "七、数据溯源",
    kind: "bullets",
    items: [
      { label: "计算引用 calcRef", value: vm.calcRef ?? "—" },
      { label: "模型版本", value: ev?.model ?? "—" },
      { label: "技术内核版本", value: ev?.tech ?? "—" },
      { label: "财务内核版本", value: ev?.finance ?? "—" },
      { label: "参数模板版本", value: ev?.params ?? "—" },
      { label: "视图版本", value: vm.viewVersion },
      { label: "报告版本", value: REPORT_VERSION },
    ],
  });

  return {
    reportVersion: REPORT_VERSION,
    ok: true,
    title: `产业项目可视化决策沙盘报告 · ${regionName}`,
    regionName,
    generatedFrom,
    sections,
    needsProfessionalReview: vm.needsProfessionalReview ?? true,
    disclaimers: [...BASE_DISCLAIMERS, E2E_DISCLAIMER],
  };
}
