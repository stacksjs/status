CREATE TABLE IF NOT EXISTS "monitor_notification_channels" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "monitor_id" INTEGER,
  "notification_channel_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
