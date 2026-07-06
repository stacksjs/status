CREATE TABLE IF NOT EXISTS "monitor_tag_assignments" (
  "id" BIGSERIAL PRIMARY KEY,
  "monitor_id" bigint,
  "monitor_tag_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
