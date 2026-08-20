CREATE TABLE IF NOT EXISTS "check_results" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "status" TEXT,
  "response_time_ms" INTEGER,
  "status_code" INTEGER,
  "message" TEXT,
  "metadata" TEXT,
  "region" TEXT default 'default',
  "checked_at" TEXT,
  "monitor_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
