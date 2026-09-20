-- R5 · V2 版本治理：给 ProjectVersion 追加一组**可空**的 V2 溯源列，
-- 使「正式情景重算」能把旧结果冻结为不可变版本、并回答「这条历史结果当时按哪个
-- engine / benchmark / schema 版本、哪份输入哈希算出来的」。
--
-- 纯加性（ADD COLUMN，全 nullable，无回填、无默认值、不动任何既有列/约束/索引）：
--   - V1 冻结路径不写这些列 → 既有版本行逐字节不变；
--   - 不改计算真源（引擎仍读内核常量），因此黄金基线零变化。
ALTER TABLE "ProjectVersion" ADD COLUMN     "benchmarkVersion" TEXT,
ADD COLUMN     "calculatedAt" TIMESTAMP(3),
ADD COLUMN     "decision" JSONB,
ADD COLUMN     "engineVersion" TEXT,
ADD COLUMN     "inputHash" TEXT,
ADD COLUMN     "scenarioInput" JSONB,
ADD COLUMN     "scenarioSchemaVersion" TEXT,
ADD COLUMN     "summary" JSONB;
