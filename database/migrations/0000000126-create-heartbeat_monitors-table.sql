CREATE TABLE IF NOT EXISTS "heartbeat_monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "ping_token" TEXT,
  "expected_interval_seconds" INTEGER default 3600,
  "grace_seconds" INTEGER default 300,
  "last_ping_at" TEXT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
