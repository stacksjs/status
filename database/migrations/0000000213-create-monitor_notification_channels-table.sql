CREATE TABLE IF NOT EXISTS "monitor_notification_channels" (
  "id" BIGSERIAL PRIMARY KEY,
  "monitor_id" bigint,
  "notification_channel_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
