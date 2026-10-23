-- Durations are milliseconds; retain original ticks for audit/compatibility.
-- 300 ms is the frozen legacy conversion, independent of future NODE_TICKRATE.
BEGIN IMMEDIATE;
ALTER TABLE hiscore ADD COLUMN playtime_ms BIGINT NOT NULL DEFAULT 0;
UPDATE hiscore SET playtime_ms = playtime * 300;
DROP INDEX hiscore_rank;
CREATE INDEX hiscore_duration_rank ON hiscore(profile, type, level DESC, playtime_ms, account_id);
ALTER TABLE hiscore_large ADD COLUMN playtime_ms BIGINT NOT NULL DEFAULT 0;
UPDATE hiscore_large SET playtime_ms = playtime * 300;
DROP INDEX hiscore_large_rank;
CREATE INDEX hiscore_large_duration_rank ON hiscore_large(profile, type, level DESC, playtime_ms, account_id);
COMMIT;
