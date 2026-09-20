-- CreateTable
CREATE TABLE "BenchmarkEntry" (
    "id" TEXT NOT NULL,
    "benchmarkVersion" TEXT NOT NULL,
    "regionId" TEXT NOT NULL DEFAULT '',
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "textValue" TEXT,
    "valueClass" TEXT NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "sourceUrl" TEXT,
    "validFrom" TEXT,
    "validTo" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenchmarkEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BenchmarkEntry_benchmarkVersion_idx" ON "BenchmarkEntry"("benchmarkVersion");

-- CreateIndex
CREATE INDEX "BenchmarkEntry_regionId_key_idx" ON "BenchmarkEntry"("regionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "BenchmarkEntry_benchmarkVersion_regionId_key_key" ON "BenchmarkEntry"("benchmarkVersion", "regionId", "key");

