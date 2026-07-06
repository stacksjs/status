CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "url" text,
  "secret" varchar(255),
  "enabled" boolean default true,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
