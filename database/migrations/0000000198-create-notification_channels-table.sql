CREATE TABLE IF NOT EXISTS "notification_channels" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "name" TEXT,
  "type" TEXT,
  "config" TEXT,
  "enabled" INTEGER default 1,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
