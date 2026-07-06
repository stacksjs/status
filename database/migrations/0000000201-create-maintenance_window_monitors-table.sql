CREATE TABLE IF NOT EXISTS "maintenance_window_monitors" (
  "id" BIGSERIAL PRIMARY KEY,
  "maintenance_window_id" bigint,
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
