CREATE TABLE IF NOT EXISTS "incident_updates" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER,
  "message" TEXT,
  "status" TEXT CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved')),
  "posted_at" TEXT,
  "incident_id" INTEGER REFERENCES "incidents"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
