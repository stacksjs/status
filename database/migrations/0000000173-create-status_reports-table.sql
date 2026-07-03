CREATE TABLE IF NOT EXISTS "status_reports" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "title" TEXT,
  "body" TEXT,
  "status" TEXT CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved')) default 'investigating',
  "started_at" TEXT,
  "resolved_at" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
