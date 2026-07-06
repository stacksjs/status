CREATE TABLE IF NOT EXISTS "notification_channels" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "name" varchar(255),
  "type" type_type,
  "config" varchar(255),
  "enabled" boolean default true,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
