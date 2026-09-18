import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma, type ChangeAction } from "@prisma/client";
import { CuidSchema } from "@/lib/validation";
import { evaluateCandidate, type ScoutCandidate } from "@/server/scout";
import {
  fetchGitHubRepo,
  mapGitHubRepoToCandidate,
  ScoutFetchError,
  type GithubFetch,
  type GitHubRepoLite,
} from "@/server/scout-github";

/**
 * Scout「抓取 → 治理判定 → 落库」编排（Phase 10 M2，server-only）。
 *
 * 为什么（商业闭环「GitHub/开源匹配 → 中国本土化重构」+ 宪法第 11 条）：
 *   M1 立了离线治理判定、M2 前半（`scout-github.ts`）立了 GitHub 输入管道，但两者还各悬一端——
 *   抓到/给到的候选没有落到可查询的持久层，也没接上人做关键决策的审核面。本模块把它们缝成一条
 *   **最小竖切**：一个仓库标识进来 → 拉公开元数据 → 走既有 `evaluateCandidate` 准入判定（**单一真源，
 *   第 16 条，绝不另抄一套筛选规则**）→ 按去重键 upsert 进 `OpenSourceProject`（表已存在，**零 schema**）
 *   → 每次写落 `ChangeLog` 审计（第 13 条）。落库后的项目带着最保守的 `NOT_REVIEWED` + 三检查位 false，
 *   天然成为"等人复核/等人实测"的待办，为后续接审核队列（M3）铺好数据。
 *
 * 关键治理不变式（写进代码，呼应第 11 条「法律门始终在人身上」）：
 *   - **更新绝不覆盖人工裁决态**：重新抓取同一仓库（如 stars 变了）只刷新客观元数据（name/owner/stars/
 *     licenseType/lastCheckedAt/version++），**绝不动 `licenseReviewStatus` 与 `dependencyChecked/securityChecked/tested`**
 *     ——否则会把人已做的 APPROVED/REJECTED/已实测状态冲掉，等于自动层越权改法律门（严重违规）。
 *     新抓到的原始 SPDX 只进 `licenseNote` 供人对照，不反推动作。
 *   - **不投机填 fitScore / 不假称已扫描**：能力匹配打分与依赖/安全/实测的执行都留待后续（M2 不做）。
 *   - **本模块不做鉴权**：信任调用方（后台路由 / Agent）已过 `requireRole`（沿用 case-admin 口径），
 *     `actor` 仅作审计标注。对外 HTTP 写端点与 UI 有意延后 M3（避免暴露无鉴权公共写端点）。
 *
 * 错误策略：一律判别联合返回（ok/invalid/fetch_error/error），不向调用方抛裸异常（与 case-admin 同构）。
 */

const log = logger.child({ module: "server/scout-ingest" });

/** Scout 编排契约版本（改结果结构 / 落库语义须升版本并记录原因，第 13 条）。 */
export const SCOUT_INGEST_VERSION = "1.0.0";

/* ─────────────────────────── 结果类型（判别联合） ─────────────────────────── */

export interface IngestOk {
  status: "ok";
  id: string;
  /** 本次是新建还是更新了既有仓库（按去重键判定）。 */
  created: boolean;
  /** 落库用的规范化去重键（= 归一后的 repoUrl）。 */
  dedupKey: string;
  candidate: ScoutCandidate;
  /** 复用就绪度（来自既有 `evaluateCandidate` 的判定，未复核项目恒不就绪）。 */
  readyForReuse: boolean;
  blockers: string[];
  licenseVerdict: string;
  /** 版本字段（新建=1；更新后为自增值）。 */
  version: number;
}
export interface IngestInvalid {
  status: "invalid";
  issues: z.ZodError["issues"];
}
export interface IngestFetchError {
  status: "fetch_error";
  httpStatus: number;
  error: string;
}
export interface IngestError {
  status: "error";
  error: string;
}
export type IngestResult = IngestOk | IngestInvalid | IngestFetchError | IngestError;

/* ─────────────────────────── 内部工具 ─────────────────────────── */

function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === null || v === undefined ? (Prisma.DbNull as typeof Prisma.DbNull) : (v as Prisma.InputJsonValue);
}

function changeLogArgs(
  entityId: string,
  action: ChangeAction,
  actor: string | undefined,
  reason: string,
  before: unknown,
  after: unknown,
): Prisma.ChangeLogUncheckedCreateInput {
  return {
    entityType: "OpenSourceProject",
    entityId,
    action,
    changedBy: actor ?? null,
    reason,
    before: jsonOrNull(before),
    after: jsonOrNull(after),
  };
}

