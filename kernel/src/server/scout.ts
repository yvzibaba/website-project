import { z } from "zod";
import {
  LicenseTypeSchema,
  LicenseReviewStatusSchema,
  type LicenseType,
  type LicenseReviewStatus,
} from "@/lib/validation";

/**
 * GitHub Scout 治理逻辑（Phase 10 M1，纯函数 · **无 DB 依赖** · server 域逻辑）。
 *
 * 为什么存在（宪法第 11 条「GitHub = 能力供应链，不是成品」+「禁止 发现 → 复制 → 包装 → 出售」
 *   +「须 需求定义 → 能力匹配 → 筛选 → 许可证检查 → 依赖检查 → 安全检查 → 实测 → 二次封装；
 *   许可证未知 / GPL / AGPL / 含商业限制 → 人工复核」）：商业闭环里「GitHub / 开源匹配 → 中国本土化
 *   重构」这一环，风险最高的不是"找不到仓库"，而是"把带传染性许可证 / 有漏洞 / 从实测不通的开源项目
 *   直接包装成对外售卖的产业方案"——这是法律与工程安全的高危区（宪法「高风险领域须标注需要专业人工确认」）。
 *   本模块把这条**法务 + 工程准入门**立成可复算的契约：分类许可证、判定复核归属、聚合复用就绪度、
 *   生成去重键，让上层 Scout（真实抓 GitHub API）无论接什么数据源，都走同一套准入标准，避免"各写各的
 *   筛选规则"造成合规漂移（第 16 条单一真源）。
 *
 * M1 的刻意边界（宪法「V1 只做核心闭环、能简单就简单、禁止提前把系统做复杂」）：
 *   - **只做治理判定、不做真实抓取 / 匹配打分**：GitHub API 拉取、依赖 / 安全 / 实测的**执行**分别
 *     阻塞在外部工具链，且能力匹配度（`fitScore`）属于"实测后才填"的数据，M1 不投机定义匹配算法。
 *     M1 只回答一个可离线判定的问题：**给定一个候选开源项目的元数据，它离"可进入二次封装"还差哪些门？**
 *   - **零 schema / 零新表**：`OpenSourceProject` 表早已具备 `licenseType / licenseReviewStatus /
 *     dependencyChecked / securityChecked / tested`（见 prisma/schema.prisma 第 11 条建模），M1 直接
 *     复用这些字段，不新建任何表。
 *   - **自动层只分类、不越权批准（v1 保守假设，宪法「AI 做大量劳动、人做关键决策」+ 法律=高风险须人工确认）**：
 *     未经人工复核（`NOT_REVIEWED`）的许可证**永不自动判 approved**，只会连同风险分级理由进
 *     `needs_human_review`；只有人显式置 `APPROVED / REJECTED` 才尊重其裁决。这样"能不能用某开源项目"
 *     这个法律责任始终落在人身上。
 *   - **许可证分类映射是 v1 设计假设**（非法律意见）：宽松 / 弱传染 / 强传染的分档是业界常见归类，
 *     真实合规判定以人工复核为准；改分类 / 改判定矩阵 / 改返回结构须升 `SCOUT_VERSION` 并记录原因（第 13 条）。
 *   - 无 HTTP 端点、无 UI、无 Next 运行时依赖（纯函数 + 判别联合 + Zod，与 `scoring.ts`/`model-router.ts`/
 *     `research-pipeline.ts` 同构）。
 */

/* ─────────────────────────── 版本 & 许可证分类（v1 假设，第 11/13 条） ─────────────────────────── */

/** Scout 治理契约版本（改分类映射 / 判定矩阵 / 返回结构须升版本并记录原因，支持回滚）。 */
export const SCOUT_VERSION = "1.0.0";

/** 许可证合规风险分档（本项目 v1 归类，非法律意见；真实判定以人工复核为准）。 */
export const LICENSE_CATEGORIES = [
  "permissive", // 宽松：MIT / Apache-2.0 / BSD，商用友好
  "weak_copyleft", // 弱传染：MPL-2.0 / LGPL，文件级 / 库级传染，谨慎
  "strong_copyleft", // 强传染：GPL / AGPL，衍生品须同许可证开源 → 强制人工复核
  "proprietary", // 专有 / 商业限制 → 强制人工复核
  "unknown", // 未知 / OTHER → 强制人工复核
] as const;
export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number];

/**
 * `LicenseType` → 风险分档映射（**v1 设计假设**）。逐字对齐 `LicenseTypeSchema` 的 11 个成员，
 * 任一新增许可证类型若不进此表，`licenseCategory` 会保守回落 `unknown`（触发人工复核，绝不静默放行）。
 */
