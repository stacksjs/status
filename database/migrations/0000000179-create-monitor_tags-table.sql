CREATE TABLE IF NOT EXISTS "monitor_tags" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "name" TEXT,
  "color" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
