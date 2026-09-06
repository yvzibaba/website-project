import { z } from "zod";
import { EvidenceTypeSchema, type EvidenceType } from "@/lib/validation";

/**
 * 参数引擎内核（重构 R0 契约 + R1.1 解析器，纯函数 · 无 DB · 无 UI · 无 HTTP · server 域逻辑）。
 *
 * 为什么存在（《中途重构总控》§4 命脉 / §5 参数引擎 / §6 地区政策 / §7 程序计算 / §16 事实与假设区分）：
 *   新核心「产业项目可视化决策沙盘」要求——**关键变量必须参数化**，用户改参数 → 模型重算 → 技术结果 /
 *   经济结果 / 图表 / 风险 / AI 解释 / 动态报告**全链路同步变化**，"不能只改页面上的数字"。要兑现这条链，
 *   第一块地基就是把每个变量建成**带元数据的一等参数**：默认值 / 用户输入 / 地区值 / 政策值 / 计算值，
 *   且每个值都携带 **来源 + 生效时间 + 置信度 + 是否可编辑 + 暴露层级**（§5）。本模块只做「解析层」：
 *   给定参数定义 + 各来源层的值 + 当前时间，产出每个参数的**最终值 + 它的来源/置信度/是否被覆写**，
 *   是纯函数、可离线测死、可复算、版本化，绝不碰数据库或渲染（那些在 R2 计算引擎 / R3 持久层 / R4 可视化）。
 *
 * 与既有代码的关系（宪法第 16 条：单一真源、防漂移）：
 *   - 复用 `EvidenceTypeSchema`（FACT/ASSUMPTION/INFERENCE/PREDICTION）作参数的**认识论标签**——一个默认
 *     值是"实测事实"还是"占位假设"直接决定报告可信度呈现（§16），与证据体系同一口径，不另造枚举；
 *   - 沿用 `scoring.ts` 的"导出常量集中 + Zod 校验 + 判别联合返回 + 版本常量"范式（工程模板复用），
 *     但公式/权重是沙盘自己的，与案例评分正交。
 *
 * 解析优先级（§6：用户可在允许范围内覆写；政策/地区默认覆盖全局默认）：
 *   user（覆写，裁剪到允许区间）> policy（仅当在有效期内）> region > spec.defaultValue。
 *   **政策过期不得当现行默认**（§6 硬约束）：effectiveUntil < now 的政策值被跳过并留痕，回落低层。
 *   derived（计算值）在所有基础参数解析完后，由注册表按依赖求值，覆盖其结果为最终值。
 *
 * 诚实边界（§16 / 第 20 条）：默认值带 confidence + evidenceKind；本层不知道任何"真实数字"是否被核实——
 *   上游模板把没核实的默认标 ASSUMPTION/低置信，本层照抄透传，绝不擅自升格为 FACT。
 */

/* ─────────────────────────── 版本（第 13 条：改契约/默认须升版并记录原因） ─────────────────────────── */

/**
 * 参数引擎契约版本。新增来源层语义、改解析优先级、改覆写裁剪规则等 = 破坏性 → 升主版本。
 *
 * 1.1.0（中途重构 R8.7 · 真实数据接入）：**加性**扩展——`ValueLayer` 新增逐值结构化溯源 `sources`，
 *   `ResolvedParameter` 新增 `sourceUrl` / `sourceType` / `asOf` 三字段，并加一条**诚实闸门**：凡逐值 `sources`
 *   声称 `evidenceKind="FACT"` 却无可用 `http(s)` 链接，一律降为 `ASSUMPTION` 并留痕（§20 绝不把无来源的值当事实）。
 *   不改动解析优先级 / 裁剪 / 过期语义，也不追溯改变既有「层级 evidenceKind（无链接）」的 legacy 行为（向后兼容，非破坏 → 升次版本）。
 */
export const PARAM_ENGINE_VERSION = "1.1.0";

/* ─────────────────────────── 枚举与判别 ─────────────────────────── */

/** 参数分组（决定 UI 分栏与默认暴露策略；V1 沙盘五组）。用 String 联合而非 Prisma 枚举：契约层、无库。 */
export const PARAM_GROUPS = ["region", "policy", "project", "technology", "finance"] as const;
export type ParamGroup = (typeof PARAM_GROUPS)[number];
export const ParamGroupSchema = z.enum(PARAM_GROUPS);

