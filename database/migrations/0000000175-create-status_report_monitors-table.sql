CREATE TABLE IF NOT EXISTS "status_report_monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "status_report_id" INTEGER REFERENCES "status_reports"("id"),
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
