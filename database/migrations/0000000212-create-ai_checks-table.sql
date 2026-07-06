CREATE TABLE IF NOT EXISTS "ai_checks" (
  "id" BIGSERIAL PRIMARY KEY,
  "prompt" text,
  "last_result" text,
  "last_passed" boolean,
  "last_checked_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
