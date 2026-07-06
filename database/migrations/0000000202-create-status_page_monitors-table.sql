CREATE TABLE IF NOT EXISTS "status_page_monitors" (
  "id" BIGSERIAL PRIMARY KEY,
  "display_name" varchar(255),
  "display_order" integer default 0,
  "status_page_id" bigint,
  "monitor_id" bigint,
  "status_page_component_group_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
