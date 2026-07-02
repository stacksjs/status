CREATE TABLE IF NOT EXISTS "ai_checks" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "prompt" TEXT,
  "last_result" TEXT,
  "last_passed" INTEGER,
  "last_checked_at" TEXT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