function snapshot(row: {
  name: string;
  repoUrl: string;
  owner: string | null;
  stars: number | null;
  licenseType: string;
  licenseReviewStatus: string;
  dependencyChecked: boolean;
  securityChecked: boolean;
  tested: boolean;
  version: number;
}) {
  return {
    name: row.name,
    repoUrl: row.repoUrl,
    owner: row.owner,
    stars: row.stars,
    licenseType: row.licenseType,
    licenseReviewStatus: row.licenseReviewStatus,
    dependencyChecked: row.dependencyChecked,
    securityChecked: row.securityChecked,
    tested: row.tested,
    version: row.version,
  };
}

/* ─────────────────────────── 核心：抓取 + 判定 + 落库 ─────────────────────────── */

export interface IngestDeps {
  /** 注入"抓一个仓库元数据"的函数，缺省走真实 `fetchGitHubRepo`；单测注入假实现无网络测死编排。 */
  fetchRepo?: (ref: string) => Promise<GitHubRepoLite>;
  fetchImpl?: GithubFetch;
  token?: string;
  signal?: AbortSignal;
}

/**
 * 抓取一个 GitHub 仓库 → 走既有 `evaluateCandidate` 治理判定 → 按去重键 upsert 进 `OpenSourceProject` +
 * 落 `ChangeLog`。新建时写入许可证元数据；更新时**只刷新客观元数据、绝不覆盖人工复核态**（见文件头不变式）。
 *
 * @param ref 仓库标识：`owner/repo` 或 GitHub 仓库 URL。
 * @param actor 审计标注（形如 `human:<userId>` / `scout:github`），非鉴权。
 */
