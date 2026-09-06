/**
 * 沙盘「已保存情景 ↔ 产业方案」的**服务端来源关联编排**（中途重构 R8.6 · 「反查关联」拼图的服务端那一半）。
 *
 * 职责（与 client-safe 的 `src/lib/sandbox-solution-source.ts` 配对）：
 *   - `verifySandboxSource`：导出落库前，**查库确认**指针指向的情景 / 项目**确有其行**（并对「情景↔项目」一致性
 *     做交叉核验）。查不到 / 不一致 → 诚实丢指针并给出可读 `note`，**绝不把一条指向不存在情景的假关联写进方案**
 *     （对齐 `sandbox-store` 对 `regionId` 外键的「确有其行才落、否则诚实置空」同一哲学，§20 不粉饰）。
 *   - `findSolutionsBySandboxSource`：反查——给定 scenarioId 或 projectId，找回「由它导出、且带来源指针」的产业方案
 *     精简清单（只读 JSONB 指针、绝不重算、绝不外泄财务大对象）。这是「某沙盘项目 → 它导出过哪些方案」的兑现。
 *
 * 命脉与边界（§7/§8/§16）：
 *   - 本层**不做任何经济计算**，只在 JSONB 上读/校验指针；正向读回由 client-safe `readSandboxSourceFromFinancials`
 *     完成，反查也复用同一套键名常量与归一，杜绝「写一套读一套」漂移（§16 单一真源）。
 *   - **零 schema 迁移**：来源指针落在既有 `SolutionFinancial.assumptions` JSONB，反查用 Prisma 的 JSON `path` 过滤，
 *     不新增列 / 表 / 索引（V1 数据量下顺序过滤可接受；如日后成为热点再专项加 GIN 索引，见 ROADMAP）。
 *   - **权限在调用方（路由）把关**：本层不含鉴权，只认调用方已过 staff 门禁（反查暴露的是方案标题/状态等内部治理
 *     信息，故整条 R8.6 反查只走 staff-gated 端点、零公开暴露）。server 域逻辑，直接 import prisma/logger；
 *     本仓刻意不 import "server-only"（vitest/node 会抛错），仅注释标注。
 */
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  SANDBOX_SOURCE_FIELD,
  normalizeSandboxSource,
  readSandboxSourceFromFinancials,
  type SandboxSourceInput,
  type SandboxSourceRef,
} from "@/lib/sandbox-solution-source";

const log = logger.child({ module: "server/sandbox-solution-source" });

/** 服务端来源关联编排版本（校验口径 / 反查契约变化须升版记因，宪法第 13 条）。 */
export const SANDBOX_SOLUTION_SOURCE_STORE_VERSION = "1.0.0";

/* ─────────────────────────── 写侧：落库前的存在性核验（诚实丢假指针） ─────────────────────────── */

export interface VerifiedSandboxSource {
  /** 归一 + 验存后的可信指针；`null` 表示「无有效来源」——调用方应**不落指针**（绝不虚构）。 */
  ref: SandboxSourceRef | null;
  /** 是否通过核验（false 时 ref 必为 null，`note` 给出诚实原因，供 UI / warnings 透出）。 */
  ok: boolean;
  /** 未通过时的可读原因（供 persist 层并入 warnings，让人知道「这次导出没挂上来源关联」）。 */
  note?: string;
}

/**
 * 校验一个来源指针：形状合法（client-safe `normalizeSandboxSource`）→ 再查库确有其行、且情景↔项目一致。
 *   - 无任何有效 id（都缺 / 都脏） → `{ ok:false, ref:null }`（本就无来源，静默，note 说明）；
 *   - scenarioId 指向的情景不存在 → 丢指针 + note「情景不存在」；
 *   - projectId 指向的项目不存在 → 丢指针 + note「项目不存在」；
 *   - 二者都给但情景的实际 projectId 与给定 projectId 不符 → 丢指针 + note「情景与项目不一致」（防错挂）。
 * 纯核验、无副作用；DB 读异常 → 保守丢指针（ok:false，note「核验失败」），绝不因指针核验失败而阻断整笔导出。
 */
export async function verifySandboxSource(input: SandboxSourceInput | null | undefined): Promise<VerifiedSandboxSource> {
  const ref = normalizeSandboxSource(input);
  if (!ref) {
    return { ok: false, ref: null, note: "未提供有效的沙盘情景 / 项目 id，本次导出不挂来源关联" };
  }
  try {
    if (ref.scenarioId) {
      const sc = await prisma.projectScenario.findUnique({
        where: { id: ref.scenarioId },
        select: { id: true, projectId: true },
      });
      if (!sc) return { ok: false, ref: null, note: `来源情景不存在（${ref.scenarioId.slice(0, 8)}…），已省略来源关联` };
      if (ref.projectId && sc.projectId !== ref.projectId) {
        return { ok: false, ref: null, note: "来源情景与项目不一致，已省略来源关联（防止错挂到别的项目）" };
      }
      return { ok: true, ref };
    }
    // 仅有 projectId（无情景 id）：确认项目存在即可。
    const project = await prisma.project.findUnique({ where: { id: ref.projectId }, select: { id: true } });
    if (!project) return { ok: false, ref: null, note: `来源项目不存在（${(ref.projectId ?? "").slice(0, 8)}…），已省略来源关联` };
    return { ok: true, ref };
  } catch (e) {
    log.warn("verifySandboxSource DB read failed; dropping pointer honestly", { err: String(e) });
    return { ok: false, ref: null, note: "来源关联核验失败，已省略（不影响方案本身落库）" };
  }
}

