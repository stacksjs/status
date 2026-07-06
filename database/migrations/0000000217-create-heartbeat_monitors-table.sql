CREATE TABLE IF NOT EXISTS "heartbeat_monitors" (
  "id" BIGSERIAL PRIMARY KEY,
  "ping_token" varchar(255),
  "expected_interval_seconds" integer default 3600,
  "grace_seconds" integer default 300,
  "last_ping_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
