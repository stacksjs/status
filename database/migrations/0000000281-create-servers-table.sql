-- Server: one physical box with one identity above Monitor. Owns the agent
-- ingest token, CPU/memory/disk thresholds, the missed-push window, the
-- sample history (server_metric_samples) and the box-level incidents.
-- Before this, all of that lived on each Monitor (monitors.metrics_token,
-- monitors.reports_metrics, threshold keys inside monitors.config), so two
-- monitors on one box were two tokens, two threshold sets and two incidents
-- for one hot CPU.
--
-- Hand-written, additive-only, like 0000000252/0000000279: types chosen to
-- parse on both SQLite (self-hosted) and Postgres (hosted). Column order
-- matches what the generator would emit from app/Models/Server.ts (id, then
-- attributes by `order`, then created_at/updated_at/uuid). status carries no
-- CHECK constraint on purpose -- the vocabulary (healthy/hot/quiet/unknown)
-- is enforced by the model, and a CHECK would force a table rebuild the day
-- it changes.
CREATE TABLE IF NOT EXISTS "servers" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "name" TEXT,
  "metrics_token" TEXT,
  "cpu_threshold" INTEGER default 90,
  "ram_threshold" INTEGER default 90,
  "disk_threshold" INTEGER default 85,
  "metrics_window_seconds" INTEGER default 300,
  "status" TEXT default 'unknown',
  "last_sample_at" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);

-- The token is the whole credential for the public ingest route and is
-- looked up on every push. monitors.metrics_token never had an index or a
-- uniqueness guarantee (0000000193), so `.first()` silently took an
-- arbitrary match; here a duplicate is a hard error.
CREATE UNIQUE INDEX IF NOT EXISTS "servers_metrics_token_unique" ON "servers" ("metrics_token");
CREATE UNIQUE INDEX IF NOT EXISTS "servers_uuid_unique" ON "servers" ("uuid");
CREATE INDEX IF NOT EXISTS "servers_team_id_index" ON "servers" ("team_id");
