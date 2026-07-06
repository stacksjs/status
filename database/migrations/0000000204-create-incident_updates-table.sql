CREATE TABLE IF NOT EXISTS "incident_updates" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" integer,
  "message" text,
  "status" status_type,
  "posted_at" varchar(255),
  "incident_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
