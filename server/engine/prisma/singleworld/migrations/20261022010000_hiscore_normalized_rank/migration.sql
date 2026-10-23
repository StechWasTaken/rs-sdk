-- Normalize leaderboard times using raw ticks at the current configured pace.
-- Keep historical durations and tick counts unchanged.
CREATE INDEX hiscore_rank ON hiscore(profile, type, level DESC, playtime, account_id);
CREATE INDEX hiscore_large_rank ON hiscore_large(profile, type, level DESC, playtime, account_id);
