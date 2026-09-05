-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "industry" "Industry" NOT NULL DEFAULT 'NEW_ENERGY',
    "regionId" TEXT,
    "ownerId" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectScenario" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '基准情景',
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "paramLayers" JSONB NOT NULL,
    "paramSnapshot" JSONB NOT NULL,
    "calcResult" JSONB,
    "calcStatus" TEXT NOT NULL DEFAULT 'pending',
    "calcRef" TEXT,
    "capexNet" DECIMAL(16,2),
    "npv" DECIMAL(16,2),
    "irrPct" DECIMAL(9,4),
    "paybackYears" DECIMAL(8,2),
    "roiRatio" DECIMAL(12,4),
    "currency" "Currency" NOT NULL DEFAULT 'CNY',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectVersion" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" TEXT,
    "note" TEXT,
    "paramLayers" JSONB NOT NULL,
    "paramSnapshot" JSONB NOT NULL,
    "calcResult" JSONB,
    "calcRef" TEXT,
    "needsProfessionalReview" BOOLEAN NOT NULL DEFAULT true,
    "savedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_ownerId_status_idx" ON "Project"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Project_regionId_idx" ON "Project"("regionId");

-- CreateIndex
CREATE INDEX "Project_status_updatedAt_idx" ON "Project"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ProjectScenario_projectId_idx" ON "ProjectScenario"("projectId");

-- CreateIndex
CREATE INDEX "ProjectScenario_projectId_isBaseline_idx" ON "ProjectScenario"("projectId", "isBaseline");

-- CreateIndex
CREATE INDEX "ProjectVersion_projectId_createdAt_idx" ON "ProjectVersion"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectVersion_scenarioId_seq_key" ON "ProjectVersion"("scenarioId", "seq");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectScenario" ADD CONSTRAINT "ProjectScenario_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectVersion" ADD CONSTRAINT "ProjectVersion_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "ProjectScenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

