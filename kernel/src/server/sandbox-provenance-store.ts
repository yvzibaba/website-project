/**
 * 沙盘「来源方案」溯源升级的**受门禁写路径**（中途重构 R8.5 · 总控最高优先级「商业闭环」的第五块拼图）。
 *
 * 承接：R8.4 交付了一份**纯函数式**的溯源体检报告（可复算审计 + 可追溯摘要 + `planProvenanceUpgrade`
 * 升级预案），但那把闸门刻意**只出计划不落库**——把「是否把某条占位假设升成可售卖事实」的裁决权
 * 焊死在「合法 http(s) 来源链接 + 数值置信度」上，却还没有人能把真实出处**提交进来**。本模块就是那
 * 缺失的「提交→校验→落库」写路径：让 staff（审核员/管理员）带着真实来源，把一条 `SolutionFinancial`
 * 从 ASSUMPTION 受控升级为 FACT，并**留下完整审计痕迹**。
 *
 * 设计（宪法第 7/12/13/16/20/21 条 + 「AI 做劳动、人做关键决策」）：
 *   - **闸门逻辑零复制**：升级判据完全复用 R8.4 已单测死的纯函数 `planProvenanceUpgrade`（§16 单一真源）。
 *     `willUpgrade:false` 一律**拒不落库**并透传其 `reason`（无来源链接 / 无置信度 / 越界），绝不静默、
 *     绝不粉饰占位假设为事实（§20）。识别与授权分离：能否升级由合法证据决定，真正落库由人触发。
 *   - **只改溯源、绝不碰数字**（§8 单一真源 / 禁再算）：本路径**不重算任何经济指标**，只写
 *     `sourceUrl` 列并把 `assumptions` 里的 `evidenceKind` 由 ASSUMPTION 改写为 FACT、补挂来源与置信度。
 *     落库 Decimal 列（roiPct/irrPct/paybackYears）与源值（roiRatio/irrFraction/discountedPaybackYears）
 *     **原样保留** → 升级后 R8.4 的可复算审计仍应通过、R8.3 的沙盘来源识别（`solutionCalcRef`）仍可命中，
 *     这是本里程碑最重要的**不破坏既有脊柱**约束（集成测试钉死）。
 *   - **版本自增 + 可回滚痕迹**（§13 禁覆盖生产）：`version` 服务端 `increment:1`；`assumptions` 里追加
 *     `provenanceUpgrade` 升维戳（from/to/upgradeRef/upgradedBy/note），并写 `ChangeLog`（UPDATE，含
 *     before/after），使每一次升级都可追溯、可比对——不覆盖、只叠加。
 *   - **失败诚实回报、不裸抛**：`financialId` 非 cuid 或记录不存在 → `not_found`；判据未过 → `blocked`
 *     （带 fieldErrors，供 UI 提示）；DB 异常 → `error`。结果形状与 `api-guard.MutationLike` 兼容。
 *
 * 边界（勿越权）：
 *   - **server 域逻辑**（route 层调用，受 `requireStaffWrite` CSRF + REVIEWER/ADMIN 门禁保护）；本仓刻意
 *     不 import "server-only"（vitest/node 会抛错），仅注释标注。
 *   - **只升级单条财务的溯源**，不改方案发布状态、不改价格、不自动上架——发布仍由 `publishGuard` 把关（§21）。
 *   - **不批量、不级联**：一次只针对一条 `financialId`，避免「一处提交悄悄改掉整套数字的可信度」。
 */

import { z } from "zod";
// 注：本模块为 server 域逻辑（route 层调用）。本仓刻意不 import "server-only"（vitest/node 会抛错），仅注释标注。
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { Prisma } from "@prisma/client";
import { CuidSchema } from "@/lib/validation";
import {
  planProvenanceUpgrade,
  provenanceCalcRef,
  SANDBOX_SOLUTION_PROVENANCE_VERSION,
  type ProvenanceUpgradeIntent,
} from "@/lib/sandbox-solution-provenance";