/**
 * 暴露层级（§5：普通 / 高级 / 专业用户）：
 *   basic   —— 所有用户可见可改（如地区、车队规模）；
 *   advanced—— 进阶参数（如自用比例、储能循环效率）；
 *   pro     —— 专业参数（如折现率、衰减率），默认折叠、标"建议专业人士确认"。
 */
export const EXPOSURE_TIERS = ["basic", "advanced", "pro"] as const;
export type ExposureTier = (typeof EXPOSURE_TIERS)[number];
export const ExposureTierSchema = z.enum(EXPOSURE_TIERS);

/** 参数值类型（V1 以 numeric 为主；boolean/select 保留以覆盖"是否并网/计价方式"类开关，解析层只透传不裁剪）。 */
export const PARAM_KINDS = ["numeric", "boolean", "select"] as const;
export type ParamKind = (typeof PARAM_KINDS)[number];
export const ParamKindSchema = z.enum(PARAM_KINDS);

/**
 * 一个已解析值的"来路"（§5 五种取值来源）。
 *   default—— 参数定义自带的全局默认；region/policy—— 地区/政策默认；user—— 用户覆写；derived—— 计算值。
 */
export const VALUE_ORIGINS = ["default", "region", "policy", "user", "derived"] as const;
export type ValueOrigin = (typeof VALUE_ORIGINS)[number];
export const ValueOriginSchema = z.enum(VALUE_ORIGINS);

/* ─────────────────────────── 参数定义（ParameterSpec） ─────────────────────────── */

export interface ParameterSpec {
  /** 全局唯一键，建议点分命名空间，如 "pv.capacityKwp" / "finance.discountRate"。 */
  key: string;
  /** 中文标签（展示用）。 */
  label: string;
  kind: ParamKind;
  group: ParamGroup;
  exposure: ExposureTier;
  unit?: string;
  /** numeric 全局默认（其它 kind 的默认放 `defaultChoice`/`defaultFlag`，本 V1 主要用 numeric）。 */
  defaultValue: number;
  /** 允许覆写区间（§6）：用户/地区覆写会被裁剪进 [min,max]；缺省=不限。 */
  min?: number;
  max?: number;
  /** 是否允许用户改（§5 editable 标志）；false 则用户覆写被忽略并留痕。 */
  editable: boolean;
  /** 该默认的来源描述（§7 可追溯；V1 占位假设也应写清"示例假设"）。 */
  source: string;
  /** 0..100 置信度（§5）。 */
  confidence: number;
  /** 该默认的认识论标签（§16）：没核实的占位须标 ASSUMPTION，绝不伪装 FACT。 */
  evidenceKind: EvidenceType;
  /** 仅 kind="numeric" 且为派生值时使用：声明依赖的其它参数键（供 UI 提示 + 环检测）。 */
  dependsOn?: string[];
  /** true = 该键由注册表计算，defaultValue 仅作兜底占位。 */
  derived?: boolean;
}

/** 参数定义 Zod schema（入站即校验，防脏定义静默污染解析）。 */
export const ParameterSpecSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    kind: ParamKindSchema,
    group: ParamGroupSchema,
    exposure: ExposureTierSchema,
    unit: z.string().optional(),
    defaultValue: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    editable: z.boolean().default(true),
    source: z.string().default(""),
    confidence: z.number().int().min(0).max(100).default(50),
    evidenceKind: EvidenceTypeSchema.default("ASSUMPTION"),
    dependsOn: z.array(z.string()).optional(),
    derived: z.boolean().optional().default(false),
  })
  .superRefine((s, ctx) => {
    if (s.min != null && s.max != null && s.min > s.max) {
      ctx.addIssue({ code: "custom", path: ["max"], message: `${s.key}: min 不能大于 max` });
    }
    if (s.derived && (!s.dependsOn || s.dependsOn.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["dependsOn"], message: `${s.key}: 派生参数必须声明 dependsOn` });
    }
  });

