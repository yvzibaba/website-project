import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { CaseStage, SolutionStatus, UserRole } from "@/lib/validation";

/**
 * 后台数据聚合（server-only，Phase 6 M2）。
 *
 * 职责：为 /admin 首页提供一份**真实**的站点运行概览——各实体计数与分维度分布，
 *   以及最近的 ChangeLog（审计流水）。这里**只做只读聚合，不含任何鉴权**：
 *   「谁能看」由 src/server/authz.ts 在 layout 层把关（STAFF_ROLES）；本模块假设调用方已授权。
 *   这样分离便于：数据层用集成测试直连 Neon 断言计数自洽（总控 §28 权限/数据库测试重点），
 *   门禁逻辑用单元测试固定用例（vi.mock 会话），互不牵连。
 *
 * 诚实（宪法第 20 条）：所有数字来自数据库实时聚合，绝不缓存/编造；分组键缺失即不展示该项。
 */

const log = logger.child({ module: "server/admin" });

export interface AdminDashboardData {
  cases: { total: number; byStage: Partial<Record<CaseStage, number>> };
  solutions: { total: number; byStatus: Partial<Record<SolutionStatus, number>> };
  users: { total: number; byRole: Partial<Record<UserRole, number>> };
  evidences: {
    total: number;
    /** grade 可空（尚未标注来源等级）→ key "NONE"。 */
    byGrade: Record<string, number>;
  };
  orders: { total: number };
  recentChanges: Array<{
    id: string;
    entityType: string;
    entityId: string;
    action: string;
    changedBy: string | null;
    reason: string | null;
    createdAt: Date;
  }>;
  generatedAt: Date;
}

function tally<T extends string>(rows: readonly unknown[], key: string): Record<T, number> {
  const out: Record<string, number> = {};
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const k = String(r[key] ?? "NONE");
    // groupBy 用 `_count: { _all: true }` 时，返回 r._count = { _all: number }（此形态不强制要求 orderBy）。
    const countField = r._count as { _all?: number } | number | undefined;
    const n = typeof countField === "number" ? countField : Number(countField?._all ?? 0);
    out[k] = (out[k] ?? 0) + n;
  }
  return out as Record<T, number>;
}

/** 分布求和 → 总数（与 groupBy 同源，天然自洽）。 */
function sum(map: Record<string, number>): number {
  return Object.values(map).reduce((s, n) => s + n, 0);
}

/** 并行聚合各实体计数与分布 + 最近审计流水。DB 异常向上抛，由页面 error 边界处理。 */
export async function getAdminDashboardData(recentLimit = 20): Promise<AdminDashboardData> {
  const [orderTotal, caseByStage, solutionByStatus, userByRole, evidenceByGrade, recentChanges] =
    await prisma.$transaction([
      prisma.order.count(),
      prisma.case.groupBy({ by: ["stage"], orderBy: { stage: "asc" }, _count: { _all: true } }),
      prisma.solution.groupBy({ by: ["status"], orderBy: { status: "asc" }, _count: { _all: true } }),
      prisma.user.groupBy({ by: ["role"], orderBy: { role: "asc" }, _count: { _all: true } }),
      prisma.evidence.groupBy({ by: ["grade"], orderBy: { grade: "asc" }, _count: { _all: true } }),
      prisma.changeLog.findMany({
        orderBy: { createdAt: "desc" },
        take: Math.max(0, Math.min(recentLimit, 100)),
        select: {
          id: true,
          entityType: true,
          entityId: true,
          action: true,
          changedBy: true,
          reason: true,
          createdAt: true,
        },
      }),
    ]);

  // 总数直接从各自 groupBy 分布求和，而非另发一次 count()：
  //   ① 少 4 次查询；② 天然满足「分布之和 === 总数」的自洽不变式（并发写入下也不会两边打架）。
  const cases = tally<CaseStage>(caseByStage, "stage");
  const solutions = tally<SolutionStatus>(solutionByStatus, "status");
  const users = tally<UserRole>(userByRole, "role");
  const evidences = tally(evidenceByGrade, "grade");

  log.info("admin dashboard aggregated", { orderTotal, cases: sum(cases), solutions: sum(solutions) });

  return {
    cases: { total: sum(cases), byStage: cases },
    solutions: { total: sum(solutions), byStatus: solutions },
    users: { total: sum(users), byRole: users },
    evidences: { total: sum(evidences), byGrade: evidences },
    orders: { total: orderTotal },
    recentChanges: recentChanges.map((c) => ({
      id: c.id,
      entityType: c.entityType,
      entityId: c.entityId,
      action: c.action,
      changedBy: c.changedBy,
      reason: c.reason,
      createdAt: c.createdAt,
    })),
    generatedAt: new Date(),
  };
}
