-- R6（M13）：实测 vs 预测偏差分析闭环 —— 预测侧冻结快照 + 校准候选表
-- ------------------------------------------------------------------
-- 全部 additive，不改/不删任何既有列、约束或语义：
--   1) ProjectScenario.forecastSnapshot（可空 JSONB）：写库时从**已算好的 calc** 只读投影出的
--      「与实测可比的预测量 + 身份 + 隐含单价比值」。计算真源、黄金基线、BENCHMARK/ENGINE 常量零改动。
--   2) CalibrationCandidate：偏差分析识别出系统性偏差后落一条「建议复核 X」的记录，
--      状态机 CANDIDATE→UNDER_REVIEW→ACCEPTED/REJECTED 全部由人推动；本表与基准/引擎无 FK，
--      没有任何代码路径据它自动改生产模型。
-- 由 `prisma migrate diff --from-schema-datamodel --to-schema-datamodel --script` 离线生成（无需 shadow 库）。

-- AlterTable
ALTER TABLE "ProjectScenario" ADD COLUMN     "forecastSnapshot" JSONB;

-- CreateTable
CREATE TABLE "CalibrationCandidate" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "metricLabel" TEXT NOT NULL,
    "parameter" TEXT,
    "parameterLabel" TEXT,
    "measurementBasis" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "periodKind" TEXT NOT NULL,
    "projectId" TEXT,
    "regionId" TEXT,
    "direction" TEXT NOT NULL,
    "forecastValue" DECIMAL(18,4),
    "actualValue" DECIMAL(18,4),
    "biasPct" DECIMAL(12,4),
    "meanAbsPct" DECIMAL(12,4),
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "impactYuan" DECIMAL(18,2),
    "impactEvidenceKind" TEXT NOT NULL DEFAULT 'ASSUMPTION',
    "evidence" JSONB NOT NULL,
    "suggestion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationCandidate_dedupeKey_key" ON "CalibrationCandidate"("dedupeKey");

-- CreateIndex
CREATE INDEX "CalibrationCandidate_status_createdAt_idx" ON "CalibrationCandidate"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CalibrationCandidate_metric_regionId_idx" ON "CalibrationCandidate"("metric", "regionId");

-- CreateIndex
CREATE INDEX "CalibrationCandidate_projectId_idx" ON "CalibrationCandidate"("projectId");
