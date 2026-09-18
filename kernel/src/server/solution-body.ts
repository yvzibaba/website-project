import { z } from "zod";

/**
 * 方案正文（Solution.body）的 34 分节规范 + 归一器（Phase 8 M2，纯函数、可单测）。
 *
 * 为什么：总控 §3「产业解决方案 Solution Package」把一份可售方案**逐字定义了 34 个分节**，
 * ROADMAP §8 的「Solution.body 34 分节规范」正是这一节——它已由总控权威给定，无需另等裁决。
 * 规则 12 要求「结构化保存而非纯文章」，故 body 以 `Record<string, unknown>`（键→内容）入库
 * （见 solution-admin 的 `z.record(z.string(), z.unknown())`），前端按 canonical 顺序渲染。
 *
 * 设计（宪法第 2/7/16 条：简单、可验证、可复算、少依赖）：
 *   - `SOLUTION_SECTIONS` 是本仓对 34 分节的**单一真源**（key 稳定、title 照抄总控）。
 *   - `parseSolutionBody` 把任意入库 body 归一成**固定 34 条**的有序数组：
 *     命中（按 key 或中文 title 取到非空内容）→ filled；否则 → 占位 pending（诚实标「待补充」）。
 *     归一器绝不臆造内容，只做「有则透出、无则显式空缺」，与 Phase 7 M3 scoreBreakdown=null 同构。
 *   - 纯函数、零 DB、零 Next 依赖，单测覆盖，不受流水线未来写入格式漂移影响。
 *
 * 注：部分分节（如成本模型/收入模型/ROI/回收期/关键未知变量/来源）在详情页另有**结构化卡片**
 * （SolutionFinancial / UnknownVariable / Evidence）。二者可并存：结构化卡片是可复算真源，
 * body 分节是叙述性说明。此点为当前刻意保留的可控冗余，待真实流水线接入后再收敛。
 */

/** 总控 §3 逐字给定的 34 分节（顺序即渲染顺序）。 */
export const SOLUTION_SECTIONS = [
  { key: "name", title: "项目/方案名称" },
  { key: "industry", title: "目标行业" },
  { key: "targetEnterprises", title: "适用企业" },
  { key: "coreProblem", title: "解决的核心问题" },
  { key: "globalCases", title: "全球参考案例" },
  { key: "caseBreakdown", title: "成功案例拆解" },
  { key: "businessModel", title: "商业模式拆解" },
  { key: "techRoadmap", title: "技术路线" },
  { key: "software", title: "所需软件" },
  { key: "aiCapabilities", title: "所需AI能力" },
  { key: "githubProjects", title: "GitHub开源项目" },
  { key: "licenses", title: "开源许可证" },
  { key: "commercialAlternatives", title: "商业软件替代方案" },
  { key: "supplyChain", title: "中国供应链" },
  { key: "equipment", title: "设备需求" },
  { key: "materials", title: "原材料需求" },
  { key: "energy", title: "能源需求" },
  { key: "implementationConditions", title: "建设/实施条件" },
  { key: "localization", title: "中国本土化方案" },
  { key: "costModel", title: "成本模型" },
  { key: "revenueModel", title: "收入模型" },
  { key: "roi", title: "ROI" },
  { key: "payback", title: "投资回收期" },
  { key: "sensitivity", title: "敏感性分析" },
  { key: "riskAnalysis", title: "风险分析" },
  { key: "bullCase", title: "Bull Case" },
  { key: "bearCase", title: "Bear Case" },
  { key: "unknowns", title: "关键未知变量" },
  { key: "roadmap", title: "实施路线" },
  { key: "poc", title: "POC方案" },
  { key: "vendorSuggestions", title: "供应商/技术方建议" },
  { key: "nextActions", title: "下一步行动" },
  { key: "sources", title: "全部重要事实的来源" },
  { key: "aiAnnotations", title: "AI假设/推断/预测的明确标注" },
] as const;

export type SolutionSectionKey = (typeof SOLUTION_SECTIONS)[number]["key"];
export const SOLUTION_SECTION_COUNT = SOLUTION_SECTIONS.length; // 应为 34

/** 归一后的一节：content 为 undefined 即该节尚未填充。 */
export interface SolutionSection {
  key: string;
  title: string;
  content: unknown;
  filled: boolean;
}

/** 判断一个值是否算「有内容」（空串/空数组/空对象/ null/undefined 视为未填）。 */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false; // number / boolean 一律视为有内容（哪怕 0 / false）
}

/**
 * 从任意 body 里为某一节取内容：先按 key 命中，再按中文 title 命中；都空则未填。
 * 未知键（不在 34 分节内）不参与本函数，由 parseSolutionBody 收入 extras 供审计透出。
 */
function pickSection(body: Record<string, unknown>, key: string, title: string): unknown {
  if (Object.prototype.hasOwnProperty.call(body, key) && !isEmptyValue(body[key])) return body[key];
  if (Object.prototype.hasOwnProperty.call(body, title) && !isEmptyValue(body[title])) return body[title];
  return undefined;
}

export interface ParsedSolutionBody {
  /** 固定 34 条，canonical 顺序；filled=false 即待补充。 */
  sections: SolutionSection[];
  /** 已填节数 / 总节数（用于「完成度 n/34」可见化，呼应规则 12 结构化完整性）。 */
  filledCount: number;
  totalCount: number;
  /** body 是否为空（null / 非对象 / 空对象）——决定详情页显示整块占位还是分节列表。 */
  empty: boolean;
  /** 落在 34 分节之外的未知键（保留原值，供后台/审计发现契约漂移，不静默丢弃）。 */
  extras: Array<{ key: string; content: unknown }>;
}

/**
 * 归一入库 body → 固定 34 分节有序视图。纯函数，无副作用、无 DB。
 * 传入非对象（含 null/undefined）视为空 body：返回全 pending + empty=true。
 */
export function parseSolutionBody(body: unknown): ParsedSolutionBody {
  const isObj = body !== null && typeof body === "object" && !Array.isArray(body);
  const obj = (isObj ? body : {}) as Record<string, unknown>;

  const sections: SolutionSection[] = SOLUTION_SECTIONS.map((s) => {
    const content = pickSection(obj, s.key, s.title);
    return { key: s.key, title: s.title, content, filled: content !== undefined };
  });

  const consumedKeys = new Set<string>();
  for (const s of SOLUTION_SECTIONS) {
    consumedKeys.add(s.key);
    consumedKeys.add(s.title);
  }
  const extras: Array<{ key: string; content: unknown }> = [];
  if (isObj) {
    for (const k of Object.keys(obj)) {
      if (consumedKeys.has(k)) continue;
      if (isEmptyValue(obj[k])) continue;
      extras.push({ key: k, content: obj[k] });
    }
  }

  const filledCount = sections.filter((s) => s.filled).length;
  const empty = !isObj || Object.keys(obj).length === 0;

  return { sections, filledCount, totalCount: SOLUTION_SECTIONS.length, empty, extras };
}

/* 供 validation 复用的 body 结构 schema（键为任意字符串、值任意可 JSON 化——宽松，
   真正的分节语义由本模块归一器兜底，避免录入端与展示端两套规则漂移，宪法单一真源）。 */
export const SolutionBodySchema = z.record(z.string(), z.unknown());
