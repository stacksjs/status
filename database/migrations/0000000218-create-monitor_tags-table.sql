CREATE TABLE IF NOT EXISTS "monitor_tags" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "name" varchar(255),
  "color" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