/** 参数集合 schema（键唯一性 + 逐条合法）。 */
export const ParameterSetSchema = z
  .array(ParameterSpecSchema)
  .superRefine((specs, ctx) => {
    const seen = new Set<string>();
    for (const s of specs) {
      if (seen.has(s.key)) {
        ctx.addIssue({ code: "custom", message: `参数键重复：${s.key}` });
      }
      seen.add(s.key);
    }
  });

/* ─────────────────────────── 来源层（Region/Policy/User）+ 派生注册表 ─────────────────────────── */

/**
 * 单个参数值的**结构化溯源**（R8.7 真实数据接入）。与 `ValueLayer` 里旧的层级 `source`（自由文本，可能只是文件名/省份名）
 * 不同，本结构承载**可点击、可核验**的来源：`sourceUrl`（http(s) 链接）+ `sourceType`（官方/统计/行业媒体…）+ `asOf`（数据时点）。
 * 关键诚实约束（§20 / §12）：只有当 `sourceUrl` 是可用 http(s) 链接时才允许把该值记为 `FACT`；
 * 解析层遇到「FACT 却无可用链接」会**自动降级为 ASSUMPTION**并留痕，绝不把无来源的数字当事实外泄。
 * 纯契约类型、无副作用，供地区/政策包逐值挂载；未挂 `sources` 的键沿用层级 `source`/`confidence`/`evidenceKind`（向后兼容）。
 */
export interface ValueSourceMeta {
  /** 可核验来源链接（须 http(s) 才会被承认为 FACT 依据；否则视为脏输入降级）。 */
  sourceUrl?: string;
  /** 来源类型标签（如 "政府公告" / "统计年鉴" / "行业媒体" / "企业披露"），供报告分类展示。 */
  sourceType?: string;
  /** 数据时点（"as of"，如 "2024-06" / "2024-12-31"），区分「现价 / 历史价」。 */
  asOf?: string;
  /** 该值的认识论标签；缺省 ASSUMPTION（没核实不得自动升 FACT）。 */
  evidenceKind?: EvidenceType;
  /** 0..100 置信度（覆盖层级 confidence）。 */
  confidence?: number;
  /** 人类可读补充说明（如口径、含不含基金附加）。 */
  note?: string;
}

export const ValueSourceMetaSchema = z.object({
  sourceUrl: z.string().optional(),
  sourceType: z.string().optional(),
  asOf: z.string().optional(),
  evidenceKind: EvidenceTypeSchema.optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  note: z.string().optional(),
});

/** 一层"键→值"覆写。region / policy 共用此形状，policy 额外带生效窗口。 */
export interface ValueLayer {
  /** 参数键 → 该层给出的值。 */
  values: Record<string, number | boolean | string>;
  /**
   * 逐值结构化溯源（R8.7）：参数键 → `ValueSourceMeta`。命中该层某个键时，若此处给了 `sources[key]`，
   * 其 `sourceUrl/sourceType/asOf/evidenceKind/confidence` 覆盖层级同名字段，成为该解析值的最终溯源。
   * 缺省 undefined = 该层沿用旧行为（只有层级 `source` 自由文本，无结构化链接）。
   */
  sources?: Record<string, ValueSourceMeta>;
  /** 该层来源描述（如省份名 / 政策文件名）。 */
  source?: string;
  confidence?: number;
  /** 生效起点（含）。 */
  effectiveFrom?: Date;
  /** 生效终点（含）；< now 视为过期，政策值不得当现行默认（§6）。 */
  effectiveUntil?: Date;
  /** 该层的证据标签（默认 ASSUMPTION）。 */
  evidenceKind?: EvidenceType;
  /** 该层的允许区间覆盖（如某省对电价覆写限幅更严）。 */
  bounds?: Record<string, { min?: number; max?: number }>;
}

/** 派生值函数：读已解析的基础值快照 → 返回该键的计算结果（纯函数，注册表注入，绝不 eval 字符串）。 */
export type DerivedFn = (
  resolved: Readonly<Record<string, number>>,
) => number | undefined;

