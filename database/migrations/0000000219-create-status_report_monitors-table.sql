CREATE TABLE IF NOT EXISTS "status_report_monitors" (
  "id" BIGSERIAL PRIMARY KEY,
  "status_report_id" bigint,
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