const log = logger.child({ module: "server/sandbox-provenance-store" });

/** 溯源升级写路径口径版本（升级判据消费方式 / 落库字段变化须升版记因，宪法第 13 条）。 */
export const SANDBOX_PROVENANCE_STORE_VERSION = "1.0.0";

/* ─────────────────────────── 入参 schema（升级意图；判据本身仍复用 provenance 纯函数） ─────────────────────────── */

/**
 * 升级意图入参：与 R8.4 `ProvenanceUpgradeIntent` 同形，但在**写边界**再校验一遍（防录入/落库两套规则漂移）。
 * 此处刻意**宽松**接收（是否合法 http(s) / 置信度是否 [0,100] 交给 `planProvenanceUpgrade` 裁决），
 * 好让「缺来源链接」「置信度越界」都走 `blocked` + 明确 reason，而非笼统 400。
 */
export const ProvenanceUpgradeIntentSchema = z.object({
  sourceUrl: z.string().trim().max(2000).nullish(),
  confidence: z.number().nullish(),
  note: z.string().trim().max(2000).nullish(),
});

/* ─────────────────────────── 结果类型（与 api-guard.MutationLike 结构兼容，可直喂 mutationResponse） ─────────────────────────── */

export interface ProvenanceUpgradeResult {
  status: "ok" | "not_found" | "blocked" | "error";
  solutionId?: string;
  financialId?: string;
  /** 拒绝升级（willUpgrade:false）时透传的判据原因（供界面提示，绝不静默）。 */
  reason?: string;
  fieldErrors?: Record<string, string[]>;
  error?: string;
  /** 成功升级后的新 version（观测/回显用）。 */
  version?: number;
  /** 升级后的目标证据等级（正常恒 "FACT"）。 */
  evidenceKind?: string;
  /** 本次升级引用的溯源口径（provenanceCalcRef()）。 */
  upgradeRef?: string;
}

/* ─────────────────────────── 内部工具 ─────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 把升级信息**叠加**进既有 assumptions（不删除任何引擎源值/溯源戳），仅：
 *   - 覆写 `evidenceKind:"FACT"`（占位假设→事实）；
 *   - 补挂 `sourceUrl`/`confidence`（与列/审计双写，便于纯 assumptions 视图也自证可追溯）；
 *   - 追加 `provenanceUpgrade` 升维戳（from/to/upgradeRef/upgradedBy/at-note/auditVersion），
 *     使「谁、凭哪条来源、按哪个口径版本把 ASSUMPTION 升成 FACT」在 JSON 里自带痕迹（§12/§13）。
 * `roiRatio/irrFraction/discountedPaybackYears/solutionCalcRef` 等一律**原样保留**——不碰数字（§8）。
 */