/** 解析入参：一次解析所需的各层 + 当前时间（时间显式注入，无时钟→可测）+ 派生注册表。 */
export interface ResolveLayers {
  /** 地区默认（可空）。 */
  region?: ValueLayer;
  /** 政策默认列表（可空；按给定顺序后者覆盖前者，但都要过有效期）。 */
  policy?: ValueLayer[];
  /** 用户覆写（可空）。 */
  user?: ValueLayer;
  /** 派生计算注册表（可空）：key → 纯函数。 */
  derived?: Record<string, DerivedFn>;
  /** 判"过期"的当前时间（显式注入以便离线测死）。 */
  now?: Date;
}

/* ─────────────────────────── 解析结果（ResolvedParameter） ─────────────────────────── */

export interface ResolvedParameter {
  key: string;
  group: ParamGroup;
  exposure: ExposureTier;
  kind: ParamKind;
  unit?: string;
  /** 最终生效值。 */
  value: number | boolean | string;
  /** 该值来自哪一层。 */
  origin: ValueOrigin;
  /** 来源描述（透传命中层的 source，否则 spec.source）。 */
  source: string;
  /** 置信度（透传命中层的 confidence，否则 spec.confidence）。 */
  confidence: number;
  /** 认识论标签（透传命中层 evidenceKind，否则 spec.evidenceKind）。 */
  evidenceKind: EvidenceType;
  /**
   * R8.7：命中层为该键提供的**可核验来源链接**（仅当 `sources[key].sourceUrl` 是合法 http(s) 才落此处）。
   * 缺省 undefined = 该值无结构化来源（沿用旧行为，或 FACT 声称因缺链接已被降级）。
   */
  sourceUrl?: string;
  /** R8.7：来源类型标签（政府公告 / 统计年鉴 / 行业媒体 / 企业披露…），供报告分类展示。 */
  sourceType?: string;
  /** R8.7：数据时点（"as of"），区分现价 / 历史价。 */
  asOf?: string;
  /** 是否可编辑（来自 spec）。 */
  editable: boolean;
  /** 是否相对 spec.defaultValue 被覆写过。 */
  overridden: boolean;
  /** 用户/地区覆写是否因越界被裁剪（true 时 value 已落在边界上）。 */
  clamped: boolean;
  /** 有效允许下界（spec 与命中层 bounds 合成的结果，供 UI 画滑杆）。 */
  allowedMin?: number;
  allowedMax?: number;
  /** 非致命告警（如"政策已过期被跳过""对不可编辑参数尝试覆写被忽略""派生依赖缺失回落默认"）。 */
  notes: string[];
}

export interface ResolveResult {
  ok: boolean;
  engineVersion: string;
  /** 键 → 解析结果（保序，按传入 specs 顺序）。 */
  params: Record<string, ResolvedParameter>;
  /** 供计算引擎直接消费的"仅数值"快照（派生/解析后的最终值，非数值参数忽略）。 */
  numeric: Record<string, number>;
  /** 致命错误（如 spec 集不合法 / 派生环）。非致命问题在各 param.notes。 */
  issues: string[];
}

function num(v: number | boolean | string): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function clampToBounds(
  v: number,
  min: number | undefined,
  max: number | undefined,
): { value: number; clamped: boolean } {
  let out = v;
  let clamped = false;
  if (min != null && out < min) {
    out = min;
    clamped = true;
  }
  if (max != null && out > max) {
    out = max;
    clamped = true;
  }
  return { value: out, clamped };
}

/** 合成允许区间：spec 的 [min,max] 与命中层 bounds 取交集（更严者胜）。 */
function effectiveBounds(
  spec: ParameterSpec,
  layer?: ValueLayer,
): { min?: number; max?: number } {
  const b = layer?.bounds?.[spec.key];
  const mins = [spec.min, b?.min].filter((x): x is number => x != null);
  const maxs = [spec.max, b?.max].filter((x): x is number => x != null);
  return {
    min: mins.length ? Math.max(...mins) : undefined,
    max: maxs.length ? Math.min(...maxs) : undefined,
  };
}

/** 一层是否此刻有效（政策/地区窗口）。 */
function layerActive(layer: ValueLayer, now: Date): boolean {
  if (layer.effectiveFrom && now < layer.effectiveFrom) return false;
  if (layer.effectiveUntil && now > layer.effectiveUntil) return false;
  return true;
}

function isExpired(layer: ValueLayer, now: Date): boolean {
  return layer.effectiveUntil != null && now > layer.effectiveUntil;
}

