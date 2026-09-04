-- CreateEnum
CREATE TYPE "EvidenceGrade" AS ENUM ('S', 'A', 'B', 'C', 'D');

-- AlterTable
ALTER TABLE "Evidence" ADD COLUMN     "grade" "EvidenceGrade";