export const LICENSE_CATEGORY_BY_TYPE: Record<LicenseType, LicenseCategory> = {
  MIT: "permissive",
  APACHE_2_0: "permissive",
  BSD_2_CLAUSE: "permissive",
  BSD_3_CLAUSE: "permissive",
  MPL_2_0: "weak_copyleft",
  LGPL: "weak_copyleft",
  GPL: "strong_copyleft",
  AGPL: "strong_copyleft",
  PROPRIETARY: "proprietary",
  UNKNOWN: "unknown",
  OTHER: "unknown",
};

/** 取某许可证类型的风险分档；未知值一律保守归 `unknown`（须人工复核）。 */
export function licenseCategory(licenseType: LicenseType): LicenseCategory {
  return LICENSE_CATEGORY_BY_TYPE[licenseType] ?? "unknown";
}

/* ─────────────────────────── 许可证准入判定（第 11 条法务门，纯函数） ─────────────────────────── */

/** 判定入参：一个开源项目的许可证元数据。 */
export interface LicenseDecisionInput {
  licenseType: LicenseType;
  licenseReviewStatus: LicenseReviewStatus;
}

export type LicenseVerdict = "approved" | "needs_human_review" | "rejected";

/** 许可证准入判定结果：裁决 + 风险分档 + 人类可读理由（可多条）。 */
export interface LicenseDecision {
  verdict: LicenseVerdict;
  category: LicenseCategory;
  reasons: string[];
}

/**
 * 就许可证做准入判定。**自动层只分类、不越权批准**（见文件头 v1 保守假设）：
 *   - 人工已置 `REJECTED` → `rejected`（尊重人的否决）。
 *   - 人工已置 `APPROVED` → `approved`（尊重人的许可，哪怕是强传染——人已看过）。
 *   - 人工已置 `NEEDS_HUMAN_REVIEW` → `needs_human_review`。
 *   - `NOT_REVIEWED`（自动层默认）→ 一律 `needs_human_review`，并按风险分档给出更强理由：
 *       strong_copyleft / proprietary / unknown 属宪法明列「许可证未知 / GPL / AGPL / 含商业限制 → 人工复核」
 *       高危项；permissive / weak_copyleft 虽商用友好，但自动检测可能出错且法律门须人工确认，仍暂缓放行。
 */
export function decideLicense(input: LicenseDecisionInput): LicenseDecision {
  const category = licenseCategory(input.licenseType);
  const reasons: string[] = [];

  if (input.licenseReviewStatus === "REJECTED") {
    reasons.push("许可证已被人工判定为不可用（REJECTED）");
    return { verdict: "rejected", category, reasons };
  }
  if (input.licenseReviewStatus === "APPROVED") {
    reasons.push("许可证已获人工复核批准（APPROVED）");
    return { verdict: "approved", category, reasons };
  }
  if (input.licenseReviewStatus === "NEEDS_HUMAN_REVIEW") {
    reasons.push("许可证已被标记为需人工复核（NEEDS_HUMAN_REVIEW）");
    return { verdict: "needs_human_review", category, reasons };
  }

  // NOT_REVIEWED：自动层永不放行，按风险分档补强理由后进人工队列。
  reasons.push("尚未经人工复核，自动层不越权批准法律门");
  if (category === "strong_copyleft") {
    reasons.push("强传染许可证（GPL / AGPL）：宪法第 11 条明列必须人工复核");
  } else if (category === "proprietary") {
    reasons.push("专有 / 含商业限制许可证：宪法第 11 条明列必须人工复核");
  } else if (category === "unknown") {
    reasons.push("许可证未知或为 OTHER：无法判定传染性，宪法第 11 条要求人工复核");
  } else if (category === "weak_copyleft") {
    reasons.push("弱传染许可证（MPL / LGPL）：文件 / 库级传染需人工确认封装方式");
  } else {
    reasons.push("宽松许可证：商用友好，仍须人工确认自动检测结果无误");
  }
  return { verdict: "needs_human_review", category, reasons };
}

/* ─────────────────────────── 复用就绪度聚合（第 11 条完整准入门） ─────────────────────────── */

/** 就绪度入参：一个开源项目的许可证 + 依赖 / 安全 / 实测检查位。 */
export interface ReadinessInput {
  licenseType: LicenseType;
  licenseReviewStatus: LicenseReviewStatus;
  dependencyChecked: boolean;
  securityChecked: boolean;
  tested: boolean;
}

/** 复用就绪度：阻断项列表（空即就绪）+ 布尔便捷位 + 内嵌许可证判定。 */
export interface Readiness {
  blockers: string[];
  readyForReuse: boolean;
  license: LicenseDecision;
}