/* ─────────────────────────── 读侧：反查「某情景 / 项目 → 它导出的方案」 ─────────────────────────── */

/** 反查命中的方案精简视图（只够导航与识别，绝不带财务明细 / 正文大对象）。 */
export interface SandboxSourceSolutionRow {
  id: string;
  title: string;
  slug: string;
  status: string;
  updatedAt: string;
  /** 该方案记录的回指来源指针（正常应与查询条件吻合；脏值经 client-safe 读法降 null）。 */
  source: SandboxSourceRef | null;
}

export type FindSolutionsBySandboxSourceResult =
  | { status: "ok"; items: SandboxSourceSolutionRow[]; count: number }
  | { status: "invalid"; fieldErrors: Record<string, string[]> }
  | { status: "error"; error: string };

/**
 * 反查：按 scenarioId 和 / 或 projectId 找回带来源指针的产业方案（按 updatedAt 倒序、去重到方案级）。
 *   - 两个 id 都没给 / 都非合法 cuid → `invalid`（早退、不触库；调用方据此回 400）；
 *   - 命中集合按方案去重（一方案多条财务只会各命中一次，取首条指针为准）；
 *   - DB 异常 → `error`（不裸抛）。
 * 只读 `SolutionFinancial.assumptions` 的 JSONB 指针，不重算、不外泄财务明细。
 */
export async function findSolutionsBySandboxSource(
  input: SandboxSourceInput | null | undefined,
): Promise<FindSolutionsBySandboxSourceResult> {
  const ref = normalizeSandboxSource(input);
  if (!ref) {
    return { status: "invalid", fieldErrors: { sandboxSource: ["须提供合法的 scenarioId 或 projectId（cuid）"] } };
  }

  // JSONB path 过滤：Prisma 的 `JsonNullableFilter` 不支在单个 JSON 字段里再嵌 `AND` 多条件，故用**最细粒度键**
  //   （有 scenarioId 就按 scenarioId，否则按 projectId）单路命中，另一维靠回读指针在 JS 侧做后置精校——
  //   既绕开类型限制，又保证「两 id 都给时二者都吻合」。
  const idKey = ref.scenarioId ? "scenarioId" : "projectId";
  const idVal = (ref.scenarioId ?? ref.projectId) as string;

  try {
    const fins = await prisma.solutionFinancial.findMany({
      where: { assumptions: { path: [SANDBOX_SOURCE_FIELD, idKey], equals: idVal } },
      select: { solutionId: true, assumptions: true },
    });
    if (fins.length === 0) return { status: "ok", items: [], count: 0 };

    // 去重到方案级，保留每方案首次出现时的指针（用 client-safe 读法回读，脏值降 null）；
    // 两 id 都给时按回读指针做后置精校（scenarioId 命中已保证同源，这里再核 projectId 一致）。
    const bySolution = new Map<string, unknown>();
    for (const f of fins) {
      if (!bySolution.has(f.solutionId)) bySolution.set(f.solutionId, f.assumptions);
    }
    const solutionIds = [...bySolution.keys()];
    const solutions = await prisma.solution.findMany({
      where: { id: { in: solutionIds } },
      select: { id: true, title: true, slug: true, status: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });

    const items: SandboxSourceSolutionRow[] = [];
    for (const s of solutions) {
      const assumed = bySolution.get(s.id);
      // 与正向读、写侧同一份纯读法（单条财务包成一条数组，首条命中语义天然一致），杜绝读逻辑漂移。
      const read = readSandboxSourceFromFinancials([{ assumptions: assumed }]);
      if (read === null) continue; // 脏指针：查库命中但回读不合法 → 诚实剔除
      if (ref.scenarioId && read.scenarioId !== ref.scenarioId) continue;
      if (ref.projectId && read.projectId !== ref.projectId) continue;
      items.push({
        id: s.id,
        title: s.title,
        slug: s.slug,
        status: s.status,
        updatedAt: s.updatedAt.toISOString(),
        source: read,
      });
    }
    return { status: "ok", items, count: items.length };
  } catch (e) {
    log.error("findSolutionsBySandboxSource failed", { err: String(e) });
    return { status: "error", error: "反查来源方案失败" };
  }
}
