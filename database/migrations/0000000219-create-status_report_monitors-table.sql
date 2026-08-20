CREATE TABLE IF NOT EXISTS "status_report_monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "status_report_id" INTEGER,
  "monitor_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
