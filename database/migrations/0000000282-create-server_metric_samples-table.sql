-- Agent-pushed host samples, in their own table rather than as
-- check_results rows tagged region='agent'.
--
-- The old placement had a correctness bug that could not be fixed by
-- filtering alone: app/lib/uptime.ts and config/regions.ts consensusStatus
-- treated 'agent' as one more voting region, so a healthy CPU sample
-- out-voted a genuinely failing probe (100 consecutive 'down' probe checks
-- interleaved with healthy agent pushes computed as 100% uptime), and
-- table-wide readers with no monitor predicate (CheckWorkerHealth's
-- dead-man's switch, the monitor index's checks-in-range count) counted
-- samples as checks. A separate table makes every reader of check_results
-- correct by construction -- a sample physically cannot be a vote.
--
-- Typed REAL columns instead of a JSON blob so hourly rollups are one
-- GROUP BY on either dialect instead of "SELECT every row, JSON.parse,
-- reduce in JS" forever. No uuid: nothing addresses a sample individually,
-- and this is one row per host per minute.
--
-- Same shape as ci_runner_samples (0000000114): a self-pruning samples
-- table with a (key, time) composite and a bare time index for the sweep.
CREATE TABLE IF NOT EXISTS "server_metric_samples" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "host" TEXT NOT NULL DEFAULT 'default',
  "cpu_percent" REAL NOT NULL,
  "ram_percent" REAL NOT NULL,
  "ram_used_mb" REAL NOT NULL,
  "ram_total_mb" REAL NOT NULL,
  "disk_percent" REAL,
  "breaches" TEXT NOT NULL DEFAULT '[]',
  "sampled_at" TEXT NOT NULL,
  "server_id" INTEGER NOT NULL,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);

-- Serves: the fleet window read at ingest
--   WHERE server_id = ? AND sampled_at >= ? ORDER BY sampled_at DESC
-- the per-host series the server page charts
--   WHERE server_id = ? AND host = ? AND sampled_at >= ?
-- and latest-per-host.
CREATE INDEX IF NOT EXISTS "server_metric_samples_server_id_host_sampled_at_index" ON "server_metric_samples" ("server_id", "host", "sampled_at");
CREATE INDEX IF NOT EXISTS "server_metric_samples_server_id_sampled_at_index" ON "server_metric_samples" ("server_id", "sampled_at");
-- Retention sweep (PruneOldServerMetricSamples): WHERE sampled_at < ?
CREATE INDEX IF NOT EXISTS "server_metric_samples_sampled_at_index" ON "server_metric_samples" ("sampled_at");
