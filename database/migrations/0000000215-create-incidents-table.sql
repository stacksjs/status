CREATE TABLE IF NOT EXISTS "incidents" (
  "id" BIGSERIAL PRIMARY KEY,
  "started_at" varchar(255),
  "resolved_at" varchar(255),
  "cause" text,
  "status" status_type default 'investigating',
  "impacted_checks" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
