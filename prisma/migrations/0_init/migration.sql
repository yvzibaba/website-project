-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Industry" AS ENUM ('NEW_ENERGY', 'INDUSTRIAL_MANUFACTURING', 'TRANSPORTATION', 'AGRICULTURE_FORESTRY_FISHERY', 'EDUCATION_TRAINING', 'REAL_ESTATE_CONSTRUCTION', 'OTHER');

-- CreateEnum
CREATE TYPE "CaseStage" AS ENUM ('CANDIDATE', 'KEY_RESEARCH', 'DEEP_CASE', 'KEY_SOLUTION', 'PREMIUM_SOLUTION');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('FACT', 'ASSUMPTION', 'INFERENCE', 'PREDICTION');

-- CreateEnum
CREATE TYPE "Maturity" AS ENUM ('EMERGING', 'DEVELOPING', 'MATURE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LicenseType" AS ENUM ('MIT', 'APACHE_2_0', 'BSD_2_CLAUSE', 'BSD_3_CLAUSE', 'MPL_2_0', 'LGPL', 'GPL', 'AGPL', 'PROPRIETARY', 'UNKNOWN', 'OTHER');

-- CreateEnum
CREATE TYPE "LicenseReviewStatus" AS ENUM ('NOT_REVIEWED', 'APPROVED', 'NEEDS_HUMAN_REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "SolutionStatus" AS ENUM ('DRAFT', 'UNDER_HUMAN_REVIEW', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('CNY', 'USD');

-- CreateEnum
CREATE TYPE "BuyerType" AS ENUM ('INDIVIDUAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'REFUNDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ChangeAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'ROLLBACK');

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "code" TEXT,
    "country" TEXT DEFAULT 'CN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "regionId" TEXT,
    "sizeEstimate" DECIMAL(65,30),
    "currency" "Currency" NOT NULL DEFAULT 'CNY',
    "sourceUrl" TEXT,
    "confidence" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleEn" TEXT,
    "industry" "Industry" NOT NULL,
    "regionId" TEXT,
    "sourceUrl" TEXT,
    "sourceType" TEXT,
    "summary" TEXT,
    "summaryEn" TEXT,
    "stage" "CaseStage" NOT NULL DEFAULT 'CANDIDATE',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opportunityScore" INTEGER,
    "evidenceConfidence" INTEGER,
    "businessModelId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" "EvidenceType" NOT NULL,
    "statement" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceType" TEXT,
    "confidence" INTEGER,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessModel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "revenueStreams" TEXT[],
    "costStructure" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechCapability" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "category" TEXT,
    "description" TEXT,
    "maturity" "Maturity" NOT NULL DEFAULT 'UNKNOWN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechCapability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseCapability" (
    "caseId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "relevance" INTEGER,
    "note" TEXT,

    CONSTRAINT "CaseCapability_pkey" PRIMARY KEY ("caseId","capabilityId")
);

-- CreateTable
CREATE TABLE "OpenSourceProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "owner" TEXT,
    "stars" INTEGER,
    "licenseType" "LicenseType" NOT NULL DEFAULT 'UNKNOWN',
    "licenseReviewStatus" "LicenseReviewStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
    "licenseNote" TEXT,
    "dependencyChecked" BOOLEAN NOT NULL DEFAULT false,
    "securityChecked" BOOLEAN NOT NULL DEFAULT false,
    "tested" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpenSourceProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapabilityProject" (
    "capabilityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fitScore" INTEGER,
    "note" TEXT,

    CONSTRAINT "CapabilityProject_pkey" PRIMARY KEY ("capabilityId","projectId")
);

-- CreateTable
CREATE TABLE "Localization" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "capabilityId" TEXT,
    "description" TEXT,
    "adaptations" TEXT[],
    "constraints" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Localization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "regionId" TEXT,
    "capabilities" TEXT[],
    "contactInfo" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalizationSupplier" (
    "localizationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,

    CONSTRAINT "LocalizationSupplier_pkey" PRIMARY KEY ("localizationId","supplierId")
);

-- CreateTable
CREATE TABLE "Solution" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleEn" TEXT,
    "slug" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" "SolutionStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT,
    "body" JSONB,
    "price" DECIMAL(12,2),
    "currency" "Currency" NOT NULL DEFAULT 'CNY',
    "publishedAt" TIMESTAMP(3),
    "opportunityScore" INTEGER,
    "evidenceConfidence" INTEGER,
    "unknownVariableCount" INTEGER,
    "riskDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "needsProfessionalReview" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Solution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolutionFinancial" (
    "id" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "capex" DECIMAL(14,2),
    "opexAnnual" DECIMAL(14,2),
    "revenueAnnual" DECIMAL(14,2),
    "roiPct" DECIMAL(8,4),
    "irrPct" DECIMAL(8,4),
    "paybackYears" DECIMAL(8,2),
    "currency" "Currency" NOT NULL DEFAULT 'CNY',
    "assumptions" JSONB,
    "calcRef" TEXT,
    "sourceUrl" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SolutionFinancial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnknownVariable" (
    "id" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "impact" TEXT,
    "howToResolve" TEXT,
    "severity" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnknownVariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "solutionId" TEXT NOT NULL,
    "buyerType" "BuyerType" NOT NULL DEFAULT 'INDIVIDUAL',
    "buyerEmail" TEXT,
    "buyerName" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'CNY',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "paymentProvider" TEXT,
    "paymentRef" TEXT,
    "paidAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" "ChangeAction" NOT NULL,
    "changedBy" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");

-- CreateIndex
CREATE INDEX "Evidence_caseId_type_idx" ON "Evidence"("caseId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "OpenSourceProject_repoUrl_key" ON "OpenSourceProject"("repoUrl");

-- CreateIndex
CREATE INDEX "OpenSourceProject_licenseReviewStatus_idx" ON "OpenSourceProject"("licenseReviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Solution_slug_key" ON "Solution"("slug");

-- CreateIndex
CREATE INDEX "Solution_status_publishedAt_idx" ON "Solution"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "SolutionFinancial_solutionId_idx" ON "SolutionFinancial"("solutionId");

-- CreateIndex
CREATE INDEX "UnknownVariable_solutionId_idx" ON "UnknownVariable"("solutionId");

-- CreateIndex
CREATE INDEX "Order_solutionId_status_idx" ON "Order"("solutionId", "status");

-- CreateIndex
CREATE INDEX "ChangeLog_entityType_entityId_createdAt_idx" ON "ChangeLog"("entityType", "entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_businessModelId_fkey" FOREIGN KEY ("businessModelId") REFERENCES "BusinessModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseCapability" ADD CONSTRAINT "CaseCapability_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseCapability" ADD CONSTRAINT "CaseCapability_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "TechCapability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityProject" ADD CONSTRAINT "CapabilityProject_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "TechCapability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityProject" ADD CONSTRAINT "CapabilityProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "OpenSourceProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Localization" ADD CONSTRAINT "Localization_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Localization" ADD CONSTRAINT "Localization_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "TechCapability"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalizationSupplier" ADD CONSTRAINT "LocalizationSupplier_localizationId_fkey" FOREIGN KEY ("localizationId") REFERENCES "Localization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalizationSupplier" ADD CONSTRAINT "LocalizationSupplier_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Solution" ADD CONSTRAINT "Solution_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolutionFinancial" ADD CONSTRAINT "SolutionFinancial_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "Solution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnknownVariable" ADD CONSTRAINT "UnknownVariable_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "Solution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_solutionId_fkey" FOREIGN KEY ("solutionId") REFERENCES "Solution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

