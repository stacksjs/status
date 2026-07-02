CREATE TABLE IF NOT EXISTS "notification_channels" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "name" TEXT,
  "type" TEXT CHECK ("type" IN ('email', 'sms', 'slack', 'discord', 'teams', 'pagerduty', 'opsgenie', 'pushover', 'ntfy', 'webhook')),
  "config" TEXT,
  "enabled" INTEGER default 1,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
