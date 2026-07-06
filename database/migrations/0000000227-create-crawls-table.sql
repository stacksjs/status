CREATE TABLE IF NOT EXISTS "crawls" (
  "id" BIGSERIAL PRIMARY KEY,
  "started_at" varchar(255),
  "finished_at" varchar(255),
  "pages_crawled" integer default 0,
  "broken_links_count" integer default 0,
  "mixed_content_count" integer default 0,
  "status" status_type default 'running',
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
