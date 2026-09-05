-- CreateTable
CREATE TABLE "ModelCall" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "taskKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL,
    "agent" TEXT,
    "caseId" TEXT,
    "solutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelCall_createdAt_idx" ON "ModelCall"("createdAt");

-- CreateIndex
CREATE INDEX "ModelCall_agent_createdAt_idx" ON "ModelCall"("agent", "createdAt");

-- CreateIndex
CREATE INDEX "ModelCall_tier_idx" ON "ModelCall"("tier");

-- CreateIndex
CREATE INDEX "ModelCall_status_idx" ON "ModelCall"("status");

-- CreateIndex
CREATE INDEX "ModelCall_caseId_idx" ON "ModelCall"("caseId");

-- CreateIndex
CREATE INDEX "ModelCall_solutionId_idx" ON "ModelCall"("solutionId");

