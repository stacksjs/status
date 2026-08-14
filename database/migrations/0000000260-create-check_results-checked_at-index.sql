-- Covers PruneOldCheckResults' daily sweep (DELETE WHERE checked_at < ?),
-- which otherwise scans the whole check_results table once a day. Separate
-- from the (monitor_id, checked_at) composite because that one cannot serve
-- a predicate on checked_at alone.
CREATE INDEX IF NOT EXISTS "check_results_checked_at_index" ON "check_results" ("checked_at");
