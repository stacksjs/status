CREATE TABLE IF NOT EXISTS "check_results" (
  "id" BIGSERIAL PRIMARY KEY,
  "status" status_type,
  "response_time_ms" integer,
  "status_code" integer,
  "message" text,
  "metadata" varchar(255),
  "region" varchar(255) default 'default',
  "checked_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
