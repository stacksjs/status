CREATE TABLE IF NOT EXISTS "lighthouse_reports" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "performance_score" INTEGER,
  "accessibility_score" INTEGER,
  "seo_score" INTEGER,
  "best_practices_score" INTEGER,
  "report_json" TEXT,
  "checked_at" TEXT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
