-- R8（上游产业项目池）：新增 CandidateProject 单表（mandate §八）
-- ------------------------------------------------------------------
-- 目标：从"项目决策工具"升级为"项目机会筛选入口"——先广泛发现候选产业项目、再极度聚焦。
-- 刻意**只新增这一张表**：evidence / unknowns / screeningResult 用 JSONB 内联，不建关联表、
-- 不改任何既有表；复用既有 Industry 枚举；status/sourceType 走 String 列 + TS 白名单。
-- 与 BenchmarkEntry / 引擎无 FK，无任何代码路径据本表自动改生产模型或基准
-- （AI 工作区产出恒为候选，须经人工核验后由人决定是否提升为 Case / Project）。
-- 计算真源、黄金基线、BENCHMARK/ENGINE 常量零改动。
-- 由 `prisma migrate diff --from-schema-datamodel --to-schema-datamodel --script` 离线生成（无需 shadow 库）。
-- 本文件**尚未应用到数据库**：迁移应用属创始人域（生产部署 STOP）。

-- CreateTable
CREATE TABLE "CandidateProject" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "industry" "Industry" NOT NULL DEFAULT 'NEW_ENERGY',
    "region" TEXT,
    "source" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "description" TEXT,
    "technology" TEXT,
    "estimatedScale" TEXT,
    "evidence" JSONB,
    "unknowns" JSONB,
    "screeningResult" JSONB,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "version" INTEGER NOT NULL DEFAULT 1,
    "promotedCaseId" TEXT,
    "promotedProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CandidateProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CandidateProject_status_createdAt_idx" ON "CandidateProject"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateProject_industry_region_idx" ON "CandidateProject"("industry", "region");

-- CreateIndex
CREATE INDEX "CandidateProject_sourceType_idx" ON "CandidateProject"("sourceType");

