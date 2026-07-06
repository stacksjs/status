CREATE TABLE IF NOT EXISTS "status_page_component_groups" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255),
  "display_order" integer default 0,
  "status_page_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
