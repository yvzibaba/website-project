-- AlterTable
ALTER TABLE "ProjectScenario" ADD COLUMN     "benchmarkVersion" TEXT,
ADD COLUMN     "calcError" TEXT,
ADD COLUMN     "decision" JSONB,
ADD COLUMN     "engineVersion" TEXT,
ADD COLUMN     "inputHash" TEXT,
ADD COLUMN     "irrEquityPct" DECIMAL(9,4),
ADD COLUMN     "lcoeYuanPerKwh" DECIMAL(12,4),
ADD COLUMN     "npvEquity" DECIMAL(16,2),
ADD COLUMN     "report" JSONB,
ADD COLUMN     "scenarioInput" JSONB;

-- CreateTable
CREATE TABLE "ProjectActual" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scenarioId" TEXT,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL DEFAULT 0,
    "gridImportKwh" DECIMAL(16,3),
    "pvGenerationKwh" DECIMAL(16,3),
    "bessDischargeKwh" DECIMAL(16,3),
    "deliveredKwh" DECIMAL(16,3),
    "exportKwh" DECIMAL(16,3),
    "gridCostYuan" DECIMAL(16,2),
    "revenueYuan" DECIMAL(16,2),
    "opexYuan" DECIMAL(16,2),
    "availabilityPct" DECIMAL(6,2),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "recordedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectActual_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectActual_projectId_periodYear_idx" ON "ProjectActual"("projectId", "periodYear");

-- CreateIndex
CREATE INDEX "ProjectActual_scenarioId_idx" ON "ProjectActual"("scenarioId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectActual_projectId_periodYear_periodMonth_key" ON "ProjectActual"("projectId", "periodYear", "periodMonth");

-- AddForeignKey
ALTER TABLE "ProjectActual" ADD CONSTRAINT "ProjectActual_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectActual" ADD CONSTRAINT "ProjectActual_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ProjectScenario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
