CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "url" TEXT,
  "secret" TEXT,
  "enabled" INTEGER default 1,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
