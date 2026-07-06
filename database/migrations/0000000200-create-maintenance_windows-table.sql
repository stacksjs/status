CREATE TABLE IF NOT EXISTS "maintenance_windows" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "title" varchar(255),
  "description" text,
  "starts_at" varchar(255),
  "ends_at" varchar(255),
  "status" status_type default 'scheduled',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