/**
 * R8.7 诚实闸门的判据：一个 `sourceUrl` 只有是 http(s) 开头、去空白后非空、不含空格时才算「可核验来源」。
 * 宁可误拒不可误收——脏输入回 undefined，令依赖它的 FACT 声称被降级（§20 绝不把无来源的数字当事实）。
 */
function usableHttpUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const t = url.trim();
  if (t === "" || /\s/.test(t)) return undefined;
  return /^https?:\/\//i.test(t) ? t : undefined;
}

/* ─────────────────────────── 核心解析 ─────────────────────────── */

/**
 * 解析一组参数定义 → 每个参数的最终值 + 来源/置信度/覆写信息。
 * 纯函数、可复算：同 (specs, layers, now, derived) 必得同结果。非法 spec 集 → ok:false 且不产出脏值。
 */
export function resolveParameters(
  specsRaw: unknown,
  layers: ResolveLayers = {},
): ResolveResult {
  const parsed = ParameterSetSchema.safeParse(specsRaw);
  if (!parsed.success) {
    return {
      ok: false,
      engineVersion: PARAM_ENGINE_VERSION,
      params: {},
      numeric: {},
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "_"}: ${i.message}`),
    };
  }
  const specs = parsed.data as ParameterSpec[];
  const now = layers.now ?? new Date(0); // 无注入时间时用极早时间（政策默认视为有效，除非明确窗口）
  const params: Record<string, ResolvedParameter> = {};
  const order: string[] = [];

  for (const spec of specs) {
    const notes: string[] = [];
    // 默认值兜底
    let value: number | boolean | string = spec.defaultValue;
    let origin: ValueOrigin = "default";
    let winningLayer: ValueLayer | undefined; // 提供最终值的覆写层（region/policy/user），default 时为 undefined
    let source = spec.source;
    let confidence = spec.confidence;
    let evidenceKind = spec.evidenceKind;
    let clamped = false;

    // 依次叠加 region → policy（有效者）→ user，后层覆盖前层；派生在最后。
    const applyLayer = (
      layer: ValueLayer | undefined,
      originTag: ValueOrigin,
      canClamp: boolean,
    ): void => {
      if (!layer || !(spec.key in layer.values)) return;
      winningLayer = layer;
      const raw = layer.values[spec.key];
      if (typeof raw === "number") {
        let v = raw;
        if (canClamp) {
          const cb = effectiveBounds(spec, layer);
          const c = clampToBounds(v, cb.min, cb.max);
          v = c.value;
          if (c.clamped) {
            clamped = true;
            notes.push(
              `${spec.key}: ${originTag} 覆写被裁剪到允许区间 [${cb.min ?? "-∞"}, ${cb.max ?? "+∞"}]`,
            );
          }
        }
        value = v;
      } else {
        value = raw;
      }
      origin = originTag;
      if (layer.source) source = layer.source;
      if (typeof layer.confidence === "number") confidence = layer.confidence;
      if (layer.evidenceKind) evidenceKind = layer.evidenceKind;
    };

    // region
    if (layers.region && layerActive(layers.region, now)) {
      applyLayer(layers.region, "region", true);
    } else if (layers.region && isExpired(layers.region, now) && spec.key in layers.region.values) {
      notes.push(`${spec.key}: 地区层已过期，忽略其覆写`);
    }

    // policy（按数组顺序叠加，过期项跳过并留痕）
    if (layers.policy) {
      for (const pl of layers.policy) {
        if (!(spec.key in pl.values)) continue;
        if (!layerActive(pl, now)) {
          if (isExpired(pl, now)) {
            notes.push(`${spec.key}: 政策「${pl.source ?? "?"}」已过期（生效至 ${pl.effectiveUntil?.toISOString?.() ?? "?"}），不作现行默认`);
          }
          continue;
        }
        applyLayer(pl, "policy", true);
      }
    }

    // user（仅对 editable 参数生效；不可编辑则忽略并留痕）
    if (layers.user && spec.key in layers.user.values) {
      if (spec.editable) {
        applyLayer(layers.user, "user", true);
      } else {
        notes.push(`${spec.key}: 参数不可编辑，用户覆写被忽略`);
      }
    }

    const overridden = origin !== "default";
    const bFinal = effectiveBounds(spec, winningLayer);

    // ── R8.7：解析命中层的**逐值结构化溯源** + 诚实闸门 ──
    // 仅对显式挂了 sources[key] 的键生效；未挂则沿用上面层级结果（向后兼容，不改 legacy 行为）。
    let effEvidenceKind = evidenceKind;
    let effConfidence = confidence;
    let sourceUrl: string | undefined;
    let sourceType: string | undefined;
    let asOf: string | undefined;
    const meta = winningLayer?.sources?.[spec.key];
    if (meta) {
      if (typeof meta.confidence === "number") effConfidence = meta.confidence;
      if (meta.evidenceKind) effEvidenceKind = meta.evidenceKind;
      const url = usableHttpUrl(meta.sourceUrl);
      if (url) {
        sourceUrl = url;
        sourceType = meta.sourceType;
        asOf = meta.asOf;
      } else if (typeof meta.sourceUrl === "string" && meta.sourceUrl.trim() !== "") {
        notes.push(`${spec.key}: 来源链接非 http(s) 或含空格，不作可核验来源`);
      }
      // 诚实闸门：逐值声称 FACT 却无可用链接 → 降级 ASSUMPTION（§20 绝不把无来源的数字当事实外泄）。
      if (effEvidenceKind === "FACT" && !sourceUrl) {
        effEvidenceKind = "ASSUMPTION";
        notes.push(`${spec.key}: 声称 FACT 但缺可核验 http(s) 来源链接，已诚实降级为 ASSUMPTION`);
      }
    }

    params[spec.key] = {
      key: spec.key,
      group: spec.group,
      exposure: spec.exposure,
      kind: spec.kind,
      unit: spec.unit,
      value,
      origin,
      source,
      confidence: effConfidence,
      evidenceKind: effEvidenceKind,
      sourceUrl,
      sourceType,
      asOf,
      editable: spec.editable,
      overridden,
      clamped,
      allowedMin: spec.min ?? bFinal.min,
      allowedMax: spec.max ?? bFinal.max,
      notes,
    };
    order.push(spec.key);
  }

  // ── 派生参数：在所有非派生值解析完后求值；环/缺依赖诚实降级，不裸抛 ──
  const derivedMap = layers.derived ?? {};
  const numericSnapshot = (): Record<string, number> => {
    const snap: Record<string, number> = {};
    for (const k of order) {
      // 仅收数值参数：布尔/选择的 value 可能恰好存成数字（如默认 1），但语义上不属于计算快照。
      if (params[k].kind !== "numeric") continue;
      const n = num(params[k].value);
      if (n != null) snap[k] = n;
    }
    return snap;
  };

  let progressed = true;
  let guard = 0;
  const maxPass = order.length + 1;
  while (progressed && guard < maxPass) {
    progressed = false;
    guard++;
    for (const spec of specs) {
      if (!spec.derived) continue;
      const rp = params[spec.key];
      if (rp.origin === "derived") continue; // 已算
      const fn = derivedMap[spec.key];
      if (!fn) {
        rp.notes.push(`${spec.key}: 声明为派生但缺计算函数，保留占位默认`);
        rp.origin = "default";
        continue;
      }
      const deps = spec.dependsOn ?? [];
      const snap = numericSnapshot();
      const missing = deps.filter((d) => !(d in snap));
      if (missing.length) {
        // 依赖尚未就绪：本轮跳过，下一轮再试（拓扑式迭代）
        continue;
      }
      const out = fn(snap);
      if (out == null || !Number.isFinite(out)) {
        rp.notes.push(`${spec.key}: 派生计算返回非有限值，回落默认`);
        continue;
      }
      rp.value = out;
      rp.origin = "derived";
      rp.overridden = true;
      rp.source = spec.source || "派生计算";
      progressed = true;
    }
  }
  // 未完成的派生（环或永久缺依赖）诚实标注，绝不假装已算
  for (const spec of specs) {
    if (spec.derived && params[spec.key].origin !== "derived") {
      params[spec.key].notes.push(`${spec.key}: 派生未完成（依赖环或缺依赖），值为占位默认，勿作结论依据`);
    }
  }

  const numeric = numericSnapshot();

  return {
    ok: true,
    engineVersion: PARAM_ENGINE_VERSION,
    params,
    numeric,
    issues: [],
  };
}

/** 便捷：取某参数的解析值（缺失返回 undefined）。 */
export function getValue(
  result: ResolveResult,
  key: string,
): number | boolean | string | undefined {
  return result.params[key]?.value;
}

/** 便捷：按暴露层级过滤（UI 渲染滑杆分组用）。 */
export function filterByExposure(
  result: ResolveResult,
  tier: ExposureTier,
): ResolvedParameter[] {
  return Object.values(result.params).filter((p) => p.exposure === tier);
}

/** 便捷：汇总所有非致命告警（诊断面板 / 报告"数据质量提示"用）。 */
export function collectNotes(result: ResolveResult): string[] {
  const out: string[] = [];
  for (const p of Object.values(result.params)) {
    if (p.notes.length) out.push(...p.notes);
  }
  return out;
}

/** 解析结果 Zod schema（供 R3 持久化 / 跨边界传输时校验，防结构漂移，第 16 条）。 */
export const ResolvedParameterSchema = z.object({
  key: z.string(),
  group: ParamGroupSchema,
  exposure: ExposureTierSchema,
  kind: ParamKindSchema,
  unit: z.string().optional(),
  value: z.union([z.number(), z.boolean(), z.string()]),
  origin: ValueOriginSchema,
  source: z.string(),
  confidence: z.number().int().min(0).max(100),
  evidenceKind: EvidenceTypeSchema,
  sourceUrl: z.string().optional(),
  sourceType: z.string().optional(),
  asOf: z.string().optional(),
  editable: z.boolean(),
  overridden: z.boolean(),
  clamped: z.boolean(),
  allowedMin: z.number().optional(),
  allowedMax: z.number().optional(),
  notes: z.array(z.string()),
});

/* ─────────────────────────── R8.7：输入溯源汇总（喂计算/方案层，§4/§12） ─────────────────────────── */

/**
 * 单个入参的溯源摘要（把解析层的逐值来源结构化搬运给下游，供 `CalcResult` / 方案草案 / 报告消费）。
 * 只含展示与可追溯所需字段，不回带引擎内部结构，避免跨边界耦合漂移（§16 单一真源）。
 */
export interface InputProvenance {
  key: string;
  group: ParamGroup;
  value: number | boolean | string;
  origin: ValueOrigin;
  source: string;
  confidence: number;
  evidenceKind: EvidenceType;
  /** 仅当命中层挂了合法 http(s) 逐值来源时非空（R8.7）。 */
  sourceUrl?: string;
  sourceType?: string;
  asOf?: string;
}

/**
 * 把一次解析结果收敛成「键 → 溯源摘要」的扁平表（纯函数、无副作用、可离线测死）。
 * R8.7「真实数据接入」的对内接缝：`runSandboxModel` 过去只取 `resolved.numeric` 丢弃了溯源，
 * 本函数把被丢弃的逐值来源重新暴露出来，供方案草案 `sourceUrl` / 报告「数据来源」/ R8.5 升级写路径使用。
 * 非法解析（ok:false）→ 空表（诚实「无从汇总」，不抛）。
 */
export function collectInputProvenance(result: ResolveResult): Record<string, InputProvenance> {
  const out: Record<string, InputProvenance> = {};
  if (!result.ok) return out;
  for (const p of Object.values(result.params)) {
    const ip: InputProvenance = {
      key: p.key,
      group: p.group,
      value: p.value,
      origin: p.origin,
      source: p.source,
      confidence: p.confidence,
      evidenceKind: p.evidenceKind,
    };
    if (p.sourceUrl) ip.sourceUrl = p.sourceUrl;
    if (p.sourceType) ip.sourceType = p.sourceType;
    if (p.asOf) ip.asOf = p.asOf;
    out[p.key] = ip;
  }
  return out;
}

/** 便捷：从溯源表里挑出「有可核验来源链接」的那批（即 R8.7 意义下真正落地的 FACT 输入）。 */
export function factInputs(provenance: Record<string, InputProvenance>): InputProvenance[] {
  return Object.values(provenance).filter((p) => p.evidenceKind === "FACT" && !!p.sourceUrl);
}
