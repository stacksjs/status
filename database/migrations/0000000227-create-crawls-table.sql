CREATE TABLE IF NOT EXISTS "crawls" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "started_at" TEXT,
  "finished_at" TEXT,
  "pages_crawled" INTEGER default 0,
  "broken_links_count" INTEGER default 0,
  "mixed_content_count" INTEGER default 0,
  "status" TEXT default 'running',
  "monitor_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
