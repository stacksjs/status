CREATE TABLE IF NOT EXISTS "status_report_updates" (
  "id" BIGSERIAL PRIMARY KEY,
  "message" text,
  "status" status_type default 'investigating',
  "posted_at" varchar(255),
  "status_report_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
