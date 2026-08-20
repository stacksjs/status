CREATE TABLE IF NOT EXISTS "assertions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "target" TEXT,
  "property" TEXT,
  "compare" TEXT,
  "expected" TEXT,
  "sort_order" INTEGER default 0,
  "monitor_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