export async function ingestGitHubRepo(ref: string, actor?: string, deps: IngestDeps = {}): Promise<IngestResult> {
  const fetchRepo =
    deps.fetchRepo ?? ((r: string) => fetchGitHubRepo(r, { fetchImpl: deps.fetchImpl, token: deps.token, signal: deps.signal }));

  let repoMeta: GitHubRepoLite;
  try {
    repoMeta = await fetchRepo(ref);
  } catch (err) {
    if (err instanceof ScoutFetchError) {
      log.warn("ingestGitHubRepo: 抓取失败", { ref: redactRef(ref), httpStatus: err.status });
      return { status: "fetch_error", httpStatus: err.status, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("ingestGitHubRepo: 抓取异常", { ref: redactRef(ref), error: message });
    return { status: "error", error: message };
  }

  const { candidate: rawCandidate, licenseNote } = mapGitHubRepoToCandidate(repoMeta);
  const evalRes = evaluateCandidate(rawCandidate);
  if (evalRes.status === "invalid") {
    // 元数据脏到无法构成合法候选：诚实拒绝、绝不写库（第 20 条）。
    log.warn("ingestGitHubRepo: 候选校验不通过，未落库", { ref: redactRef(ref), issues: evalRes.issues.length });
    return { status: "invalid", issues: evalRes.issues };
  }
  const { candidate, dedupKey, readiness } = evalRes;
  if (!dedupKey) {
    return { status: "invalid", issues: [{ path: ["repoUrl"], message: "仓库 URL 归一为空" } as z.ZodError["issues"][number]] };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.openSourceProject.findUnique({ where: { repoUrl: dedupKey } });

      if (!existing) {
        const created = await tx.openSourceProject.create({
          data: {
            name: candidate.name,
            repoUrl: dedupKey,
            owner: candidate.owner ?? null,
            stars: candidate.stars ?? null,
            licenseType: candidate.licenseType,
            // 新建：许可证默认最保守 NOT_REVIEWED，交人工复核（自动层不越权批准法律门）。
            licenseReviewStatus: "NOT_REVIEWED",
            licenseNote,
            // 依赖/安全/实测：GitHub 元数据无法证明 → 一律 false，绝不假称已检查。
            dependencyChecked: false,
            securityChecked: false,
            tested: false,
            lastCheckedAt: new Date(),
          },
        });
        await tx.changeLog.create({
          data: changeLogArgs(created.id, "CREATE", actor, "Scout 抓取入库（GitHub 元数据）", null, snapshot(created)),
        });
        return { row: created, created: true, before: null };
      }

      // 更新：仅刷新客观元数据；刻意不动 licenseReviewStatus / dependencyChecked / securityChecked / tested
      // ——保护人工裁决与实测结果不被自动重抓冲掉（第 11 条法律门在人身上）。原始 SPDX 变化只进 licenseNote 供人对照。
      const updated = await tx.openSourceProject.update({
        where: { id: existing.id },
        data: {
          name: candidate.name,
          owner: candidate.owner ?? null,
          stars: candidate.stars ?? null,
          licenseType: candidate.licenseType,
          licenseNote,
          lastCheckedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await tx.changeLog.create({
        data: changeLogArgs(
          existing.id,
          "UPDATE",
          actor,
          "Scout 重抓刷新元数据（保留人工复核态）",
          snapshot(existing),
          snapshot(updated),
        ),
      });
      return { row: updated, created: false, before: existing };
    });

    log.info("scout project ingested", {
      id: result.row.id,
      created: result.created,
      licenseType: candidate.licenseType,
      verdict: readiness.license.verdict,
      readyForReuse: readiness.readyForReuse,
    });

    return {
      status: "ok",
      id: result.row.id,
      created: result.created,
      dedupKey,
      candidate,
      readyForReuse: readiness.readyForReuse,
      blockers: readiness.blockers,
      licenseVerdict: readiness.license.verdict,
      version: result.row.version,
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // 罕见竞态：并发下同一去重键被抢先建；如实回报，交上层重试（不静默吞）。
      const message = "并发写入冲突（同仓库正被另一请求入库）";
      log.warn("ingestGitHubRepo: 唯一键冲突", { dedupKey });
      return { status: "error", error: message };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("ingestGitHubRepo failed", { ref: redactRef(ref), error: message });
    return { status: "error", error: message };
  }
}

/** 从候选对象直接评估并落库（不经网络）——供已持有元数据的调用方 / 集成测试注入确定性候选、离线可复算。 */
export async function ingestCandidate(
  rawCandidate: unknown,
  actor?: string,
  opts: { licenseNote?: string } = {},
): Promise<IngestResult> {
  const evalRes = evaluateCandidate(rawCandidate);
  if (evalRes.status === "invalid") {
    return { status: "invalid", issues: evalRes.issues };
  }
  const { candidate, dedupKey, readiness } = evalRes;
  if (!dedupKey) {
    return { status: "invalid", issues: [{ path: ["repoUrl"], message: "仓库 URL 归一为空" } as z.ZodError["issues"][number]] };
  }
  const licenseNote = opts.licenseNote ?? null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.openSourceProject.findUnique({ where: { repoUrl: dedupKey } });
      if (!existing) {
        const created = await tx.openSourceProject.create({
          data: {
            name: candidate.name,
            repoUrl: dedupKey,
            owner: candidate.owner ?? null,
            stars: candidate.stars ?? null,
            licenseType: candidate.licenseType,
            licenseReviewStatus: "NOT_REVIEWED",
            licenseNote,
            dependencyChecked: false,
            securityChecked: false,
            tested: false,
            lastCheckedAt: new Date(),
          },
        });
        await tx.changeLog.create({
          data: changeLogArgs(created.id, "CREATE", actor, "Scout 候选入库", null, snapshot(created)),
        });
        return { row: created, created: true };
      }
      const updated = await tx.openSourceProject.update({
        where: { id: existing.id },
        data: {
          name: candidate.name,
          owner: candidate.owner ?? null,
          stars: candidate.stars ?? null,
          licenseType: candidate.licenseType,
          licenseNote,
          lastCheckedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await tx.changeLog.create({
        data: changeLogArgs(existing.id, "UPDATE", actor, "Scout 候选更新（保留人工复核态）", snapshot(existing), snapshot(updated)),
      });
      return { row: updated, created: false };
    });

    return {
      status: "ok",
      id: result.row.id,
      created: result.created,
      dedupKey,
      candidate,
      readyForReuse: readiness.readyForReuse,
      blockers: readiness.blockers,
      licenseVerdict: readiness.license.verdict,
      version: result.row.version,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("ingestCandidate failed", { dedupKey, error: message });
    return { status: "error", error: message };
  }
}

/** 把 ref 缩成"仅 owner/repo"级、去查询串，避免日志泄露可能的令牌/私有路径细节。 */
function redactRef(ref: string): string {
  try {
    const trimmed = ref.trim().slice(0, 120);
    return trimmed.replace(/[?#].*$/, "");
  } catch {
    return "(unprintable)";
  }
}

/** 供后台/审核队列复用的 id 校验（与 case-admin 同口径）。 */
export const ProjectIdSchema = CuidSchema;
