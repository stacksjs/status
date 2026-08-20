CREATE TABLE IF NOT EXISTS "status_report_updates" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "message" TEXT,
  "status" TEXT default 'investigating',
  "posted_at" TEXT,
  "status_report_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
