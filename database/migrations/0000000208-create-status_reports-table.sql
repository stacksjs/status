CREATE TABLE IF NOT EXISTS "status_reports" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "title" varchar(255),
  "body" text,
  "status" status_type default 'investigating',
  "started_at" varchar(255),
  "resolved_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
