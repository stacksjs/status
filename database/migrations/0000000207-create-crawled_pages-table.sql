CREATE TABLE IF NOT EXISTS "crawled_pages" (
  "id" BIGSERIAL PRIMARY KEY,
  "url" text,
  "status_code" integer,
  "found_on_url" text,
  "is_mixed_content" boolean default false,
  "is_broken_link" boolean default false,
  "crawl_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
