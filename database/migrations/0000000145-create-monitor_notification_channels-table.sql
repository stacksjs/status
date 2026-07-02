CREATE TABLE IF NOT EXISTS "monitor_notification_channels" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "notification_channel_id" INTEGER REFERENCES "notification_channels"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
