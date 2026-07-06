CREATE TABLE IF NOT EXISTS "dns_snapshots" (
  "id" BIGSERIAL PRIMARY KEY,
  "record_type" record_type_type,
  "record_values" varchar(255),
  "checked_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
