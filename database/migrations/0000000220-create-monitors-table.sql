CREATE TABLE IF NOT EXISTS "monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "name" TEXT,
  "url" TEXT,
  "type" TEXT,
  "enabled" INTEGER default 1,
  "check_interval_seconds" INTEGER default 60,
  "config" TEXT,
  "status" TEXT default 'unknown',
  "last_checked_at" TEXT,
  "consecutive_failures" INTEGER default 0,
  "reports_metrics" INTEGER default 0,
  "metrics_token" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
