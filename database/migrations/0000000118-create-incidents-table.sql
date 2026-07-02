CREATE TABLE IF NOT EXISTS "incidents" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "started_at" TEXT,
  "resolved_at" TEXT,
  "cause" TEXT,
  "status" TEXT CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved')) default 'investigating',
  "impacted_checks" TEXT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
