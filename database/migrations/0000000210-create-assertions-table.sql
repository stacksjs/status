CREATE TABLE IF NOT EXISTS "assertions" (
  "id" BIGSERIAL PRIMARY KEY,
  "target" target_type,
  "property" varchar(255),
  "compare" compare_type,
  "expected" text,
  "sort_order" integer default 0,
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
