CREATE TABLE IF NOT EXISTS "monitors" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "name" varchar(255),
  "url" text,
  "type" type_type,
  "enabled" boolean default true,
  "check_interval_seconds" integer default 60,
  "config" varchar(255),
  "status" status_type default 'unknown',
  "last_checked_at" varchar(255),
  "consecutive_failures" integer default 0,
  "reports_metrics" boolean default false,
  "metrics_token" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