/**
 * 把「许可证门 + 依赖检查 + 安全检查 + 实测」聚合成"能否进入二次封装"的就绪度判定。
 * 任一未满足即计入 `blockers`；`readyForReuse` 仅在 blockers 为空时为真。
 * 因 `decideLicense` 对未复核项目永不判 approved，**强传染 / 专有 / 未知许可证即便三个检查位都为真
 * 也不会自动就绪**——必须先进人工复核（呼应「禁止 发现 → 复制 → 包装 → 出售」）。
 */
export function projectReadiness(input: ReadinessInput): Readiness {
  const license = decideLicense(input);
  const blockers: string[] = [];

  if (license.verdict === "rejected") {
    blockers.push(`许可证被拒：${license.reasons.join("；")}`);
  } else if (license.verdict === "needs_human_review") {
    blockers.push(`许可证待人工复核：${license.reasons.join("；")}`);
  }
  if (!input.dependencyChecked) {
    blockers.push("依赖检查未完成（宪法第 11 条：须检查依赖）");
  }
  if (!input.securityChecked) {
    blockers.push("安全检查未完成（宪法第 11 条：须做安全检查）");
  }
  if (!input.tested) {
    blockers.push("实测未完成（宪法第 11 条：能力须实测方能二次封装）");
  }

  return { blockers, readyForReuse: blockers.length === 0, license };
}

/* ─────────────────────────── 仓库 URL 去重键（确定性，§16） ─────────────────────────── */

/**
 * 把一个仓库 URL 归一成稳定的去重键：小写、剥协议 / www / 查询串 / 片段 / 结尾 `.git` / 结尾斜杠。
 * 目的：`https://GitHub.com/Owner/Repo.git/` 与 `http://www.github.com/owner/repo` 应视为同一仓库。
 * GitHub owner/repo 大小写不敏感，故整体小写；host 保留（可能来自 gitlab / gitee 等）。纯函数、无时钟、无随机。
 */
export function normalizeRepoUrl(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // 剥协议（http / https / git / ssh 等）
  s = s.replace(/[?#].*$/, ""); // 剥查询串 / 片段
  s = s.replace(/^www\./, ""); // 剥 www
  s = s.replace(/\/+$/, ""); // 剥结尾斜杠
  s = s.replace(/\.git$/, ""); // 剥结尾 .git
  s = s.replace(/\/+$/, ""); // .git 后可能再留斜杠，再剥一次
  return s;
}

/* ─────────────────────────── 候选入参 Schema & 一站式评估（判别联合） ─────────────────────────── */

/**
 * Scout 候选元数据入参（复用 `@/lib/validation` 的许可证枚举防漂移，第 16 条）。
 * 缺省即最保守：许可证 `UNKNOWN` + 未复核 + 三检查位 false，逼上层显式声明已做检查。
 */
export const ScoutCandidateSchema = z.object({
  name: z.string().trim().min(1, "name 不能为空").max(200, "name 过长"),
  repoUrl: z.string().trim().min(1, "repoUrl 不能为空").max(500, "repoUrl 过长"),
  owner: z
    .string()
    .trim()
    .max(100, "owner 过长")
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  stars: z.number().int().min(0).optional(),
  licenseType: LicenseTypeSchema.default("UNKNOWN"),
  licenseReviewStatus: LicenseReviewStatusSchema.default("NOT_REVIEWED"),
  dependencyChecked: z.boolean().default(false),
  securityChecked: z.boolean().default(false),
  tested: z.boolean().default(false),
});
export type ScoutCandidateInput = z.input<typeof ScoutCandidateSchema>;
export type ScoutCandidate = z.infer<typeof ScoutCandidateSchema>;

/** 一站式评估结果（判别联合，`runTask`/`getReviewQueue` 同构，永不裸抛）。 */
export type ScoutEvaluation =
  | {
      status: "invalid";
      issues: z.ZodError["issues"];
    }
  | {
      status: "evaluated";
      candidate: ScoutCandidate;
      dedupKey: string;
      readiness: Readiness;
    };

/**
 * 把一份原始候选元数据：Zod 校验 → 归一去重键 → 复用就绪度判定，返回判别联合。
 * 校验不过 → `status:"invalid"` 带指名 issues（不静默放过，第 20 条诚实）；
 * 校验通过 → `status:"evaluated"`，`candidate` 为归一后带默认值的对象，附 `dedupKey` 与 `readiness`。
 */
export function evaluateCandidate(raw: unknown): ScoutEvaluation {
  const parsed = ScoutCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", issues: parsed.error.issues };
  }
  const candidate = parsed.data;
  return {
    status: "evaluated",
    candidate,
    dedupKey: normalizeRepoUrl(candidate.repoUrl),
    readiness: projectReadiness(candidate),
  };
}
