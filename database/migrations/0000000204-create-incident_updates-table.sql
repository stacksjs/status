CREATE TABLE IF NOT EXISTS "incident_updates" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER,
  "message" TEXT,
  "status" TEXT,
  "posted_at" TEXT,
  "incident_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
