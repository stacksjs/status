CREATE TABLE IF NOT EXISTS "crawled_pages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "url" TEXT,
  "status_code" INTEGER,
  "found_on_url" TEXT,
  "is_mixed_content" INTEGER default 0,
  "is_broken_link" INTEGER default 0,
  "crawl_id" INTEGER REFERENCES "crawls"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
