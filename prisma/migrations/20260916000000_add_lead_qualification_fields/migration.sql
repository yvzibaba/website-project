-- V1.1 P4-brief：留资(Lead)企业咨询资格判定字段（纯 additive、全部可空，无破坏性变更）
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "projectRegion" TEXT,
ADD COLUMN     "fleetSize" TEXT,
ADD COLUMN     "needType" TEXT;
