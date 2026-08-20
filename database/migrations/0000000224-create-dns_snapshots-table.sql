CREATE TABLE IF NOT EXISTS "dns_snapshots" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "record_type" TEXT,
  "record_values" TEXT,
  "checked_at" TEXT,
  "monitor_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