function mergeAssumptionsForUpgrade(
  existing: unknown,
  args: { sourceUrl: string; confidence: number; note: string | null; actor: string | null },
): Prisma.InputJsonValue {
  const base = isRecord(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const fromKind = typeof base.evidenceKind === "string" ? (base.evidenceKind as string) : "ASSUMPTION";
  const merged: Record<string, unknown> = {
    ...base,
    evidenceKind: "FACT",
    sourceUrl: args.sourceUrl,
    confidence: args.confidence,
    provenanceUpgrade: {
      from: fromKind,
      to: "FACT",
      upgradeRef: provenanceCalcRef(),
      upgradedBy: args.actor,
      note: args.note,
      auditVersion: SANDBOX_SOLUTION_PROVENANCE_VERSION,
      storeVersion: SANDBOX_PROVENANCE_STORE_VERSION,
    },
  };
  return merged as Prisma.InputJsonValue;
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

/**
 * 把一条沙盘来源 `SolutionFinancial` 从 ASSUMPTION 受控升级为 FACT（提交真实来源 + 置信度）。
 * 全程经 R8.4 纯函数闸门裁决；**判据不过绝不落库**；升级只改溯源、不碰任何经济数字，保既有复算/识别脊柱不破。
 */
export async function upgradeSolutionFinancialProvenance(
  financialId: string,
  intent: unknown,
  actor?: string,
): Promise<ProvenanceUpgradeResult> {
  // 1) 目标财务 id 必须是合法 cuid（否则连记录都不可能存在）。
  const idParsed = CuidSchema.safeParse(financialId);
  if (!idParsed.success) return { status: "not_found", financialId };

  // 2) 升级意图宽松结构校验（真正的合法性交闸门裁决）。
  const parsed = ProvenanceUpgradeIntentSchema.safeParse(intent);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { status: "blocked", financialId, fieldErrors, reason: "升级意图入参结构非法" };
  }
  const upIntent: ProvenanceUpgradeIntent = {
    sourceUrl: parsed.data.sourceUrl ?? null,
    confidence: parsed.data.confidence ?? null,
    note: parsed.data.note ?? null,
  };

  // 3) 读取目标财务存量（含 assumptions/sourceUrl/version/solutionId，供闸门与合并）。
  const row = await prisma.solutionFinancial.findUnique({
    where: { id: financialId },
    select: {
      id: true,
      solutionId: true,
      sourceUrl: true,
      assumptions: true,
      version: true,
      roiPct: true,
      irrPct: true,
      paybackYears: true,
    },
  });
  if (!row) return { status: "not_found", financialId };

  // 4) 经 R8.4 纯函数闸门裁决：不满足「合法 http(s) 链接 + [0,100] 数值置信度」→ 拒不落库、透传原因。
  const plan = planProvenanceUpgrade(
    { sourceUrl: row.sourceUrl, assumptions: row.assumptions },
    upIntent,
  );
  if (!plan.willUpgrade) {
    return {
      status: "blocked",
      solutionId: row.solutionId,
      financialId: row.id,
      reason: plan.reason ?? "升级判据未通过",
      fieldErrors: { _reason: [plan.reason ?? "升级判据未通过"] },
    };
  }

  // 5) 组装叠加后的 assumptions 与升维戳（不碰任何 Decimal 列/源值）。
  const mergedAssumptions = mergeAssumptionsForUpgrade(row.assumptions, {
    sourceUrl: plan.sourceUrl as string,
    confidence: plan.confidence as number,
    note: typeof upIntent.note === "string" ? upIntent.note : null,
    actor: actor ?? null,
  });
  const newVersion = row.version + 1;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.solutionFinancial.update({
        where: { id: financialId },
        data: {
          sourceUrl: plan.sourceUrl as string,
          assumptions: mergedAssumptions,
          version: { increment: 1 },
        },
      });
      await tx.changeLog.create({
        data: {
          entityType: "Solution",
          entityId: row.solutionId,
          action: "UPDATE",
          changedBy: actor ?? null,
          reason: "升级财务溯源 ASSUMPTION→FACT（提交真实来源 + 置信度）",
          before: {
            financial: {
              id: row.id,
              sourceUrl: row.sourceUrl,
              version: row.version,
              evidenceKind: isRecord(row.assumptions) ? (row.assumptions as Record<string, unknown>).evidenceKind ?? null : null,
            },
          },
          after: {
            financial: {
              id: row.id,
              sourceUrl: plan.sourceUrl,
              version: newVersion,
              evidenceKind: "FACT",
              confidence: plan.confidence,
              upgradeRef: provenanceCalcRef(),
            },
          },
        },
      });
    });
    log.info("solution financial provenance upgraded", {
      financialId,
      solutionId: row.solutionId,
      version: newVersion,
    });
    return {
      status: "ok",
      solutionId: row.solutionId,
      financialId: row.id,
      version: newVersion,
      evidenceKind: "FACT",
      upgradeRef: provenanceCalcRef(),
    };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { status: "not_found", financialId };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("upgradeSolutionFinancialProvenance failed", { error: message, financialId });
    return { status: "error", solutionId: row.solutionId, financialId, error: message };
  }
}
